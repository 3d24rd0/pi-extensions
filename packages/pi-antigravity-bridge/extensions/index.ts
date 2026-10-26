// pi-antigravity-bridge - extension entry point.
//
// Registers Gemini (via the agy CLI) as a pi model provider so it shows up in
// the /model picker as antigravity/gemini-*. When selected, pi routes each turn
// through streamSimple, which feeds the persistent stream-json driver process
// and streams the agent text back into pi's TUI.
//
// Architectural wall (cannot be worked around - see PLAN.md):
//   agy runs its OWN closed tool loop against --add-dir. pi's read/write/edit/
//   bash tools never fire. Tool activity is surfaced as thinking events
//   ("[agy tool: editing foo.ts]") for visibility, but the edits already landed
//   on disk and pi's inline diff review does not engage.
//
// /agy command: full runtime config surface (engine, mode, permissions,
// bridge tools, model, thinking, digest, system prompt, acp binary) plus
// doctor, auth, patch-cleanup, and session clear. Config persists to
// ~/.pi/agent/antigravity-bridge/config.json so toggles survive restarts.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, DialogMenu, type DialogRow } from "@estebanforge/pi-tui-dialogs";
import {
	entriesFromRaw,
	expandAgyModels,
	FALLBACK_MODELS,
	isAcpCapableModel,
	loadModelCatalogRaw,
	parseModelEngine,
	toPiModel,
	type AgyModelEntry,
} from "../src/models.js";
import { acpLoginPending, registerAgyCommand } from "../src/commands.js";
import { SessionStore } from "../src/sessions.js";
import {
	APPROVAL_PARK_MS,
	POLL_TOOL_NAME,
	ToolRoundTrips,
	WrapperReplay,
	createStreamSimple,
	defaultEscalateAfterMs,
	formatEscalatedAck,
	formatPollAnswer,
	type NativeDisplayEvent,
} from "../src/provider.js";
import { PollRunFolder, type PollRunData } from "../src/poll-fold.js";
import {
	createShadowTool,
	stripMarkerFields,
	type AnyToolDefinition,
	type GatePolicy,
} from "../src/approval-gate.js";
import { detectPermissionGateExtensions, resolveGateMode } from "../src/approval-detect.js";
import { hookScriptSource, removeGateHooks, stageGateHooks, sweepWorkspaceGateGroups } from "../src/approval-hook.js";
import { StreamDriver } from "../src/driver.js";
import { AcpDriver } from "../src/acp/driver.js";
import { runAcpAuth } from "../src/acp/auth.js";
import { setAuthInvalidatedHook } from "../src/acp/connection.js";
import { setupAuthUrlCapture } from "../src/acp/browser-capture.js";
import { clearAcpAuthVerified, ensureAcpReady, inspectAcpSetup } from "../src/acp/setup.js";
import type { TurnDriver, TurnOutcome } from "../src/driver-types.js";
import { CONFIG_PATH, loadConfig, logsDir, MAX_TURN_CAP_MIN, parseCapMinutes, saveConfig, type AgyMode, type BridgeTools, type Engine, type ThinkingTier } from "../src/config.js";
import { agyMissingMessage, isAgyInstalled } from "../src/engine-picker.js";
import { checkAgyCliVersion, describeAgyVersionCheck, MIN_AGY_VERSION } from "../src/agy-version.js";
import { isValidAgyAgentName, listAgyAgents } from "../src/agents.js";
import { formatSubagentRoster, SubagentRoster } from "../src/subagent-roster.js";
import { spawn } from "node:child_process";
import { fetchAgyQuota, formatAgyQuotaReport } from "../src/usage.js";
import { artifactOpenCommand, listAgyArtifacts } from "../src/artifacts.js";
import { showArtifactsBrowser } from "../src/artifacts-ui.js";
import { listAgyTasks, tailAgyTaskLog } from "../src/tasks.js";
import { showTasksBrowser } from "../src/tasks-ui.js";
import { agyConversationDir } from "../src/agy-paths.js";
import { createDailyLogger, type DailyLogger } from "../src/daily-log.js";
import { registerAskAntigravityTool, toolModelsFromRaw } from "../src/ask-tool.js";
import { registerWebTools } from "../src/web-tools.js";
import { bridgeMcpConfigDir, startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import {
	registerBridgeServer,
	healBridgeSuppression,
	sweepStaleBridgeServers,
	unregisterBridgeServer,
} from "../src/mcp-registration.js";
import {
	ACTIVATE_SKILL_TOOL_NAME,
	activateSkillSchema,
	catalogSummary,
	findSkillByName,
	readSkillBody,
	scanSkills,
	type SkillLite,
} from "../src/skills.js";
import { mapAgyToolToNative } from "../src/native-tools.js";
import { bridgedPiTools } from "../src/bridge-catalog.js";
import { Type } from "typebox";
import { patchStatus, restorePatch } from "../src/patch-cleanup.js";
import { withDialogLock } from "../src/dialog-lock.js";

// The server disowning our verified marker (-32000 anywhere: turn, session
// new/load, cancel) must drop it, or ensureAcpReady keeps reporting a login
// that no longer exists. Wire once at load; the hook is a no-op until set.
setAuthInvalidatedHook(() => clearAcpAuthVerified());

// Last UI seen (session_start / /agy commands). The ACP login URL arrives
// via the driver log sink, which has no command context; the stash lets that
// sink toast instead of only logging to stderr. Module scope: both the
// default export (session_start, log sink) and registerAgyCommand assign it.
let activeUi: ExtensionUIContext | null = null;

function resolveAgyBinary(): string {
	return process.env.AGY_BIN || "agy";
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// Claim the AskAntigravity tool for this process. pi-ask-antigravity (if also
	// installed) checks this in-process flag OR the bridge's package.json on disk
	// and defers. See that extension's isBridgeInstalled().
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-antigravity-bridge:active")] = true;

	const binary = resolveAgyBinary();

	// Discover once at load. Failure is non-fatal: FALLBACK_MODELS keeps the
	// picker populated so the user gets a clear runtime error from agy rather
	// than an empty model list. /reload re-runs this and refreshes after an
	// `agy update`.
	// loadModelCatalogRaw serves a short-TTL cache (~/.pi/agent/antigravity-bridge/
	// models-cache.json) so reloads are instant and only re-spawn in the
	// background when stale. Derive both catalogs from the same raw text
	// (provider's slugified Gemini entries + the tool's family/version/tier
	// entries).
	const raw = await loadModelCatalogRaw(binary);
	const discovered = entriesFromRaw(raw);
	const toolModels = toolModelsFromRaw(raw);
	const usingFallback = discovered.length === 0;
	const entries: AgyModelEntry[] = usingFallback ? FALLBACK_MODELS : discovered;
	// Engine latched at load: /agy engine takes effect on the next pi start
	// (documented). Everything below resolves from THIS value - per-call
	// config reads would let a mid-session flip leave ToolRoundTrips,
	// kickIdle, and reentry pointing at the other engine (round-7 finding).
	const engine: Engine = loadConfig().engine;
	// Register models with explicit engine variants:
	// - ACP-capable models (Gemini) appear as both -acp and -cli variants
	// - Non-ACP models (Claude, GPT) appear as -cli variants
	const models = expandAgyModels(entries);

	// failAll reasons the bridge treats as routine (turn end / shutdown
	// sweep), not faults. Shared by the emitters below and the mcpLog
	// classifier so the substring match cannot drift from the text.
	const FAIL_REASON_TURN_END = "antigravity turn ended with an unresolved pi tool call";
	const FAIL_REASON_SHUTDOWN = "antigravity session shut down";

	// Daily file log: every sink below feeds ~/.pi/agent/
	// antigravity-bridge/logs/<YYYY-MM-DD>.ndjson (see
	// src/daily-log.ts). Fire-and-forget, secrets redacted, old days pruned.
	// Support flow: "attach the last days' files from that dir".
	const fileLog = createDailyLogger({ dir: logsDir() });
	// Warn tier = user-facing: the default file log keeps ONLY errors (zero
	// routine disk traffic), so a warn that never reaches the UI is lost.
	// Every warn toasts here instead; AGY_DEBUG=1 restores the full file
	// trail. Silent exceptions: deliberate aborts (pi already shows
	// "Operation aborted") and connection exits (the turn's own error block
	// carries real crashes). call-tool-fail needs no exclusion here: its tier
	// is debug or error, never warn. No UI (headless): warn text falls back
	// to stderr.
	const rawFileLog = fileLog.log.bind(fileLog);
	fileLog.log = (event, data, level) => {
		rawFileLog(event, data, level);
		if (level !== "warn") return;
		if (event.startsWith("abort:") || event === "connection-exited" || event === "turn-end") return;
		const d = (data ?? {}) as Record<string, unknown>;
		let text: string;
		if (event === "round-trip-fail") {
			text = `Bridge tool call failed: ${String(d.name ?? "tool")} (${String(d.reason ?? "unknown")})`;
		} else if (event.startsWith("stall:")) {
			text = "Antigravity stalled with no output; the turn was stopped";
		} else if (event.startsWith("timeout:")) {
			text = "Antigravity turn timed out";
		} else if (event.startsWith("exit:") && event !== "exit:0") {
			text = "Antigravity process exited unexpectedly";
		} else if (event === "turn-error") {
			text = `Antigravity turn issue: ${String(d.reason ?? "unknown")}`;
		} else {
			text = `Antigravity warning: ${event}`;
		}
		if (activeUi) activeUi.notify(text, "warning");
		else console.error(`[antigravity-bridge] ${text}`);
	};
	fileLog.log(
		"extension-load",
		{ engine, models: models.length, fallback: usingFallback, bridge: loadConfig().bridgeTools, askTool: loadConfig().askTool, webTools: loadConfig().webTools },
		"info",
	);

	const store = new SessionStore();
	// MCP bridge handle, declared early: the ACP engine reads the bridge port
	// at session/new / session/load time.
	let mcpHandle: McpServerHandle | null = null;
	// Session-only visibility overrides; never change either application's MCP config.
	const hiddenBridgeTools = new Set<string>();
	const getBridgeTools = () => bridgedPiTools(pi.getAllTools(), pi.getActiveTools(), loadConfig().bridgeTools, hiddenBridgeTools);
	// Approval-gate hook script (per-pid, token embedded). Written at session
	// start when the gate is active; removed at session_shutdown.
	let gateScriptPath: string | null = null;
	// ACP self-heal runs once per process (session_start re-fires on /reload;
	// a ready setup is two file stats, so re-running is harmless anyway).
	let acpSelfHealRan = false;
	// Warn-once-per-process flags for the missing-agy-CLI toast and the
	// too-old-agy version gate (both stream-json).
	let agyMissingWarned = false;
	let agyVersionWarned = false;
	// OAuth URL capture: the server hands the login URL only to the
	// browser-open call (nothing on stdio), so a BROWSER wrapper records it
	// and the driver logs it as "auth-url". Local users keep the automatic
	// browser open; over SSH the URL surfaces for copy-paste with the
	// port-forward command.
	const authCapture = setupAuthUrlCapture();
	if (!authCapture && process.platform !== "win32") {
		// Rare (unwritable data dir). Surfacing the diagnostic: without it,
		// login URLs would silently stop appearing on headless boxes.
		console.error("[antigravity-bridge] OAuth URL capture unavailable; login URL surfacing is off (setup failed).");
	}
	// Two turn engines behind one contract (plan §9): the official ACP
	// server (default for new installs) and the stream-json `agy` CLI
	// (fallback). Neither spawns anything until its first turn.
	// ACP log routing: only genuine failures reach stderr. Routine lifecycle
	// (driver-created, spawn, session-new, ...) stays in the driver's
	// #lifecycle ring buffer, visible via /agy doctor. An unfiltered sink fired
	// console.error at extension load ("driver-created"), before any UI exists,
	// and leaked raw driver lines into the terminal on every startup.
	const acpFailures = new Set([
		"start-failed", "spawn-error", "parse-error", "write-failed",
		"mode-apply-failed", "timeout", "stall", "auth-required",
		"session-load-failed-creating-fresh", "connection-exited", "cancel-failed",
		"unsupported-server-request",
	]);
	const streamDriver = new StreamDriver();
	// Mirror the stream driver's lifecycle ring into the daily file log
	// (spawn/exit/abort/stall/recycle). The ACP driver reaches the same file
	// through acpLog below.
	streamDriver.log = (msg, data) => {
		// Level classification mirrors acpLog's failure set: stalls, aborts,
		// timeouts and nonzero exits are the "what broke" greps (warn);
		// turn-start is the per-turn skeleton (info); everything else is
		// verbose-only (debug, needs AGY_DEBUG).
		const failed =
			msg.startsWith("timeout:") ||
			msg.startsWith("stall:") ||
			msg.startsWith("abort:") ||
			(msg.startsWith("exit:") && msg !== "exit:0");
		const level = failed ? "warn" : msg === "turn-start" ? "info" : "debug";
		fileLog.log(msg, data, level);
	};
	// Shared ACP log sink (driver turns AND /agy auth): the login URL event
	// toasts so SSH users can copy it; genuine failures reach stderr.
	const acpLog = (msg: string, data?: unknown): void => {
		// The daily file log gets EVERY driver event (auth-url stripped of its
		// query string - it carries one-time login state); the filters below
		// only decide what reaches the user.
		const fileData =
			msg === "auth-url"
				? { port: (data as { port?: number | null } | undefined)?.port ?? null, url: String((data as { url?: string } | undefined)?.url ?? "").split("?")[0] }
				: data;
		// Failures warn; turn-start + auth-url are the always-on skeleton;
		// routine per-event lifecycle (spawn, session-load, unparked, ...) is
		// verbose-only. Deliberate teardown exits (Esc abort kill, shutdown,
		// idle recycle) demote to debug: routine, and the warn tier stays the
		// "what broke" grep.
		const expectedExit =
			msg === "connection-exited" &&
			(data as { expected?: boolean } | undefined)?.expected === true;
		const level = expectedExit
			? "debug"
			: acpFailures.has(msg)
				? "warn"
				: msg === "turn-start" || msg === "auth-url"
					? "info"
					: "debug";
		fileLog.log(msg, fileData, level);
		if (msg === "auth-url") {
			const { url, port } = (data ?? {}) as { url?: string; port?: number | null };
			if (!url) return;
			// Blank lines fence the URL off from the rest of the text: it is long
			// and wraps, so separation keeps it readable and copyable.
			const parts = ["Google sign-in URL for the ACP engine:", "", url];
			if (port) {
				parts.push(
					"",
					"SSH session? Forward the port on your machine first:",
					`  ssh -N -L ${port}:127.0.0.1:${port} <user@host>`,
				);
			}
			const text = parts.join("\n");
			if (activeUi) activeUi.notify(text, "warning");
			else console.error(`[antigravity-bridge acp] ${text}`);
			return;
		}
		if (!acpFailures.has(msg)) return;
		// Console noise is gone: warns toast through the fileLog wrapper (with
		// a stderr fallback when no UI exists), and raw tails stay in the file
		// log behind AGY_DEBUG.
	};
	const acpDriver = new AcpDriver({
		// Resolved per connection: the setup flow can install the binary and
		// update acp.bin mid-session; the next turn picks it up (no restart).
		bin: () => loadConfig().acp.bin,
		// Resolved per turn: /agy and AGY_USAGE_ESTIMATE changes apply without
		// a restart. Without this the driver defaults to "estimate" and the
		// config knob (incl. "off") is dead.
		usageEstimate: () => loadConfig().acp.usageEstimate,
		// ACP request_permission parity with the approval gate: skipPermissions
		// turns auto-allow in the driver; approvals.mode allow short-circuits
		// to the same synchronous allow; everything else opens a dialog (esc
		// and headless deny fail-closed) under the shared dialog lock.
		permissionPolicy: () => (loadConfig().approvals.mode === "allow" ? "auto" : "deny"),
		onPermissionRequest: async (req) => {
			const ui = activeUi;
			if (loadConfig().approvals.mode === "deny" || !ui) return undefined;
			return await withDialogLock(async () => {
				const labels = req.options.map((o) => o.name ?? o.kind ?? o.optionId ?? "?");
				const title = req.toolCall?.title ? `agy requests: ${req.toolCall.title}` : "agy requests permission";
				const picked = await ui.select(title, labels);
				if (picked === undefined) return undefined;
				const idx = labels.indexOf(picked);
				return idx >= 0 ? (req.options[idx]?.optionId ?? undefined) : undefined;
			});
		},
		...(authCapture ? { extraEnv: authCapture.browserEnv, authUrlFile: authCapture.file } : {}),
		log: acpLog,
		mcpServers: () => {
			const handle = mcpHandle;
			if (!handle) return [];
			// The bridge 403s any request without the shared-secret header; the
			// stream engine carries it via mcp_config.json, ACP via headers[].
			return [
				{
					name: "pi-bridge",
					type: "http",
					url: `http://127.0.0.1:${handle.port}/mcp`,
					headers: [{ name: TOKEN_HEADER, value: handle.token }],
				},
			];
		},
	});
	// The active engine driver is resolved dynamically: whichever driver currently has
	// an active turn handle owns tool round-trips (crucial when Claude turns run on
	// streamDriver while global engine is acp). Falls back to the latched engine driver.
	const activeDriver = (): TurnDriver =>
		streamDriver.activeHandle ? streamDriver : acpDriver.activeHandle ? acpDriver : engine === "acp" ? acpDriver : streamDriver;
	// The provider's stream-json slot gets the STREAM driver explicitly - never
	// activeDriver(), or a load-time acp engine would make deps.driver and
	// deps.acpDriver the same object and break the engine identity check.
	const driver = streamDriver;
	// The no-patch pi-tool round-trip store: the MCP bridge parks calls here;
	// the provider emits them as real pi toolUse turns and completes them from
	// the next call's toolResult.
	const roundTrips = new ToolRoundTrips(
		activeDriver,
		(s, d, level) =>
			fileLog.log(
				s,
				d,
				level ?? (s === "round-trip-fail" ? "warn" : "debug"),
			),
		// Delegation tools hold the sync window 120s (issue #6); config adds
		// extra long-running names, re-read per call so edits apply live.
		{ escalateAfterMs: (name) => defaultEscalateAfterMs(name, loadConfig().escalateLongTools) },
	);
	const replay = new WrapperReplay();
	// Subagent roster: folded from every driver activity (both engines) via
	// the provider; /agy subagents renders it. In-memory, process-lifetime.
	const roster = new SubagentRoster();
	// ACP tool activity is display-only: durable Pi entries with native-looking
	// titles and optional diffs. Registered unconditionally so ACP model turns can render.
	pi.registerEntryRenderer<NativeDisplayEvent>("agy-native-event", (entry, { expanded }, theme) => {
			const event = entry.data;
			// Collapsed detail: most-specific signal wins (path, command, agy's own
			// display text). The name is NOT a fallback here - it rendered "ls ls"
			// duplication whenever the event carried neither path nor command.
			const firstLine = (value: string | undefined): string | undefined => value?.split(/\r?\n/, 1)[0].trim() || undefined;
			const detail = event?.path ? path.basename(event.path) : firstLine(event?.command) ?? firstLine(event?.output);
			const status = event?.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const lines = [`${status} ${theme.fg("toolTitle", event?.name ?? "Antigravity")}${detail ? ` ${theme.fg("muted", detail.slice(0, 160))}` : ""}`];
			if (expanded) {
				if (event?.path) lines.push(theme.fg("dim", event.path));
				if (event?.diff) {
					for (const line of event.diff.split("\n")) {
						const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
						lines.push(theme.fg(color, line));
					}
				}
				if (event?.output && (!event.diff || event.status === "failed")) lines.push(theme.fg("toolOutput", event.output));
			}
			return new Text(lines.join("\n"), 0, 0);
		});
		// Collapsed poll runs: one ♊︎-marked counted line per consecutive poll
		// burst instead of one entry per poll.
		pi.registerEntryRenderer<PollRunData>("agy-poll-run", (entry, { expanded }, theme) => {
			const run = entry.data;
			const count = run?.count ?? 0;
			const label = `Poll ${run?.target ?? "bridge call"} (x${count}${run?.state === "failed" ? ", failed" : ""})`;
			const lines = [`♊︎ ${theme.fg("toolTitle", POLL_TOOL_NAME)} ${theme.fg("muted", label)}`];
			if (expanded && run) {
				const time = (iso: string): string => new Date(iso).toLocaleTimeString();
				lines.push(theme.fg("dim", `${count} ${count === 1 ? "poll" : "polls"}, ${time(run.firstAt)} → ${time(run.lastAt)}`));
			}
			return new Text(lines.join("\n"), 0, 0);
	});
	let pendingNativeTools = 0;
	const pollRuns = new PollRunFolder();
	const closePollRun = (): void => {
		const settled = pollRuns.flush();
		if (settled) pi.appendEntry<PollRunData>("agy-poll-run", settled);
		setDimStatus("agy-poll", undefined);
	};
	// Footer statuses render muted, matching pi-hostname's dim treatment.
	const setDimStatus = (key: string, text: string | undefined): void => {
		const ui = activeUi;
		if (!ui) return;
		ui.setStatus(key, text === undefined ? undefined : ui.theme.fg("dim", text));
	};
	const onNativeEvent = (event: NativeDisplayEvent): void => {
		// Polls are bridge-local (never get a genuine Pi card); the mcpServer
		// tag is unreliable on these frames, so the tool name discriminates.
		if (event.name === POLL_TOOL_NAME) {
			const view = event.callId ? roundTrips.poll(event.callId) : undefined;
			const switched = pollRuns.add(view?.name ?? "unknown call", view?.state ?? "running", new Date());
			if (switched) pi.appendEntry<PollRunData>("agy-poll-run", switched);
			const open = pollRuns.open;
			setDimStatus("agy-poll", open ? `♊︎ bridge_poll_result → ${open.target} (x${open.count})` : undefined);
			return;
		}
		closePollRun();
		if (event.mcpServer === "pi-bridge") return;
		// MCP calls through our own pi-bridge already have genuine Pi tool cards;
		// only native Antigravity / other MCP events need display-only entries.
		if (event.status === "started") {
			pendingNativeTools++;
			setDimStatus("agy-native", `agy ${event.name}… (${pendingNativeTools})`);
			return;
		}
		pendingNativeTools = Math.max(0, pendingNativeTools - 1);
		if (pendingNativeTools === 0) activeUi?.setStatus("agy-native", undefined);
		// Bound persisted session size; the ACP result and diff may be megabytes.
		pi.appendEntry<NativeDisplayEvent>("agy-native-event", {
			...event,
			output: event.output?.slice(0, 4000),
			diff: event.diff?.slice(0, 12000),
			command: event.command?.slice(0, 500),
		});
	};
	// Native re-exec only emits for builtins actually active in the session;
	// anything else (or an unknown name) falls back to the wrapper card.
	const nativeActive = (name: string): boolean => {
		try {
			return pi.getActiveTools().includes(name);
		} catch {
			return false;
		}
	};
	// A settled turn cannot answer its parked calls; the driver never sees
	// ToolRoundTrips, so the provider bridges the two here (both engines).
	// The file log records the outcome first: ERROR/aborted turns are the
	// single most useful support signal.
	const onTurnEnd = (outcome: TurnOutcome) => {
		fileLog.log(
			"turn-end",
			// Error text can embed the child's stderr tail; cap it in line with
			// the ACP driver's 200-char stderr slices.
			{ status: outcome.status, error: outcome.error?.slice(0, 500), aborted: outcome.aborted },
			outcome.status === "OK" ? "info" : "warn",
		);
		roundTrips.failAll(FAIL_REASON_TURN_END);
		// Closes a poll run that no display event flushed.
		closePollRun();
		// Stamp live escalations with the ended turn's conversation: the park
		// pass returns before the provider's store.set, so a first-turn park
		// has no other record of where its result must be re-delivered.
		if (outcome.conversationId) roundTrips.stampConversation(outcome.conversationId);
	};
	streamDriver.onTurnEnd = onTurnEnd;
	acpDriver.onTurnEnd = onTurnEnd;
	// Pi's normal footer receives the incremental usage above. Mark the
	// numbers as estimates in the status area too; ACP currently drops the
	// SDK's exact usage metadata before it reaches the client.
	{
		let lastUsageStatus = "";
		pi.on("message_update", (event, ctx) => {
			if (!ctx.hasUI || event.message.role !== "assistant" || event.message.provider !== "antigravity" || loadConfig().acp.usageEstimate === "off") return;
			const { input, output } = event.message.usage;
			const { forcedEngine } = parseModelEngine(event.message.model);
			const isAcp = forcedEngine === "acp" || (!forcedEngine && isAcpCapableModel(event.message.model));
			const label = isAcp ? "ACP ≈" : "agy ≈";
			const status = ctx.ui.theme.fg("dim", `${label} ${input} in / ${output} out`);
			if (status !== lastUsageStatus) {
				lastUsageStatus = status;
				ctx.ui.setStatus("agy-usage", status);
			}
		});
		const clearUsageStatus = (_event: unknown, ctx: { hasUI: boolean; ui: ExtensionUIContext }) => {
			lastUsageStatus = "";
			if (ctx.hasUI) ctx.ui.setStatus("agy-usage", undefined);
		};
		pi.on("agent_end", (event, ctx) => {
			clearUsageStatus(event, ctx);
			pendingNativeTools = 0;
			closePollRun();
			if (ctx.hasUI) ctx.ui.setStatus("agy-native", undefined);
		});
		pi.on("session_shutdown", (event, ctx) => {
			clearUsageStatus(event, ctx);
			pendingNativeTools = 0;
			if (ctx.hasUI) ctx.ui.setStatus("agy-native", undefined);
		});
	}
	const streamSimple = createStreamSimple({
		entries,
		store,
		driver,
		acpDriver,
		roundTrips,
		replay,
		nativeActive,
		onNativeEvent,
		roster,
		engine,
		log: fileLog.log.bind(fileLog),
	});

	pi.registerProvider("antigravity", {
		name: "Antigravity (agy)",
		baseUrl: "agy-bridge://antigravity",
		apiKey: "not-used",
		api: "agy-bridge",
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple,
	});

	registerAgyCommand(pi, {
		entries,
		store,
		usingFallback,
		driver,
		acpDriver,
		engine,
		getMcpPort: () => mcpHandle?.port ?? null,
		bridgeTools: getBridgeTools,
		hiddenBridgeTools,
		acpLog,
		fileLog,
		roster,
		authCapture: authCapture ?? null,
		runAcpPickSetup,
		setActiveUi: (ui) => {
			activeUi = ui;
		},
	});

	// AskAntigravity tool: one-shot delegation to agy (ported from
	// pi-ask-antigravity). When both extensions are installed, the bridge wins
	// and pi-ask-antigravity registers nothing (its load-time defer guard
	// detects this package via import.meta.resolve). Opt-out: askTool=false
	// (config file, AGY_ASK_TOOL, /agy ask, or the picker) skips registration
	// entirely - users who want only the provider keep a clean tool list.
	// Note: the active flag below is set regardless of askTool, so
	// pi-ask-antigravity keeps deferring even then: off means NO delegation
	// tool from either package, not a fallback to pi-ask-antigravity.
	if (loadConfig().askTool) await registerAskAntigravityTool(pi, toolModels, fileLog.log.bind(fileLog));
	// Web tools are opt-in (config.webTools, default off): Antigravity sessions
	// already have native web tools; these serve NON-Antigravity providers.
	if (loadConfig().webTools) registerWebTools(pi, { log: fileLog.log.bind(fileLog) });

	// Display-only wrapper tool: the provider emits mutating agy steps as
	// toolCalls against it (never re-executed - execute() replays the output
	// agy already recorded). Empty description on purpose: no model should
	// call it, it exists so pi renders proper toolCall/toolResult cards.
	pi.registerTool({
		name: "antigravity",
		label: "Antigravity",
		description: "",
		parameters: Type.Object({
			tool: Type.String({ description: "agy tool name that produced this step." }),
			key: Type.String({ description: "Internal replay key. Do not fabricate." }),
		}),
		execute: async (_toolCallId, params) => {
			const key = (params as { key?: string }).key ?? "";
			const output = replay.take(key) ?? `(no recorded output for ${key})`;
			return { content: [{ type: "text", text: output }], details: { replay: true } };
		},
	});

	/** ACP pick follow-through (first-run wizard): the same self-service
	 *  setup the /agy engine acp command runs, but immediately - the 1.5 GB
	 *  download starts while the toast is still on screen, progress rides the
	 *  footer status, and the Google sign-in opens when the install lands.
	 *  Restart still applies the engine (drivers wire at load); this only
	 *  removes the wait. Fire-and-forget: the caller already toasted the
	 *  promise, failures land in the daily log + a warning toast. */
	// eslint-disable-next-line @typescript-eslint/no-inner-declarations -- hoisted: registerAgyCommand below injects it
	async function runAcpPickSetup(ctx: { ui: ExtensionUIContext }): Promise<void> {
		acpSelfHealRan = true;
		let lastPhase = "";
		ctx.ui.setStatus("agy-acp", "downloading ACP server…");
		try {
			const status = await ensureAcpReady({
				configBin: loadConfig().acp.bin,
				onProgress: (m) => {
					// Dual surface: the status bar carries the live percent (cleared
					// on completion, zero footprint); the chat window gets phase
					// milestones only (download start, unpacking, installed) - same
					// line-in-chat feel as other extensions' notify() notices. The
					// percent variant updates every chunk and would spam the chat.
					ctx.ui.setStatus("agy-acp", m);
					if (m !== lastPhase && !/\d+%/.test(m)) {
						ctx.ui.notify(m, "info");
						lastPhase = m;
					}
				},
			});
			ctx.ui.setStatus("agy-acp", undefined);
			fileLog.log(
				"acp-setup",
				status.ok
					? { ok: true, binarySource: status.binarySource, needsLogin: status.needsLogin }
					: { ok: false, error: status.error },
				status.ok ? "info" : "warn",
			);
			if (!status.ok) {
				ctx.ui.notify(`ACP auto-setup failed (${status.error}).\n${status.manual}`, "warning");
				return;
			}
			// Spread, not a bare acp patch: a bare {bin} patch would drop
			// sibling keys (usageEstimate) from the file.
			saveConfig({ acp: { ...loadConfig().acp, bin: status.bin } });
			if (!status.needsLogin) {
				ctx.ui.notify(`ACP server ready (auth: ${status.auth}). Restart applies the engine.`, "info");
				return;
			}
			ctx.ui.notify(
				"ACP server ready. Signing in: the Google sign-in opens in your browser and completes when you finish it.",
				"info",
			);
			const r = await runAcpAuth({
				bin: status.bin,
				...(authCapture ? { extraEnv: authCapture.browserEnv, authUrlFile: authCapture.file } : {}),
				log: acpLog,
			});
			fileLog.log("acp-auth", r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? "info" : "warn");
			if (r.ok) {
				ctx.ui.notify(
					r.note ? `Signed in (${r.note}). The ACP engine is ready; restart applies it.` : "Signed in. The ACP engine is ready; restart applies it.",
					"info",
				);
			} else ctx.ui.notify(`ACP sign-in failed (${r.error}).\nRun /agy auth to retry; /agy auth-manual has manual steps.`, "warning");
		} catch (err) {
			ctx.ui.setStatus("agy-acp", undefined);
			fileLog.log("acp-setup", { error: String(err) }, "warn");
			ctx.ui.notify(`ACP setup failed (${String(err)}). /agy auth retries; /agy doctor inspects.`, "warning");
		}
	}

	// MCP tool bridge: expose pi's tools to agy over localhost Streamable HTTP.
	// Calls park in the provider's round-trip store and complete through pi's
	// normal toolUse loop (native cards, permissions, hooks) - no patch, no
	// privileged API. Started on session_start, torn down on session_shutdown.
	pi.on("session_start", async (event, ctx) => {
		if (ctx.hasUI) activeUi = ctx.ui;
		// agy presence check: warn if agy CLI binary is missing, since CLI variants require it.
		if (!agyMissingWarned && !isAgyInstalled(binary)) {
			agyMissingWarned = true;
			const msg = agyMissingMessage();
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.error(`[antigravity-bridge] ${msg}`);
		}
		// Version gate: an agy older than MIN_AGY_VERSION fails turns with raw stream errors.
		if (!agyVersionWarned && isAgyInstalled(binary)) {
			void checkAgyCliVersion(binary).then((check) => {
				if (agyVersionWarned || check.status !== "unsupported") return;
				agyVersionWarned = true;
				const msg = `agy ${check.version} is too old; install ${MIN_AGY_VERSION} or newer. Stream-json turns may fail in confusing ways until then (/agy doctor inspects).`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(`[antigravity-bridge] ${msg}`);
			});
		}
		// Legacy cleanup: users who ran the old consent-gated patcher still
		// carry pi.invokeTool in their installed pi. Inert, but tell them once
		// and offer /agy patch-cleanup. Never auto-edits the install.
		try {
			if (!loadConfig().patchCleanupNotified && patchStatus().present) {
				// Flag after surfacing, not before: headless sessions log to
				// stderr (ctx.ui.notify is a no-op without a UI), so the notice
				// is never silently dropped.
				const msg =
					"Your pi install still carries the old pi.invokeTool patch. It is unused and harmless; a pi update also removes it. To restore the original files from the backup now: /agy patch-cleanup";
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.error(`[antigravity-bridge] ${msg}`);
				saveConfig({ patchCleanupNotified: true });
			}
		} catch {
			/* detection is best-effort */
		}
		// ACP self-heal: checks ACP server binary + auth if available.
		if (!acpSelfHealRan) {
			acpSelfHealRan = true;
			void ensureAcpReady({ configBin: loadConfig().acp.bin }).then((status) => {
				fileLog.log(
					"acp-self-heal",
					status.ok
						? { ok: true, binarySource: status.binarySource, needsLogin: status.needsLogin }
						: { ok: false, error: status.error },
					status.ok ? "info" : "warn",
				);
				if (status.ok) {
					if (status.binarySource === "installed" || status.binarySource === "existing") {
						saveConfig({ acp: { ...loadConfig().acp, bin: status.bin } });
					}
					if (status.needsLogin) {
						const msg = acpLoginPending();
						if (ctx.hasUI) ctx.ui.notify(msg, "warning");
						else console.error(`[antigravity-bridge] ${msg}`);
					}
					return;
				}
				const msg = `ACP auto-setup failed (${status.error}).\n${status.manual}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(`[antigravity-bridge] ${msg}`);
			});
		}
		// Bridge failure logger. Routine lifecycle (listening,
		// bridge-config-written/removed, closed) is normal startup/teardown
		// traffic: toasting it every session, or pinning it via stderr in
		// headless mode, was noise. Only genuine failures surface - as a
		// warning toast (ctx.ui.notify, ephemeral) or stderr when headless.
		// Per-turn success events (list-tools / call-tool) stay silent.
		const mcpLog = (s: string, d?: unknown) => {
			const failures = new Set([
				"http-error", "bridge-config-write-failed", "call-tool-fail",
				"transport-error", "handleRequest-error", "request-error",
				"request-handler-error", "unauthorized",
			]);
			// Daily file log gets every bridge event (call-tool/list-tools
			// traffic included - it is how a parked round-trip is traced); the
			// filters below only decide what reaches the user. Bridge calls
			// start/end at info (one record per tool call, the fragile-path
			// skeleton); list-tools and startup chatter stay verbose.
			// Routine abort traffic (failAll on turn end / session shutdown
			// answers every parked call with an error) is not a fault: debug
			// only. Any other call-tool-fail is a real rejection (e.g. "no
			// active antigravity turn" from a client that should not see the
			// bridge) and lands at error tier - default mode records errors
			// only, so this is the sole durable trace of the incident.
			const detail = (d as { msg?: string } | undefined)?.msg ?? "";
			const routineAbort =
				s === "call-tool-fail" &&
				(detail.includes(FAIL_REASON_TURN_END) || detail.includes(FAIL_REASON_SHUTDOWN));
			const level = !failures.has(s)
				? s === "call-tool" || s === "call-tool-ok"
					? "info"
					: "debug"
				: routineAbort
					? "debug"
					: s === "call-tool-fail"
						? "error"
						: "warn";
			fileLog.log(s, d, level);
			if (routineAbort) return;
			if (!failures.has(s)) return;
			const msg = `[antigravity-bridge mcp] ${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.error(msg);
		};
		// Start the bridge unless the user turned it off. No patch gate, no
		// consent flow: calls route through pi's normal toolUse loop.
		const bridgeMode: BridgeTools = loadConfig().bridgeTools;
		if (bridgeMode === "none") return; // user opted out
		if (mcpHandle) return; // already running (reload re-fires session_start)
		// pi loads project skill locations only after the project is trusted;
		// mirror that gate. Global skill dirs are always scanned.
		const skills: SkillLite[] = scanSkills(ctx.isProjectTrusted() ? process.cwd() : undefined);
		const listTools = () => {
			// /mcp and pi.setActiveTools() update the same live catalog. ACP gets
			// this endpoint through session/new or session/load; no global config write.
			const tools = getBridgeTools().map((t) => {
					let inputSchema: object = { type: "object", properties: {}, additionalProperties: true };
					try {
						if (t.parameters) inputSchema = JSON.parse(JSON.stringify(t.parameters)) as object;
					} catch {
						/* keep default schema */
					}
					return { name: t.name, description: t.description ?? t.name, inputSchema };
				});
			if (skills.length > 0 && loadConfig().bridgeTools !== "none") {
				tools.push({
					name: ACTIVATE_SKILL_TOOL_NAME,
					description: `Activate a pi Agent Skill by name. Available: ${catalogSummary(skills)}`,
					inputSchema: activateSkillSchema(skills) as object,
				});
			}
			// Bridge-local, like activate_skill: answered from the escalation
			// registry without a pi round-trip. Pairs with the STILL RUNNING
			// early-ack that keeps slow calls under agy's ~180s request deadline.
			tools.push({
				name: POLL_TOOL_NAME,
				description:
					"Fetch the result of a long-running bridge tool call that answered STILL RUNNING with a callId. Poll again if it still reports running; the result or an error arrives here.",
				inputSchema: {
					type: "object",
					properties: { callId: { type: "string", description: "callId from the STILL RUNNING answer" } },
					required: ["callId"],
				},
			});
			return tools;
		};
		// activate_skill never round-trips through pi: the bridge answers it
		// directly by reading the SKILL.md (pi has no skill tool to execute).
		const bridgeOnToolCall = (
			callId: string,
			name: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
		) => {
			// Bridge-local, like activate_skill: answered from the escalation
			// registry, never parked into pi.
			if (name === POLL_TOOL_NAME) {
				const wanted = typeof args.callId === "string" ? args.callId : "";
				mcpLog("poll-tool", { callId: wanted });
				const view = roundTrips.poll(wanted);
				// A terminal answer means the model RECEIVED the result; mark it
				// so the redelivery path never double-delivers. poll() itself
				// stays pure (internal peeks must not mark). Accepted gap: the
				// mark fires when the poll ANSWERS, not when the HTTP response
				// lands; a drop inside that one-write window would mark a result
				// the model never saw.
				if (view && view.state !== "running") roundTrips.markDelivered(wanted);
				return Promise.resolve(formatPollAnswer(wanted, view));
			}
			if (name !== ACTIVATE_SKILL_TOOL_NAME) {
				// A cached MCP catalog is not authorization. An inactive/hidden tool
				// must not get parked into Pi, even if agy retained its old schema.
				if (!getBridgeTools().some((tool) => tool.name === name)) {
					return Promise.resolve({ content: [{ type: "text", text: `Pi tool ${name} is not active or not exposed to Antigravity` }], isError: true });
				}
				return roundTrips.onToolCall(callId, name, args, signal).then((r) => {
					// Early-ack: answer the HTTP request before agy's ~180s client
					// deadline with a poll handle; pi keeps executing meanwhile.
					if (!("escalated" in r)) return r;
					mcpLog("call-tool-escalated", { name, callId: r.callId });
					return formatEscalatedAck(r);
				});
			}
			const wanted = typeof args.name === "string" ? args.name : "";
			const skill = loadConfig().bridgeTools !== "none" ? findSkillByName(skills, wanted) : undefined;
			const body = skill ? readSkillBody(skill) : `unknown skill: ${wanted || "(none given)"}`;
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: skill ? `${body}\n\n[skill resources dir: ${skill.dir}]` : `Error: ${body}`,
					},
				],
				isError: !skill,
			});
		};
		const r = await startMcpServer(
			{
				listTools,
				onToolCall: bridgeOnToolCall,
				onApproval: (ticket, payload) => roundTrips.onApproval(ticket, payload),
			},
			{ log: mcpLog },
		);
		if (r.ok && r.handle) {
			mcpHandle = r.handle;
			// Stale entries swept at start; entries a crashed delegation left
			// suppressed are healed here - but only when no live delegation is in
			// flight anywhere (marker-aware heal). A blind re-enable used to
			// un-hide the bridge during another session's active delegation.
			// Global-config hygiene runs on BOTH engines: a crashed stream-json
			// session must not leave dead-pid entries or stuck suppression flags
			// for the next one.
			sweepStaleBridgeServers();
			healBridgeSuppression();
			// ACP supplies the bridge per-session (session/new | session/load);
			// stream-json CLI reads the global MCP config. Since models can run on CLI
			// even when default engine is ACP, we always register the bridge server.
			registerBridgeServer({
				pid: process.pid,
				port: r.handle.port,
				token: r.handle.token,
				tokenHeader: TOKEN_HEADER,
			});
			// --- Approval gate (docs/TODO.md 2.5) ------------------------------
			// agy native tool calls pass through a pi-side approval: a PreToolUse
			// hook parks in the bridge, the provider emits a shadow toolUse, and
			// pi's permission extensions gate it like any native call. Off until
			// enabled (auto = on only when a third-party gate extension exists).
			{
				const cfg = loadConfig();
				const mode = resolveGateMode(cfg.approvals.gateMode, detectPermissionGateExtensions());
				if (mode === "dedicated") {
					// The explicit antigravity_approve variant is planned; until it
					// ships, dedicated stages the same shadow tools. Say so, so the
					// config value never lies silently.
					fileLog.log("approval-dedicated-as-shadow", {}, "warn");
				}
				// Legacy cleanup (issue #5): 1.6.x staged the gate into the shared
				// workspace hooks.json, where standalone IDE/CLI sessions load it.
				// Staging now lives in the session-private add-dir; sweep groups left
				// behind by dead sessions from the old scheme. Live sessions' and
				// foreign groups are never touched.
				const sweptLegacy = sweepWorkspaceGateGroups(process.cwd());
				if (sweptLegacy > 0) fileLog.log("approval-workspace-swept", { swept: sweptLegacy }, "info");
				if (mode === "off") {
					// Gate off: drop this session's private hooks file. Other sessions
					// own their own per-pid files; nothing shared to preserve.
					const unstaged = removeGateHooks();
					if (unstaged.wrote) fileLog.log("approval-unstaged", unstaged, "info");
				} else {
					// Script: per-pid file; 0600 because the bridge token is
					// embedded (peer review 2026-09-07).
					const scriptPath = path.join(logsDir(), `approval-hook-${process.pid}.js`);
					fs.mkdirSync(path.dirname(scriptPath), { recursive: true, mode: 0o700 });
					fs.writeFileSync(
						scriptPath,
						hookScriptSource({
							port: r.handle.port,
							token: r.handle.token,
							deadlineMs: APPROVAL_PARK_MS,
						}),
						{ mode: 0o600 },
					);
					gateScriptPath = scriptPath;
					// Private per-pid staging (issue #5 isolation): the gate group goes
					// into the bridge add-dir that ONLY this session's agy receives.
					// Standalone sessions in the workspace never load it.
					const staged = stageGateHooks(bridgeMcpConfigDir(), {
						port: r.handle.port,
						token: r.handle.token,
						scriptPath,
						parkBudgetMs: APPROVAL_PARK_MS,
					});
					fileLog.log("approval-staged", { mode, script: scriptPath, ...staged }, staged.wrote ? "info" : "debug");

					// Shadow bases: factory twins of pi's own builtins (public API).
					// pi.getAllTools() is unusable here: it returns ToolInfo, which
					// strips execute. Marker calls never execute; non-marker calls
					// delegate to the twins, so behavior matches the standard
					// builtins (session-level bash-operations overrides are not
					// inherited; documented in README).
					const gateCwd = process.cwd();
					const bases: Record<string, AnyToolDefinition> = {
						bash: createBashToolDefinition(gateCwd) as unknown as AnyToolDefinition,
						write: createWriteToolDefinition(gateCwd) as unknown as AnyToolDefinition,
						edit: createEditToolDefinition(gateCwd) as unknown as AnyToolDefinition,
					};
					const askMode = cfg.approvals.mode;
					const policy: GatePolicy = async ({ tool, params, ctx }) => {
						if (askMode === "allow") return { allow: true };
						if (askMode === "deny") {
							return { allow: false, reason: `blocked by approval gate (mode: deny): ${tool}` };
						}
						const extCtx = ctx as { hasUI?: boolean; ui?: Pick<ExtensionUIContext, "confirm"> } | undefined;
						if (!extCtx?.hasUI || typeof extCtx.ui?.confirm !== "function") {
							return { allow: false, reason: `approval gate: no UI to approve ${tool} (headless)` };
						}
						const what =
							typeof params.command === "string"
								? params.command
								: typeof params.path === "string"
									? params.path
									: JSON.stringify(stripMarkerFields(params)).slice(0, 200);
						// Dialog lock: parallel agy tool approvals queue up instead of
						// clobbering the live dialog (which silently loses the approval).
						// Capture the narrowed method: TS drops the guard's narrowing
						// inside the deferred closure.
						const uiConfirm = extCtx.ui.confirm.bind(extCtx.ui);
						const ok = await withDialogLock(() =>
							uiConfirm(`agy ${tool}?`, what, { timeout: APPROVAL_PARK_MS }),
						);
						return ok ? { allow: true } : { allow: false, reason: `declined in pi (agy ${tool})` };
					};
					const handle = r.handle;
					for (const [name, base] of Object.entries(bases)) {
						pi.registerTool(
							createShadowTool(base, policy, { verifyTicket: (t) => handle.approvals.has(t) }),
						);
					}
					// The park is wired ONLY after the shadows are registered: an
					// approval toolUse must never dispatch to the REAL builtin and
					// execute locally.
					roundTrips.approvalPark = handle.approvals;
				}
			}
		} else {
			console.error(`[antigravity-bridge] MCP tool bridge disabled: ${r.reason}`);
		}
	});
	pi.on("session_shutdown", async () => {
		// The UI is going away; a later auth-url must fall back to stderr
		// instead of toasting into a dead UI (where it would be lost).
		activeUi = null;
		const h = mcpHandle;
		mcpHandle = null;
		await h?.close();
		roundTrips.failAll(FAIL_REASON_SHUTDOWN);
		// "recycle", NOT "shutdown": pi fires session_shutdown on /new, /resume
		// and /fork (docs/extensions.md session lifecycle), not only on process
		// exit. The drivers are process-lifetime singletons; closing them with
		// "shutdown" latched them permanently and every later turn failed with
		// "ACP driver is shut down." (regression 2026-09-07). Recycle kills the
		// connection now; the next turn respawns it. event.reason is
		// deliberately ignored: recycle is correct even on real process exit
		// ("quit") - the connection kill is identical and nothing runs after.
		await streamDriver.close("recycle", "session shutdown");
		await acpDriver.close("recycle", "session shutdown");
		unregisterBridgeServer(process.pid);
		hiddenBridgeTools.clear();
		// Approval gate: unstage hooks and remove the per-pid script. Pending
		// approvals already failed closed via handle close (bridge shutdown deny).
		const unstaged = removeGateHooks();
		if (unstaged.wrote) fileLog.log("approval-unstaged", unstaged, "info");
		if (gateScriptPath) {
			try {
				fs.rmSync(gateScriptPath, { force: true });
			} catch {
				/* best effort */
			}
			gateScriptPath = null;
		}
	});

	// Process-level termination handling: ensure child process groups (e.g. agy_acp_server
	// or agy stream-json) and temporary gate files are synchronously cleaned up when
	// pi is terminated via Ctrl+C (SIGINT), SIGTERM, or normal process exit.
	const emergencyCleanup = () => {
		void streamDriver.close("recycle", "process exit", true);
		void acpDriver.close("recycle", "process exit", true);
		unregisterBridgeServer(process.pid);
		if (gateScriptPath) {
			try {
				fs.rmSync(gateScriptPath, { force: true });
			} catch {
				/* best effort */
			}
		}
	};

	process.once("exit", emergencyCleanup);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(sig, () => {
			emergencyCleanup();
			const exitCode = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129;
			process.exit(exitCode);
		});
	}
}

