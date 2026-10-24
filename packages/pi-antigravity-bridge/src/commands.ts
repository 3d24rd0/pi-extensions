import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { DIALOG_OPTIONS, DialogMenu, type DialogRow } from "@estebanforge/pi-tui-dialogs";
import type { AgyModelEntry } from "./models.js";
import type { SessionStore } from "./sessions.js";
import type { TurnDriver } from "./driver-types.js";
import type { AcpDriver } from "./acp/driver.js";
import { spawn } from "node:child_process";
import {
	CONFIG_PATH,
	loadConfig,
	logsDir,
	MAX_TURN_CAP_MIN,
	parseCapMinutes,
	saveConfig,
	type AgyMode,
	type BridgeTools,
	type Engine,
	type ThinkingTier,
} from "./config.js";
import {
	isAgyInstalled,
} from "./engine-picker.js";
import { checkAgyCliVersion, describeAgyVersionCheck, MIN_AGY_VERSION } from "./agy-version.js";
import { isValidAgyAgentName, listAgyAgents } from "./agents.js";
import { formatSubagentRoster, type SubagentRoster } from "./subagent-roster.js";
import { fetchAgyQuota, formatAgyQuotaReport } from "./usage.js";
import { artifactOpenCommand, listAgyArtifacts } from "./artifacts.js";
import { showArtifactsBrowser } from "./artifacts-ui.js";
import { listAgyTasks, tailAgyTaskLog } from "./tasks.js";
import { showTasksBrowser } from "./tasks-ui.js";
import { agyConversationDir, resolveAgyBinary } from "./agy-paths.js";
import type { DailyLogger } from "./daily-log.js";
import { ensureAcpReady, inspectAcpSetup } from "./acp/setup.js";
import { runAcpAuth } from "./acp/auth.js";
import { patchStatus, restorePatch } from "./patch-cleanup.js";
import { withDialogLock } from "./dialog-lock.js";

/** Shared body for every ACP-login-pending moment */
export function acpLoginPending(): string {
	return `One-time sign-in needed to finish ACP setup. Run /agy auth: the Google sign-in opens in your browser. Use the Google account of your Antigravity subscription (the same account as your agy CLI login). If no browser opens, pi shows the sign-in URL to copy. The token stays on your machine; this extension never sees it.`;
}
// --- /agy command -----------------------------------------------------------

export interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
	driver: TurnDriver;
	acpDriver: AcpDriver;
	/** Engine latched at extension load (see the provider wiring note). */
	engine: Engine;
	getMcpPort: () => number | null;
	bridgeTools: () => Array<{ name: string }>;
	hiddenBridgeTools: Set<string>;
	/** Shared ACP log sink (login URL surfacing + failure events). */
	acpLog: (msg: string, data?: unknown) => void;
	/** Daily file logger (src/daily-log.ts); command + doctor surfacing. */
	fileLog: DailyLogger;
	/** Live subagent roster (folded in the provider); /agy subagents. */
	roster: SubagentRoster;
	/** Wizard-pick follow-through (download now + chained sign-in); reused
	 *  by /agy engine's no-args modal so both entry points behave alike. */
	runAcpPickSetup: (cmdCtx: { ui: ExtensionUIContext }) => Promise<void>;
	/** BROWSER-capture handles; null when unavailable (Windows, unwritable
	 *  data dir). /agy auth passes them to the sign-in process. */
	authCapture: { browserEnv: Record<string, string>; file: string } | null;
	/** Notify active UI from outside command handler when needed */
	setActiveUi?: (ui: ExtensionUIContext) => void;
}

interface PendingConfig {
	mode?: AgyMode;
	readOnly?: boolean;
	skipPermissions?: boolean;
	defaultModel?: string;
	defaultThinking?: ThinkingTier;
	turnTimeoutMin?: number;
	askTool?: boolean;
	webTools?: boolean;
	bridgeTools?: BridgeTools;
	digest?: boolean;
	systemPrompt?: boolean;
}

function settingsRows(ctx: AgyCommandCtx): string[] {
	const config = loadConfig();
	const perm = config.skipPermissions ? "auto-approved (DANGEROUS)" : "prompt (hangs in -p)";
	// padEnd keyed to the longest label ("AskAntigravity thinking:") so the
	// value column stays aligned as labels grow. Doctor-only state (engine,
	// models, sessions, config path) lives in /agy doctor, not here: one
	// surface per concern — this is the config surface, doctor is health.
	const row = (label: string, value: string) => `  ${label.padEnd(24)} ${value}`;
	return [
		row("mode:", config.mode),
		row(
			"readOnly:",
			config.readOnly ? "on (provider turns are refused)" : "off",
		),
		row("permissions:", perm),
		row("AskAntigravity tool:", config.askTool ? "on" : "off"),
		row("Web tools:", config.webTools ? "on" : "off"),
		row("AskAntigravity model:", config.defaultModel),
		row("AskAntigravity thinking:", config.defaultThinking),
		row("bridge tools:", config.bridgeTools),
		row("digest:", config.digest ? "on" : "off"),
		row("system prompt:", config.systemPrompt ? "on" : "off"),
	];
}

function statusText(ctx: AgyCommandCtx): string {
	const config = loadConfig();
	const source = ctx.usingFallback ? "fallback (agy models failed)" : "discovered";
	return [
		"Antigravity bridge",
		`  engine:        ${config.engine}${config.engine === "stream-json" ? " (agy CLI fallback)" : " (official server)"}`,
		`  models:        ${ctx.entries.length} ${source}`,
		...settingsRows(ctx),
		`  sessions:      ${ctx.store.size} bound`,
		`  config:        ${CONFIG_PATH}`,
		"",
		"Subcommands: /agy auth, /agy auth-manual, /agy engine stream-json|acp, /agy mode plan|accept-edits, /agy readonly on|off, /agy permissions on|off, /agy ask on|off, /agy model <alias>, /agy thinking low|medium|high, /agy agent <name|off>, /agy subagents, /agy quota, /agy artifacts [open <n|name>], /agy tasks [tail <id>], /agy bridge all|mcp|none, /agy tools [hide|show <name>|reset], /agy web on|off, /agy digest on|off, /agy system-prompt on|off, /agy timeout <1-1440|off>, /agy acp-bin <path|auto>, /agy patch-cleanup, /agy clear, /agy doctor",
	].join("\n");
}


export function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity provider: doctor (health + settings), settings picker, clear sessions. Usage: /agy [doctor|auth|auth-manual|engine stream-json|acp|mode plan|accept-edits|readonly on|off|permissions on|off|ask on|off|model <alias>|thinking low|medium|high|agent <name|off>|subagents|quota|artifacts [open <n|name>]|tasks [tail <id>]|bridge all|mcp|none|tools [hide|show <name>|reset]|web on|off|digest on|off|system-prompt on|off|timeout <1-1440|off>|acp-bin <path|auto>|patch-cleanup|clear]",
		handler: async (args, cmdCtx: ExtensionCommandContext) => {
			const ui = cmdCtx.ui;
			if (ui && ctx.setActiveUi) ctx.setActiveUi(ui);
			const mode = cmdCtx.mode;
			const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
			const val = (args ?? "").trim().split(/\s+/)[1]?.toLowerCase();
			ctx.fileLog.log("agy-command", { args }, "info");

			// Direct subcommands work everywhere (headless + TUI).
			if (sub === "clear") {
				ctx.store.clear();
				ui?.notify("Cleared all antigravity session bindings.", "info");
				return;
			}
			if (sub === "patch-cleanup") {
				const st = patchStatus();
				if (!st.present) {
					ui?.notify(
						st.root
							? `No invokeTool patch detected on pi ${st.version}. Nothing to clean.`
							: "Could not locate the installed pi package. Nothing cleaned.",
						"info",
					);
					return;
				}
				const r = restorePatch();
				ui?.notify(
					r.ok
						? `Restored ${r.restoredFiles.length} file(s) from ${r.backupDir}. The running session is unaffected; the files on disk are clean again.`
						: `patch-cleanup failed: ${r.reason}`,
					r.ok ? "info" : "error",
				);
				return;
			}
			if (sub === "timeout") {
				// Free-type entry point for the turn cap (the TUI picker only offers
				// presets). Same sanity rules as loadConfig: 1..MAX valid, off/0
				// disables, anything else rejected with the valid range.
				const live = loadConfig();
				const cur = live.turnTimeoutMin;
				if (!val) {
					ui?.notify(
						`Turn time cap: ${cur === 0 ? "off (no cap)" : `${cur}m`}. Usage: /agy timeout <1-${MAX_TURN_CAP_MIN}|off>. Default: off on an interactive pi, 20m headless.`,
						"info",
					);
					return;
				}
				const parsed = val === "off" ? 0 : parseCapMinutes(val, Number.NaN);
				if (Number.isNaN(parsed)) {
					ui?.notify(`Invalid turn cap "${val}". Use 1-${MAX_TURN_CAP_MIN} minutes, or off/0 to disable.`, "error");
					return;
				}
				saveConfig({ turnTimeoutMin: parsed });
				ui?.notify(
					parsed === 0
						? `Turn time cap disabled. The inactivity stall guard (${live.inactivityTimeoutMin}m silence) still applies.`
						: `Turn time cap set to ${parsed}m. Takes effect next turn.`,
					"info",
				);
				return;
			}
			if (sub === "engine") {
				ui?.notify("Models now declare their engine directly in the model name (e.g. gemini-4-argon-acp vs gemini-4-argon-cli). Use /model to switch engines.", "info");
				return;
			}
			if (sub === "auth") {
				// Gate on the CONFIGURED engine (disk + env), not the latched one:
				// /agy engine acp followed by /agy auth in the same session works,
				// no restart needed before signing in.
				if (loadConfig().engine !== "acp") {
					ui?.notify(`the selected engine is ${loadConfig().engine}. /agy engine acp first, then /agy auth.`, "warning");
					return;
				}
				ui?.notify("Preparing the ACP server (binary + auth settings)…", "info");
				const status = await ensureAcpReady({ configBin: loadConfig().acp.bin, onProgress: (m) => ui?.notify(m, "info") });
				ctx.fileLog.log(
					"acp-setup",
					status.ok
						? { ok: true, binarySource: status.binarySource, needsLogin: status.needsLogin }
						: { ok: false, error: status.error },
					status.ok ? "info" : "warn",
				);
				if (!status.ok) {
					ui?.notify(`ACP auto-setup failed (${status.error}).\n${status.manual}`, "warning");
					return;
				}
				saveConfig({ acp: { ...loadConfig().acp, bin: status.bin } });
				if (!status.needsLogin) {
					ui?.notify(`Already signed in (auth: ${status.auth}). Nothing to do.`, "info");
					return;
				}
				ui?.notify(
					"Signing in: the Google sign-in opens in your browser and completes when you finish it (minutes-scale). If no browser opens, pi shows the sign-in URL to copy.",
					"info",
				);
				const r = await runAcpAuth({
					bin: status.bin,
					extraEnv: ctx.authCapture?.browserEnv,
					authUrlFile: ctx.authCapture?.file,
					log: ctx.acpLog,
				});
				ctx.fileLog.log("acp-auth", r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? "info" : "warn");
				if (r.ok) {
					ui?.notify(
						r.note ? `Signed in (${r.note}). The ACP engine is ready; takes effect on the next pi start (or /reload).` : "Signed in. The ACP engine is ready; takes effect on the next pi start (or /reload).",
						"info",
					);
				} else {
					ui?.notify(`ACP sign-in failed (${r.error}).\nRun /agy auth to retry; /agy auth-manual has manual steps.`, "warning");
				}
				return;
			}
			if (sub === "acp-bin") {
				const rest = (args ?? "").trim().split(/\s+/).slice(1).join(" ");
				if (rest.length > 0) {
					// Only the keyword compares case-insensitively; the path keeps its case.
					const bin = rest.toLowerCase() === "auto" ? "" : rest.replace(/^~(?=\/|$)/, os.homedir());
					// Spread, not a bare acp patch: a bare {bin} object
					// would drop sibling keys (usageEstimate) from the file.
					saveConfig({ acp: { ...loadConfig().acp, bin } });
					ui?.notify(
						bin
							? `acp.bin set to ${bin}. The next ACP turn (re)connects with it.`
							: "acp.bin cleared. Auto-setup (or AGY_ACP_BIN) picks the binary on the next ACP turn.",
						"info",
					);
				} else {
					const cur = loadConfig().acp.bin;
					ui?.notify(`acp.bin: ${cur || "(auto: setup installs, or AGY_ACP_BIN)"}\nusage: /agy acp-bin <path|auto>`, "info");
				}
				return;
			}
			if (sub === "auth-manual") {
				ui?.notify(
					[
						"ACP engine authentication (one-time; usually automatic -",
						"/agy engine acp and session start set this up for you):",
						"",
						"The server is Google's official Antigravity ACP, installed from Google's",
						"own registry. Logging in uses your Antigravity subscription: the same",
						"Google account and plan as the Antigravity CLI (agy). It is no different",
						"from logging into the CLI; the server just keeps its own token file on",
						"your machine, like any Google tool. This extension never sees your",
						"credentials.",
						"",
						"1. Server binary: auto-setup installs it. Manual: agy_acp_server.par from",
						"   the antigravity-acp registry; point acp.bin or AGY_ACP_BIN at it.",
						'2. Default: put {"auth":{"type":"oauth-personal"}} in',
						"   ~/.gemini/antigravity-acp/settings.json, run /agy auth, and complete",
						"   the Google login that opens in your browser. No browser (SSH",
						"   session)? pi shows the sign-in URL to copy; forward the redirect",
						"   port over ssh (ssh -N -L <port>:127.0.0.1:<port> <user@host>), then",
						"   open the URL on your machine.",
						'   Headless alternative: GEMINI_API_KEY + {"auth":{"type":"gemini-api-key"}}',
						"   (metered paid API - not your Antigravity plan). The key is used only",
						"   when that type is selected; with the default oauth-personal in place,",
						"   an exported key is ignored.",
						"3. /agy doctor shows the server version when auth is OK.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "doctor") {
				const config = loadConfig();
				const engine = ctx.engine;
				const snap = (engine === "acp" ? ctx.acpDriver : ctx.driver).snapshot();
				const port = ctx.getMcpPort();
				// The CLI matters on both engines (AskAntigravity shells out to
				// `agy -p` even when turns ride ACP), but on an ACP session a
				// missing CLI is a supported shape, so label it optional there
				// instead of showing a bare failure line.
				const cliCheck = await checkAgyCliVersion(resolveAgyBinary());
				const cliSuffix =
					cliCheck.status === "unavailable" && engine === "acp"
						? " (optional here; AskAntigravity delegations use the CLI)"
						: "";
				const lines = [
					"Antigravity doctor (no tokens spent)",
					`  engine:        ${engine}`,
					`  bridge:        ${config.bridgeTools}${port ? ` (port ${port})` : " (not running)"}`,
					`  driver:        ${snap.state}${snap.pid ? ` pid=${snap.pid}` : ""}${snap.conversationId ? ` session=${snap.conversationId.slice(0, 8)}` : ""}`,
					`  driver stats:  spawns=${snap.stats.spawns} turns=${snap.stats.turns} reused=${snap.stats.reused} recycles=${snap.stats.recycles}${snap.stats.lastRecycleReason ? ` (last: ${snap.stats.lastRecycleReason})` : ""}`,
					`  sessions:      ${ctx.store.size} bound`,
					`  models:        ${ctx.entries.length} ${ctx.usingFallback ? "FALLBACK (agy models failed)" : "discovered"}`,
					`  agy cli:       ${describeAgyVersionCheck(cliCheck)} (min ${MIN_AGY_VERSION})${cliSuffix}`,
					`  config:        ${CONFIG_PATH}`,
					`  logs:          ${logsDir()} (attach recent days' files when reporting issues; set AGY_DEBUG=1 to capture details)`,
				];
				if (snap.engine === "acp" && snap.acp) {
					lines.push(
						`  acp session:   ${snap.acp.sessionId ?? "(none)"}`,
						`  acp server:    ${snap.acp.serverVersion ?? "unknown"}${snap.acp.agentTitle ? ` (${snap.acp.agentTitle})` : ""}`,
						`  acp stats:     prompts=${snap.acp.prompts} created=${snap.acp.sessionsCreated} loaded=${snap.acp.sessionsLoaded} kills=${snap.acp.kills} reconnects=${snap.acp.reconnects} cancel=${snap.acp.cancelSupported === null ? "unprobed" : snap.acp.cancelSupported ? "supported" : "unsupported (kill+reload)"}`,
					);
					// Gate B watch: silent while the server offers no token counts; one
					// line the day it starts (then real usage mapping is worth wiring).
					if (snap.acp.usageSeen) {
						lines.push("  acp tokens:    AVAILABLE in server payloads (wire real usage mapping next)");
					} else if (config.acp.usageEstimate !== "off") {
						lines.push(`  acp tokens:    ESTIMATED client-side (mode: ${config.acp.usageEstimate}; auto-off once the server sends real usage)`);
					}
				}
				if (snap.lifecycle.length > 0) {
					lines.push("  lifecycle (last 5):");
					for (const entry of snap.lifecycle.slice(-5)) lines.push(`    ${entry}`);
				}
				if (engine === "acp") {
					const setup = inspectAcpSetup({ configBin: config.acp.bin });
					lines.push(
						`  acp binary:    ${setup.bin ?? "not found (auto-setup offers install)"}${setup.source ? ` (${setup.source})` : ""}`,
						`  acp auth:      ${setup.auth ?? "not configured (auto-setup bootstraps)"}`,
					);
				}
				// The config surface lives here too, so doctor is the ONE status
				// surface (former /agy status is gone).
				lines.push("", "settings:", ...settingsRows(ctx));
				ui?.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "mode") {
				if (val === "plan" || val === "accept-edits") {
					if (val === "plan" && ctx.engine === "acp") {
						ui?.notify("plan cannot be enforced on provider turns on either engine: the ACP engine has no plan mode (RC01), and the CLI does not gate writes under plan (google-antigravity/antigravity-cli#1181). /agy mode accept-edits.", "warning");
						return;
					}
					const next = saveConfig({ mode: val as AgyMode });
					// readOnly fail-closes provider turns regardless of this knob;
					// never let the confirmation imply turns will run. loadConfig, not
					// next: saveConfig merges the raw file, so an env-only readOnly
					// would otherwise read as off here.
					const effectiveReadonly = loadConfig().readOnly;
					if (effectiveReadonly) {
						ui?.notify(`mode set to ${next.mode}, but readOnly is on: provider turns are refused. /agy readonly off to lift.`, "info");
					} else if (val === "plan") {
						ui?.notify(`mode set to plan: provider turns are REFUSED (the CLI does not gate writes under plan, google-antigravity/antigravity-cli#1181). Only the AskAntigravity tool uses this mode.`, "info");
					} else {
						ui?.notify(`mode set to ${next.mode}`, "info");
					}
				} else {
					const cfg = loadConfig();
					ui?.notify(
						`current mode: ${cfg.mode}${cfg.readOnly ? " (readOnly on: provider turns are refused)" : ""}\nusage: /agy mode plan|accept-edits`,
						"info",
					);
				}
				return;
			}
			if (sub === "readonly") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ readOnly: val === "on" });
					ui?.notify(
						next.readOnly
							? "readOnly is on: provider turns and AskAntigravity are REFUSED (the agy CLI has no review-only enforcement on any path; probed 2026-10-07). Enforce read-only in the host, then /agy readonly off."
							: "readOnly off: provider turns follow /agy mode again.",
						"info",
					);
					// Compare effective vs saved: the env can force either direction
					// (AGY_READONLY=1 keeps refusals on after /agy readonly off;
					// AGY_READONLY=0 silently keeps readOnly off after /agy readonly on).
					if (loadConfig().readOnly !== next.readOnly) {
						ui?.notify(`AGY_READONLY is set in this environment and overrides the config: readOnly stays ${loadConfig().readOnly ? "on (refusing)" : "off"} until you unset it.`, "warning");
					}
				} else {
					const cfg = loadConfig();
					ui?.notify(
						`readOnly is ${cfg.readOnly ? "on (provider turns and AskAntigravity are refused)" : "off"}\nusage: /agy readonly on|off. Fail-closed: the CLI has no review-only enforcement on any path (probed 2026-10-07), so on = refuse.`,
						"info",
					);
				}
				return;
			}
			if (sub === "tasks") {
				const engine = ctx.engine;
				const snap = (engine === "acp" ? ctx.acpDriver : ctx.driver).snapshot();
				const conversationId = snap.conversationId ?? undefined;
				if (!conversationId) {
					ui?.notify("no Antigravity conversation bound yet; run a turn first.", "warning");
					return;
				}
				const dir = agyConversationDir(engine, conversationId);
				const rest = (args ?? "").trim().split(/\s+/);

				// /agy tasks tail <id>: last bytes of one task log into chat.
				// Resolved against the scanned list, not a rebuilt filename:
				// the id->filename convention must not live in two places.
				if (rest[0]?.toLowerCase() === "tail") {
					const id = Number(rest[1]);
					if (!Number.isInteger(id) || id < 0) {
						ui?.notify("usage: /agy tasks tail <id>. /agy tasks lists them.", "warning");
						return;
					}
					const tasks = await listAgyTasks(dir);
					const task = tasks.find((t) => t.id === id);
					if (!task) {
						ui?.notify(`no task #${id} in this conversation. /agy tasks lists them.`, "warning");
						return;
					}
					const tail = await tailAgyTaskLog(task.logPath);
					if (tail === "") {
						ui?.notify(`task #${id} has no readable log.`, "warning");
						return;
					}
					const lines = tail.split("\n");
					const body = lines.length > 40 ? `…\n${lines.slice(-40).join("\n")}` : tail;
					ui?.notify(`task #${id} tail:\n${body}`, "info");
					return;
				}

				// Dashboard form; r rescans by re-listing fresh.
				let tasks = await listAgyTasks(dir);
				if (tasks.length === 0) {
					ui?.notify("no background tasks recorded for this conversation.", "info");
					return;
				}
				if (!ui) {
					const lines = tasks.map((t) => {
						const state = t.livenessKnown ? (t.active ? "ACTIVE" : "idle") : "liveness?";
						return `#${t.id}  ${state}  ${t.bytes}B`;
					});
					console.log([`antigravity tasks (${tasks.length}):`, ...lines].join("\n"));
					return;
				}
				for (;;) {
					const action = await showTasksBrowser(ui, tasks, tasks[0]?.livenessKnown ?? false);
					if (action.type === "rescan") {
						tasks = await listAgyTasks(dir);
						if (tasks.length === 0) {
							ui?.notify("no background tasks recorded for this conversation.", "info");
						}
						continue;
					}
					break;
				}
				return;
			}
			if (sub === "artifacts") {
				const engine = ctx.engine;
				const snap = (engine === "acp" ? ctx.acpDriver : ctx.driver).snapshot();
				const conversationId = snap.conversationId ?? undefined;
				if (!conversationId) {
					ui?.notify("no Antigravity conversation bound yet; run a turn first.", "warning");
					return;
				}
				const dir = agyConversationDir(engine, conversationId);
				const rest = (args ?? "").trim().split(/\s+/).slice(1);
				const openWord = rest[0]?.toLowerCase();

				// /agy artifacts open <name|index>: direct open, no overlay.
				if (openWord === "open") {
					const artifacts = await listAgyArtifacts(dir);
					if (artifacts.length === 0) {
						ui?.notify("no artifacts in this conversation.", "info");
						return;
					}
					const target = rest.slice(1).join(" ").trim();
					if (target === "") {
						ui?.notify("usage: /agy artifacts open <name|index>. /agy artifacts lists them.", "warning");
						return;
					}
					const byIndex = /^\d+$/.test(target) ? Number(target) : undefined;
					const artifact =
						byIndex !== undefined
							? artifacts[byIndex]
							: artifacts.find((a) => a.name.toLowerCase() === target.toLowerCase()) ??
								(artifacts.filter((a) => a.name.toLowerCase().includes(target.toLowerCase())).length === 1
									? artifacts.find((a) => a.name.toLowerCase().includes(target.toLowerCase()))
									: undefined); // ambiguous or no match
					if (!artifact) {
						ui?.notify(`no unique artifact matches ${JSON.stringify(target)}. /agy artifacts lists them.`, "warning");
						return;
					}
					const openCmd = artifactOpenCommand();
					if (!openCmd) {
						ui?.notify(`no file-open handler for ${process.platform}; the file is at ${artifact.absolutePath}`, "warning");
						return;
					}
					spawn(openCmd.cmd, [artifact.absolutePath], { detached: true, stdio: "ignore", shell: false }).unref();
					ui?.notify(`opened ${artifact.name}`, "info");
					return;
				}

				// Browser loop; r rescans by re-listing fresh. The first scan is
				// reused so the emptiness gate does not cost a second readdir pass.
				let artifacts = await listAgyArtifacts(dir);
				if (artifacts.length === 0) {
					ui?.notify("no artifacts in this conversation (media dirs appear once agy generates or receives files).", "info");
					return;
				}
				if (!ui) {
					// Headless: no overlay is possible; print the indexed list.
					const lines = artifacts.map((a, i) => `${i}  ${a.name} (${a.kind}, ${a.bytes}B)`);
					console.log([`antigravity artifacts (${artifacts.length}):`, ...lines].join("\n"));
					return;
				}
				for (;;) {
					const action = await showArtifactsBrowser(ui, artifacts);
					if (action.type === "rescan") {
						artifacts = await listAgyArtifacts(dir);
						continue;
					}
					if (action.type === "open") {
						const openCmd = artifactOpenCommand();
						if (!openCmd) {
							ui.notify(`no file-open handler for ${process.platform}.`, "warning");
							continue;
						}
						spawn(openCmd.cmd, [action.artifact.absolutePath], { detached: true, stdio: "ignore", shell: false }).unref();
					}
					break;
				}
				return;
			}
			if (sub === "quota") {
				// Quota lives in the CLI's Google identity. A pure-ACP install
				// without the CLI is a supported shape; say what is missing instead
				// of rendering a fetch failure.
				const bin = resolveAgyBinary();
				if (!isAgyInstalled(bin)) {
					ui?.notify(
						"quota comes from the agy CLI, which is not installed. ACP-only setups can install the CLI separately (same Google account) to see subscription quota (/agy doctor shows what IS available).",
						"warning",
					);
					return;
				}
				// /usage answers in ~10s live; surface the wait instead of a dead
				// command line.
				ui?.setStatus("agy-quota", "checking agy quota…");
				try {
					const report = await fetchAgyQuota(bin);
					if (report === undefined) {
						ui?.notify("quota unavailable: agy did not return a /usage payload (see /agy doctor for binary health).", "warning");
						return;
					}
					ui?.notify(formatAgyQuotaReport(report), "info");
				} finally {
					ui?.setStatus("agy-quota", undefined);
				}
				return;
			}
			if (sub === "subagents") {
				const entries = ctx.roster.snapshot();
				if (entries.length === 0) {
					ui?.notify("antigravity subagents: none tracked this session\n\nagy spawns subagents as ordinary tool steps; they appear here once a turn uses them.", "info");
					return;
				}
				ui?.notify(formatSubagentRoster(entries), "info");
				return;
			}
			if (sub === "agent") {
				// ACP has no agent slot in the protocol (RC01): refuse instead of
				// silently ignoring a configured agent.
				if (ctx.engine === "acp") {
					ui?.notify("the ACP engine has no agent selection (RC01). /agy engine stream-json first.", "warning");
					return;
				}
				const name = (args ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
				if (!name) {
					const agents = await listAgyAgents(resolveAgyBinary());
					const current = loadConfig().agent;
					const agentList =
						agents.length > 0
							? agents.map((a) => `${a === current ? ">" : " "} ${a}`).join("\n")
							: "(no custom agents defined)";
					ui?.notify(`current agent: ${current ?? "(agy default)"}\n\n${agentList}\n\nusage: /agy agent <name|off>`, "info");
					return;
				}
				if (name === "off" || name === "none" || name === "default") {
					saveConfig({ agent: undefined });
					ui?.notify("agent cleared: agy default", "info");
					return;
				}
				if (!isValidAgyAgentName(name)) {
					ui?.notify(`invalid agent name: ${name} (use letters, digits, dot, dash, underscore)`, "warning");
					return;
				}
				saveConfig({ agent: name });
				ui?.notify(`agent set: ${name} (takes effect on the next stream-json turn)`, "info");
				return;
			}
			if (sub === "permissions") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ skipPermissions: val === "on" });
					const warn = next.skipPermissions ? "\nWARNING: agy can now run arbitrary commands without review." : "";
					ui?.notify(`permissions: ${next.skipPermissions ? "auto-approved (DANGEROUS)" : "prompt"}${warn}`, next.skipPermissions ? "warning" : "info");
				} else {
					ui?.notify(`permissions: ${loadConfig().skipPermissions ? "auto-approved (DANGEROUS)" : "prompt"}\nusage: /agy permissions on|off\n(off hangs any run_command in non-interactive mode)`, "info");
				}
				return;
			}
			if (sub === "bridge") {
				if (val === "all" || val === "mcp" || val === "none") {
					const next = saveConfig({ bridgeTools: val });
					ui?.notify(
						ctx.getMcpPort() === null
							? `bridge ${next.bridgeTools}. The bridge server is not running; /reload to apply.`
							: `bridge ${next.bridgeTools}. The active catalog and call guard update now; ACP may retain cached schemas until the next session/load.`,
						"info",
					);
				} else {
					ui?.notify(`bridge: ${loadConfig().bridgeTools}\nusage: /agy bridge all|mcp|none\n  all: active non-builtin pi tools. mcp: active pi-mcp-adapter tools + skills. none: bridge off.`, "info");
				}
				return;
			}
			if (sub === "tools") {
				const name = (args ?? "").trim().split(/\s+/).slice(2).join(" ");
				if (val === "reset") {
					ctx.hiddenBridgeTools.clear();
					ui?.notify("Antigravity tool visibility reset for this Pi session. Pi's active tools are unchanged.", "info");
				} else if ((val === "hide" || val === "show") && name) {
					if (!pi.getAllTools().some((tool) => tool.name === name)) {
						ui?.notify(`Unknown Pi tool: ${name}`, "error");
						return;
					}
					if (val === "hide") ctx.hiddenBridgeTools.add(name);
					else ctx.hiddenBridgeTools.delete(name);
					ui?.notify(`${name}: ${val === "hide" ? "hidden from Antigravity" : "visible if active in Pi"}. No MCP config changed.`, "info");
				} else {
					ui?.notify(`Exposed active Pi tools: ${ctx.bridgeTools().map((tool) => tool.name).join(", ") || "(none)"}\nHidden in this session: ${[...ctx.hiddenBridgeTools].join(", ") || "(none)"}\n/agy tools hide|show <exact Pi tool name> | reset\nUse Pi's /mcp or pi.setActiveTools() to change the underlying active tools.`, "info");
				}
				return;
			}
			if (sub === "model") {
				if (val && val.length > 0) {
					const next = saveConfig({ defaultModel: val });
					ui?.notify(`AskAntigravity default model set to ${next.defaultModel}`, "info");
				} else {
					ui?.notify(`AskAntigravity model: ${loadConfig().defaultModel} (fallback; callers may override per call)\nusage: /agy model flash|argon|gemini|sonnet|opus|<exact>`, "info");
				}
				return;
			}
			if (sub === "ask") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ askTool: val === "on" });
					ui?.notify(
						next.askTool
							? "AskAntigravity tool on. Registered on the next pi start (or /reload)."
							: "AskAntigravity tool off. It is removed from the model's tool list on the next pi start (or /reload). Provider and models stay.",
						"info",
					);
				} else {
					ui?.notify(`AskAntigravity tool: ${loadConfig().askTool ? "on" : "off"}\nusage: /agy ask on|off`, "info");
				}
				return;
			}
			if (sub === "web") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ webTools: val === "on" });
					ui?.notify(
						next.webTools
							? "Web tools on: agy_web_search and agy_read_url register on the next pi start (or /reload). Each call spends Antigravity quota."
							: "Web tools off: agy_web_search and agy_read_url will not register on the next pi start (or /reload).",
						"info",
					);
				} else {
					ui?.notify(`Web tools: ${loadConfig().webTools ? "on" : "off"}\nusage: /agy web on|off\nExposes agy_web_search + agy_read_url as Pi tools for ANY provider (Antigravity sessions already have native web tools). Default off; each call spends Antigravity quota.`, "info");
				}
				return;
			}
			if (sub === "digest") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ digest: val === "on" });
					ui?.notify(
						next.digest
							? "digest on. pi-side context (compaction summaries, other-provider turns) is injected into each agy prompt. Note: this defeats agy's prompt cache (~25-30k tokens re-billed per turn)."
							: "digest off. agy prompts contain only your message; agy's prompt cache stays stable. Enable when mixing providers in one session and agy must see pi-side context.",
						"info",
					);
				} else {
					ui?.notify(`digest: ${loadConfig().digest ? "on" : "off"}\nusage: /agy digest on|off`, "info");
				}
				return;
			}
			if (sub === "system-prompt") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ systemPrompt: val === "on" });
					ui?.notify(
						next.systemPrompt
							? "system-prompt on. pi's system prompt (incl. global and project AGENTS.md) is prepended to the first prompt of each new agy conversation. Existing conversations keep the version they started with."
							: "system-prompt off. agy runs on its own system prompt; pi instructions and AGENTS.md files are not sent.",
						"info",
					);
				} else {
					ui?.notify(`system-prompt: ${loadConfig().systemPrompt ? "on" : "off"}\nusage: /agy system-prompt on|off`, "info");
				}
				return;
			}

			if (sub === "thinking") {
				if (val === "low" || val === "medium" || val === "high") {
					const next = saveConfig({ defaultThinking: val as ThinkingTier });
					ui?.notify(`AskAntigravity default thinking set to ${next.defaultThinking}`, "info");
				} else {
					ui?.notify(`AskAntigravity thinking: ${loadConfig().defaultThinking} (fallback; callers may override per call)\nusage: /agy thinking low|medium|high`, "info");
				}
				return;
			}


			// No subcommand: print status, or open the picker in TUI. The old
			// "status" alias is retired; /agy doctor is the one status surface.
			if (sub) {
				const pointer = sub === "status" ? "/agy status was removed; use /agy doctor.\n" : "";
				ui?.notify(`${pointer}unknown subcommand: ${sub}\n${statusText(ctx)}`, "warning");
				return;
			}

			if (mode !== "tui" || !ui) {
				ui?.notify(statusText(ctx), "info");
				return;
			}

			await openAgyPicker(ui, ctx);
		},
	});
}

/** Interactive settings picker (TUI only). Rows: the runtime config surface
 *  (mode, permissions, model, thinking, bridge, digest, system prompt) plus
 *  the engine row, which resolves the menu on Enter and opens the same
 *  picker modal as /agy engine (self-service binary + auth setup for acp). */
async function openAgyPicker(ui: ExtensionUIContext, ctx: AgyCommandCtx): Promise<void> {
	const config = loadConfig();
	const pending: PendingConfig = {};

	const rows: DialogRow[] = [
		{
			id: "mode",
			label: "Execution mode",
			description:
				"accept-edits: agy applies edits directly. plan: provider turns are REFUSED (the CLI cannot enforce review-only, upstream #1181); AskAntigravity plan runs add a restricted agent as a damper. Takes effect next turn.",
			currentValue: config.mode,
			values: ["accept-edits", "plan"],
		},
		{
			id: "readonly",
			label: "Read-only provider turns",
			description:
				"on: provider turns are REFUSED (fail-closed; the CLI has no review-only enforcement on any path). Enforce read-only in the host instead.",
			currentValue: config.readOnly ? "on" : "off",
			values: ["off", "on"],
		},
		{
			id: "permissions",
			label: "Permissions",
			description:
				"auto-approved: --dangerously-skip-permissions (required so commands don't hang in -p mode). prompt: agy asks y/n (hangs non-interactively).",
			currentValue: config.skipPermissions ? "auto-approved" : "prompt",
			values: ["auto-approved", "prompt"],
		},
		{
			id: "ask",
			label: "AskAntigravity tool",
			description:
				"Register the AskAntigravity one-shot delegation tool. off removes it from the model's tool list (provider and models stay, even with the separate pi-ask-antigravity package installed). Takes effect on the next pi start (or /reload).",
			currentValue: config.askTool ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "web",
			label: "Web tools",
			description:
				"Register agy_web_search + agy_read_url as Pi tools for ANY provider. Default off: Antigravity sessions already have native web tools, and each call spends Antigravity quota. Takes effect on the next pi start (or /reload).",
			currentValue: config.webTools ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "model",
			label: "AskAntigravity model",
			description:
				"AskAntigravity one-shot delegation tool: model used when its caller omits the model param. Callers may override per call; this is only the fallback. flash/argon/gemini/sonnet/opus, or an exact id. Does not affect the provider model you pick in /model.",
			currentValue: config.defaultModel,
			values: ["flash", "argon", "gemini", "sonnet", "opus"],
		},
		{
			id: "thinking",
			label: "AskAntigravity thinking",
			description:
				"AskAntigravity one-shot delegation tool: thinking tier used when the call names none. Callers may override per call; this is only the fallback.",
			currentValue: config.defaultThinking,
			values: ["low", "medium", "high"],
		},
		{
			id: "bridge",
			label: "Bridge tools",
			description:
				"Which pi tools the MCP bridge exposes to agy. all: every non-builtin tool (default). mcp: pi-mcp-adapter tools + skills. none: bridge off.",
			currentValue: config.bridgeTools,
			values: ["all", "mcp", "none"],
		},
		{
			id: "turn-cap",
			label: "Turn time cap",
			description:
				"Max minutes for ONE agy turn before the bridge kills it. Default: no cap on an interactive pi (abort with Esc), 20 headless. 0 disables; 1-1440 enables the gate. Free type via /agy timeout <minutes|off> or config.json. Takes effect next turn.",
			currentValue: String(config.turnTimeoutMin),
			values: ["0", "1", "5", "10", "15", "30", "60", "120", "360", "720", "1440"],
		},
		{
			id: "digest",
			label: "Context digest",
			description:
				"Inject a delta of pi-side context into each agy prompt. Defeats agy's prompt cache (~25-30k tokens re-billed per turn).",
			currentValue: config.digest ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "system-prompt",
			label: "System prompt",
			description:
				"Prepend pi's system prompt (incl. AGENTS.md files) to the first prompt of each new agy conversation.",
			currentValue: config.systemPrompt ? "on" : "off",
			values: ["on", "off"],
		},
	];

	const resolved = await ui.custom<string | undefined>(
		(host, theme, _kb, done) => {
			const menu = new DialogMenu(
				host,
				theme,
				{
					title: "Antigravity provider",
					subtitle: `Config file: ${CONFIG_PATH} — changes save when the dialog closes`,
					rows,
					footer: "↑↓ navigate · Enter/Space cycle · Type to search · Esc close",
					onChange: (id, newValue) => {
						if (id === "mode") {
							pending.mode = newValue as AgyMode;
						} else if (id === "readonly") {
							pending.readOnly = newValue === "on";
						} else if (id === "permissions") {
							pending.skipPermissions = newValue === "auto-approved";
						} else if (id === "model") {
							pending.defaultModel = newValue;
						} else if (id === "thinking") {
							pending.defaultThinking = newValue as ThinkingTier;
						} else if (id === "ask") {
							pending.askTool = newValue === "on";
						} else if (id === "web") {
							pending.webTools = newValue === "on";
						} else if (id === "bridge") {
							pending.bridgeTools = newValue as BridgeTools;
						} else if (id === "turn-cap") {
							pending.turnTimeoutMin = Number(newValue);
						} else if (id === "digest") {
							pending.digest = newValue === "on";
						} else if (id === "system-prompt") {
							pending.systemPrompt = newValue === "on";
						}
					},
				},
				(rowId) => done(rowId),
			);
			return {
				render: (w: number) => menu.render(w),
				invalidate: () => menu.invalidate(),
				handleInput: (data: string) => {
					menu.handleInput(data);
					host.requestRender();
				},
			};
		},
		DIALOG_OPTIONS,
	);

	if (Object.keys(pending).length === 0) {
		return;
	}

	// The picker cannot switch engines (command-only: /agy engine), but the
	// mode row can still produce plan while the engine is acp - either the
	// session-latched engine or the on-disk one, which the Switch engine row
	// can change mid-session without a restart. Plan cannot be enforced on
	// provider turns on either engine (#1181 + RC01); refuse the combination.
	const nextMode = pending.mode ?? config.mode;
	if (nextMode === "plan" && (ctx.engine === "acp" || config.engine === "acp")) {
		ui.notify(
			"plan cannot be enforced on provider turns on either engine (google-antigravity/antigravity-cli#1181; ACP additionally has no plan mode, RC01). /agy mode accept-edits.",
			"warning",
		);
		return;
	}

	try {
		const next = saveConfig(pending);
		const changed = [
			pending.mode ? `mode=${next.mode}` : null,
			pending.readOnly !== undefined ? `readOnly=${next.readOnly ? "on" : "off"}` : null,
			pending.skipPermissions !== undefined
				? `permissions=${next.skipPermissions ? "auto-approved" : "prompt"}`
				: null,
			pending.askTool !== undefined ? `AskAntigravity tool=${next.askTool ? "on" : "off"}` : null,
			pending.webTools !== undefined ? `webTools=${next.webTools ? "on" : "off"}` : null,
			pending.defaultModel !== undefined ? `AskAntigravity model=${next.defaultModel}` : null,
			pending.defaultThinking !== undefined ? `AskAntigravity thinking=${next.defaultThinking}` : null,
			pending.bridgeTools !== undefined ? `bridge=${next.bridgeTools}` : null,
			pending.digest !== undefined ? `digest=${next.digest ? "on" : "off"}` : null,
			pending.systemPrompt !== undefined ? `system-prompt=${next.systemPrompt ? "on" : "off"}` : null,
			pending.turnTimeoutMin !== undefined ? `turn cap=${next.turnTimeoutMin === 0 ? "off" : `${next.turnTimeoutMin}m`}` : null,
		]
			.filter(Boolean)
			.join(", ");
		ui.notify(`Saved: ${changed}`, "info");
	} catch (err) {
		ui.notify(
			`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}
