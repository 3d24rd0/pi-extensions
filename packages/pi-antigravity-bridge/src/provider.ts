// The pi provider: streamSimple(model, context, options) -> AssistantMessageEventStream.
//
// For each turn pi calls streamSimple. We:
//   1. extract the latest user message (agy keeps its own history, so we send
//      only the new prompt, not pi's full transcript)
//   2. resolve the pi model id to the exact agy model string
//   3. look up the stored agy conversation id + last streamed step for this
//      pi session (resume) or start fresh
//   4. spawn agy via runAgyTurn, mapping decoded AgyEvents to pi stream events
//   5. persist the conversation id + final step idx for the next turn
//
// Event mapping (close-on-switch: at most one content block open at a time,
// matching pi-claude-bridge's lifecycle):
//   agy text     -> pi text block  (text_start / text_delta / text_end)
//   agy thinking -> pi thinking block
//   agy tool     -> pi thinking block, labelled "[agy tool: <name>]"
// We do NOT emit toolCall blocks: agy runs its OWN closed tool loop, so there
// is no toolUse stopReason and no tool-result delivery path back to pi.

import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonValue,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import type { Api } from "@earendil-works/pi-ai";
import type { DriverActivity, TurnDriver, TurnHandle } from "./driver-types.js";
import { SubagentRoster } from "./subagent-roster.js";
import { toPiUsage } from "./stream-events.js";
import { mapAgyToolToNative } from "./native-tools.js";
import { isAcpCapableModel, parseModelEngine, toAgyEffort, type AgyModelEntry } from "./models.js";
import { SessionStore } from "./sessions.js";
import { loadConfig } from "./config.js";
import path from "node:path";
import { TurnDiffContext, createExecGitOps, formatInlineDiff, parseEditToolInput } from "./diff-render.js";
import { stageSyspromptAgent } from "./sysprompt-agent.js";
import { estimateTranscriptTokens } from "./acp/usage-estimate.js";

const DEFAULT_TIMEOUT_MIN = 10;

/** Warned once per process: config.agent set while the system prompt needs
 *  the staged carrier agent (issue #2 inline-block fallback). */
let warnedUserAgentConflict = false;

/** conversationId -> staged carrier agent name. Gate-closed turns look the
 *  name up here so a conversation's agent field never flips: a change would
 *  recycle the agy process mid-conversation (profile drift), and a respawn
 *  must reload THAT conversation's own staged instructions. Content-addressed
 *  staging (one dir per body) keeps sibling conversations from overwriting
 *  each other's files. */
const stagedAgentByConversation = new Map<string, string>();

/** Zero-usage helper. agy doesn't expose token counts; pi's cost math gets
 *  zeros (we're not billing through this provider). */
function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

import {
	extractUserPrompt,
	extractImages,
	buildFullPrompt,
	buildContextDigest,
	blocksToText,
	DIGEST_PREAMBLE,
	SYSTEM_PROMPT_PREAMBLE,
	SYSTEM_PROMPT_END,
	TOOL_PRIORITY_NOTE,
	type DigestOptions,
} from "./prompt-digest.js";

export {
	extractUserPrompt,
	extractImages,
	buildFullPrompt,
	buildContextDigest,
	blocksToText,
	DIGEST_PREAMBLE,
	SYSTEM_PROMPT_PREAMBLE,
	SYSTEM_PROMPT_END,
	TOOL_PRIORITY_NOTE,
	type DigestOptions,
};

/** Build a fresh AssistantMessage shell for this turn. Mutated as blocks
 *  stream; passed as `partial` with every event. */
function newAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Session key: prefer pi's sessionId (stable per conversation), fall back to
 *  cwd so a single pi process still resumes correctly when sessionId is absent. */
function sessionKey(
	options: SimpleStreamOptions | undefined,
	cwd: string,
	engine: "stream-json" | "acp",
): string {
	const sid = (options as { sessionId?: string } | undefined)?.sessionId;
	const base = sid && sid.length > 0 ? `sid:${sid}` : `cwd:${cwd}`;
	// Engine-scoped keys (plan 9.4): one ACP turn must never touch the stream
	// binding and vice versa. Un-suffixed keys = stream-json, byte-compatible with
	// every store that predates the ACP engine.
	return base + (engine === "acp" ? "@acp" : "");
}

/** Track which content block is currently open so we close-on-switch.
 *  At most one of textIdx / thinkingIdx is non-null at a time. */
export interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

export interface NativeDisplayEvent {
	name: string;
	mcpServer?: string;
	status: "started" | "completed" | "failed";
	/** Bridge callId from the tool args (poll calls carry one); lets the
	 *  extension resolve the polled pi tool via the escalation registry. */
	callId?: string;
	path?: string;
	command?: string;
	output?: string;
	diff?: string;
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	store: SessionStore;
	/** Stream-json driver (the tested default engine). Turns run on the
	 *  driver and bridge calls park as toolUse round-trips. Required with
	 *  roundTrips. */
	driver?: TurnDriver;
	/** Official-server ACP engine (the default engine). Selected via
	 *  config.engine = "acp"; when absent the config switch falls back to
	 *  the stream driver. */
	acpDriver?: TurnDriver;
	roundTrips?: ToolRoundTrips;
	/** Replay store for the display-only antigravity wrapper tool. Required
	 *  for native re-exec and wrapper cards; without it tool steps render as
	 *  thinking labels only. */
	replay?: WrapperReplay;
	/** Whether a pi tool is active in the session; native re-exec toolCalls
	 *  are only emitted for active builtins (else the wrapper). */
	nativeActive?: (name: string) => boolean;
	/** Engine latched at extension load. When omitted, the per-call config
	 *  read decides (tests); production wiring always passes it so a
	 *  mid-session config flip cannot move one side of a parked turn. */
	engine?: "stream-json" | "acp";
	/** Output-only ACP tool events; persisted as TUI entries, never sent to
	 *  Antigravity or dispatched through Pi's executable tools. */
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	/** Subagent roster (both engines); folded from every activity. */
	roster?: SubagentRoster;
	/** Daily file log sink (src/daily-log.ts). Records pre-dispatch turn
	 *  errors that never create a driver turn (and so never reach onTurnEnd). */
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

// --- G9: no-patch pi-tool round-trips -----------------------------------------
import {
	ToolRoundTrips,
	WrapperReplay,
	EscalationRegistry,
	collectToolResults,
	buildLateResultPrompt,
	extractResultImages,
	formatEscalatedAck,
	formatPollAnswer,
	defaultEscalateAfterMs,
	BRIDGE_TIMEOUT_MS,
	MAX_PARK_TOMBSTONES,
	POLL_TOOL_NAME,
	ESCALATE_AFTER_MS,
	DELEGATION_ESCALATE_MS,
	ESCALATED_TIMEOUT_MS,
	APPROVAL_PARK_MS,
	type BridgeContentBlock,
	type BridgeCallResultShape,
	type BridgeEscalation,
	type PollView,
	type LateToolResult,
	type ToolRoundTripsOptions,
	type PendingRoundTrip,
} from "./tool-roundtrips.js";

export {
	ToolRoundTrips,
	WrapperReplay,
	EscalationRegistry,
	collectToolResults,
	buildLateResultPrompt,
	extractResultImages,
	formatEscalatedAck,
	formatPollAnswer,
	defaultEscalateAfterMs,
	BRIDGE_TIMEOUT_MS,
	MAX_PARK_TOMBSTONES,
	POLL_TOOL_NAME,
	ESCALATE_AFTER_MS,
	DELEGATION_ESCALATE_MS,
	ESCALATED_TIMEOUT_MS,
	APPROVAL_PARK_MS,
	type BridgeContentBlock,
	type BridgeCallResultShape,
	type BridgeEscalation,
	type PollView,
	type LateToolResult,
	type ToolRoundTripsOptions,
	type PendingRoundTrip,
};

// --- stream-json engine -------------------------------------------------------

export interface DriverDeps {
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
	replay?: WrapperReplay;
	nativeActive?: (name: string) => boolean;
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	/** Subagent roster fold target (both engines; best-effort telemetry). */
	roster?: SubagentRoster;
	/** Active engine (config), for engine-scoped session keys. */
	engine: "stream-json" | "acp";
	/** Daily file log sink for pre-dispatch errors (see StreamSimpleDeps). */
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

/** Map one DriverActivity onto the open pi stream. Returns "parked" when the
 *  activity ended the pi call with a toolUse round-trip. */
export interface ActivityFeatures {
	replay?: WrapperReplay;
	nativeActive?: (name: string) => boolean;
	roundTrips?: ToolRoundTrips;
	engine?: "stream-json" | "acp";
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	roster?: SubagentRoster;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

/** Process-wide counter: round-trip ids must never repeat across turns in
 *  one session transcript. */
let RT_SEQ = 0;
function nextRtId(kind: "nat" | "wrap"): string {
	return `${kind}-${++RT_SEQ}`;
}

/** Emit a complete toolCall block and end the pi call with toolUse.
 *  pi 0.86 restricts ToolCall.arguments to JSON-compatible values. */
function emitToolUse(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	id: string,
	name: string,
	args: Record<string, JsonValue>,
): void {
	const partial = blocks.partial;
	closeThinking(stream, blocks);
	closeText(stream, blocks);
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	partial.content.push(toolCall);
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	stream.end();
}

/** ACP edit-class tool names that carry a file-path arg and land the file on
 *  disk (observed live: edit_file, create_file). Read/execute tools also
 *  match the arg-shape heuristic but produce no diff (unchanged content), so
 *  the gate avoids mislabeling them as edits. */
const ACP_EDIT_TOOLS = new Set(["edit_file", "create_file", "write_to_file"]);

export function consumeActivity(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	activity: DriverActivity,
	diffCtx: TurnDiffContext,
	cwd: string,
	feats: ActivityFeatures,
): "parked" | "continue" {
	const partial = blocks.partial;
	// Subagent roster folds BEFORE any rendering branch: pure in-memory
	// telemetry over the same activities both engines emit, and it must see
	// spawn/message/manage steps regardless of how they render.
	feats.roster?.fold(activity);
	switch (activity.type) {
		case "text":
			appendText(stream, blocks, activity.delta);
			return "continue";
		case "thought":
			// Stream-json: token count only (no body). ACP: thought TEXT deltas —
			// rendered through the same thinking block pipeline (9.2).
			if (typeof activity.delta === "string" && activity.delta.length > 0) {
				appendThinking(stream, blocks, activity.delta);
			}
			return "continue";
		case "usage":
			toPiUsage(activity.usage, partial.usage);
			return "continue";
		case "tool_start":
			// Transient status while Antigravity executes; no Pi tool call or
			// model-facing result is produced. Persist a card only on completion.
			if (feats.engine === "acp" && feats.onNativeEvent) {
				try {
					feats.onNativeEvent({ name: activity.name, mcpServer: activity.mcpServer, status: "started", callId: callIdArg(activity.args) });
				} catch { /* UI failure must not fail the generation. */ }
			}
			return "continue";
/** Bridge callId arg of an MCP tool call (bridge_poll_result requires it). */
function callIdArg(args: Record<string, unknown>): string | undefined {
	const v = args.callId;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** File-path argument of an ACP edit tool (observed: `file_path`); other
 *  tool kinds (execute, read) don't carry one. Returns undefined for
 *  non-edit tools. */
function acpEditFileArg(args: Record<string, unknown>): string | undefined {
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === "string" && v.trim() && /file|path/i.test(k)) return v;
	}
	return undefined;
}

		case "tool_done": {
			// Gate C (ACP): the server already executed the tool; nothing parks.
			// Edit display has TWO paths on ACP:
			//   a) native diff in tool_call content[] (future builds / the
			//      permission-request flow carries it; phase-2 probe shape);
			//   b) RC01 with the auto policy sends NO content: the file simply
			//      lands on disk. Read it and diff against git HEAD - the same
			//      output the stream-json engine produces, one readFileSync.
			if (feats.engine === "acp") {
				const d = activity.diff;
				const editFile = ACP_EDIT_TOOLS.has(activity.name) ? acpEditFileArg(activity.args) : undefined;
				const file = d?.path ?? (editFile ? (path.isAbsolute(editFile) ? editFile : path.resolve(cwd, editFile)) : undefined);
				let diffText = d ? formatInlineDiff(d.oldText ?? "", d.newText) : undefined;
				if (!d && file) {
					let disk = "";
					try {
						disk = fs.readFileSync(file, "utf8");
					} catch {
						/* deleted or unreadable: diffEdit degrades to a summary */
					}
					diffText = diffCtx.diffEdit(file, disk).text;
				}
				const command = ["CommandLine", "command_line", "command"].map((k) => activity.args[k]).find((v): v is string => typeof v === "string" && v.length > 0);
				let displayed = false;
				try {
					if (feats.onNativeEvent) {
						feats.onNativeEvent({ name: activity.name, mcpServer: activity.mcpServer, status: "completed", path: file, command, output: activity.output, diff: diffText, callId: callIdArg(activity.args) });
						displayed = true;
					}
				} catch { /* A stale renderer must never fail the model turn. */ }
				if (displayed) return "continue";
				if (file) {
					appendThinking(stream, blocks, `[agy edit: ${path.basename(file)}]\n`);
					if (diffText) appendThinking(stream, blocks, `${diffText}\n`);
				} else {
					appendThinking(stream, blocks, `[agy tool: ${activity.name}]\n`);
				}
				return "continue";
			}
			// G8 (stream-json): agy file edits surface a git-sourced diff in a
			// thinking block. The server sends no diff here, so OLD comes from git.
			let inputJson: string | undefined;
			try {
				inputJson = JSON.stringify(activity.args);
			} catch {
				inputJson = undefined;
			}
			const edit = inputJson ? parseEditToolInput(inputJson) : null;
			if (edit) {
				const absFile = path.isAbsolute(edit.file) ? edit.file : path.resolve(cwd, edit.file);
				const outcome = diffCtx.diffEdit(absFile, edit.content);
				const label = edit.description ?? path.basename(absFile);
				appendThinking(stream, blocks, `[agy edit: ${label}]\n`);
				if (outcome.text) appendThinking(stream, blocks, `${outcome.text}\n`);
			} else {
				appendThinking(stream, blocks, `[agy tool: ${activity.name}]\n`);
			}
			// Native re-exec: read-only agy tools re-run as REAL pi builtins so
			// their cards render natively. Everything else replays through the
			// display-only wrapper tool. Both end the pi call with toolUse and
			// resume on the toolResult continuation. Without a replay store
			// (feature off) keep the label-only behavior.
			if (!feats.replay || !feats.roundTrips) return "continue";
			if (activity.name === "call_mcp_tool") return "continue";
			const mapped = mapAgyToolToNative(activity.name, activity.args);
			if (mapped && (!feats.nativeActive || feats.nativeActive(mapped.tool))) {
				const id = nextRtId("nat");
				feats.roundTrips.track(id, mapped.tool);
				// pi requires a reasoning argument on read/edit-class builtin calls
				// (validated against the wrapped schema); harmless where absent.
				emitToolUse(stream, blocks, id, mapped.tool, {
					reasoning: `re-exec of agy ${activity.name} for display`,
					...mapped.args,
				} as Record<string, JsonValue>);
				return "parked";
			}
			if (feats.nativeActive && !feats.nativeActive("antigravity")) {
				// Subagent sessions whitelist tools and drop the display wrapper;
				// emitting here would fail every card with "not found".
				feats.log?.("wrap-skip", { tool: activity.name }, "debug");
				return "continue";
			}
			{
				const id = nextRtId("wrap");
				feats.replay.set(id, activity.output ?? "(agy recorded no output)");
				feats.roundTrips.track(id, activity.name);
				emitToolUse(stream, blocks, id, "antigravity", { tool: activity.name, key: id });
				return "parked";
			}
		}
		case "tool_error":
			if (feats.engine === "acp" && feats.onNativeEvent) {
				try {
					feats.onNativeEvent({ name: activity.name, mcpServer: activity.mcpServer, status: "failed", output: activity.message });
					return "continue";
				} catch { /* Fall back to a thinking label. */ }
			}
			appendThinking(stream, blocks, `[agy tool: ${activity.name} failed: ${activity.message}]\n`);
			return "continue";
		case "bridge_call": {
			// Park the pi call: real tool name + args, toolUse stopReason. pi
			// executes; the toolResult returns on the next stream call.
			// Driver args are JSON-decoded off the agy wire, so the JsonValue
			// cast is sound.
			emitToolUse(stream, blocks, activity.callId, activity.name, activity.args as Record<string, JsonValue>);
			return "parked";
		}
	}
}

/** The stream-json engine: persistent driver + toolUse round-trips. */
async function runTurnDriver(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	entries: AgyModelEntry[],
	store: SessionStore,
	deps: DriverDeps,
): Promise<void> {
	const partial = newAssistant(model);
	const contextInputTokens = estimateTranscriptTokens(context.messages);
	if (contextInputTokens > 0) {
		partial.usage.input = contextInputTokens;
		partial.usage.totalTokens = contextInputTokens;
	}
	const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const key = sessionKey(options, cwd, deps.engine);
	const existing = store.get(key);
	const messageCount = context.messages.length;
	const config = loadConfig();

	// Continuation: resolve parked round-trips from pi's toolResult messages,
	// then re-attach to the still-running agy turn. No new user event is sent:
	// agy receives the result via the bridge's MCP HTTP response.
	const results = collectToolResults(context.messages, deps.roundTrips.pendingIds);
	const isContinuation = results.length > 0;
	// Escalated calls answer through bridge_poll_result, not through an agy
	// turn waiting on the park, so note them before resolving.
	const escalatedNames = results
		.map((r) => deps.roundTrips.poll(r.toolCallId)?.name)
		.filter((n): n is string => Boolean(n));
	// Images ride tool results on BOTH engines (ACP probe 2026-09-05;
	// stream-json probe 2026-09-07: the CLI's MCP client delivers tool-result
	// image content to the model — two-tone PNG named from the result alone,
	// no decoders in the frame trail). The late-delivery prompt and the
	// stream-json prompt attachments stay text-only by design.
	for (const r of results)
		deps.roundTrips.resolve(r.toolCallId, r.text, r.isError, r.images);

	// Late delivery: a toolResult whose park already failed (the abort/timeout
	// path failed the park while the pi tool kept running). The work is done,
	// so re-route the result to agy as a new prompt in the same conversation
	// instead of dropping it. Both drivers serialize run(), so delivery queues
	// behind agy's own salvaged turn when one is still active.
	// A pass that anchors a still-pending park (isContinuation) has nowhere to
	// put a late result: it can neither ride the pending call's HTTP response
	// nor start a new prompt. Leave the tombstone for the next fresh pass
	// instead of consuming it blind.
	const late: LateToolResult[] = [];
	if (!isContinuation) {
		for (const r of collectToolResults(context.messages, deps.roundTrips.deadIds)) {
			const dead = deps.roundTrips.consumeDead(r.toolCallId);
			if (dead) late.push({ name: dead.name, reason: dead.reason, text: r.text, isError: r.isError });
		}
		if (late.length > 0) {
			deps.log?.("late-result", { tools: late.map((l) => l.name), freshConversation: !existing?.conversationId }, "info");
		}
	} else if (deps.roundTrips.deadIds.length > 0) {
		deps.log?.("late-result-deferred", { count: deps.roundTrips.deadIds.length }, "info");
	}

	// Stranded escalated results: done but never delivered — the model ended
	// its turn instead of polling bridge_poll_result (observed live 2026-10:
	// the model stopped after the STILL RUNNING ack on an ask_user_question
	// and the user's answer stranded in the registry). The sweep is
	// registry-wide: a toolResult is consumed by its own pass, so a strand
	// that survives its first pass is only findable here. Claims are
	// single-use; entries stay pollable for a late model poll.
	let redeliveryConversation: string | undefined;
	const collectStranded = (): LateToolResult[] =>
		deps.roundTrips.claimAllUndelivered().map((view) => {
			redeliveryConversation ??= view.conversationId;
			deps.log?.("escalated-redelivery", { tool: view.name, callId: view.callId }, "info");
			return {
				callId: view.callId,
				name: view.name,
				reason: "you never received this result: you ended your turn without calling bridge_poll_result",
				text: view.text ?? "(no output)",
				isError: view.isError ?? false,
			};
		});

	const { baseId } = parseModelEngine(model.id);
	const entry = entries.find((e) => e.id === baseId || e.id === model.id) ?? null;
	const agyModel = entry?.full ?? baseId;
	const effort = entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined;

	let handle: TurnHandle | undefined;
	// Name of the carrier agent staged for THIS turn's fresh conversation, if
	// any. Recorded into stagedAgentByConversation once the outcome binds the
	// conversation id, so later gate-closed turns pass the same agent.
	let stagedAgentName: string | undefined;
	const active = isContinuation ? deps.driver.reentry() : null;
	if (active) {
		handle = active;
	} else {
		// Dead turn: claim NOW (single-use). A live turn claims after outcome
		// instead — claiming here would eat the post-outcome recovery.
		late.push(...collectStranded());
		if (isContinuation && late.length === 0) {
			if (escalatedNames.length === 0) {
				deps.log?.("turn-error", { reason: "tool-result-no-active-turn" }, "warn");
				finalize(stream, blocks, "error", "tool result arrived but no antigravity turn is running");
				return;
			}
			// Escalated results, all already delivered through polls: the model
			// has them in context. Settle quietly instead of erroring.
			appendText(stream, blocks, `[bridge] ${escalatedNames.join(", ")} finished; the result is available via ${POLL_TOOL_NAME}.`);
			finalize(stream, blocks, "stop");
			return;
		}
		if (isContinuation && late.length > 0 && redeliveryConversation === undefined && !existing?.conversationId) {
			// The owning turn ended before binding a conversation (no stamp, no
			// store record): a context-free late prompt would hit a brand-new
			// agy conversation that never asked the question. Release the
			// claims and settle quietly; the result stays pollable and a later
			// pass with a bound conversation can still sweep it.
			for (const l of late) if (l.callId) deps.roundTrips.unclaim(l.callId);
			appendText(stream, blocks, `[bridge] ${escalatedNames.join(", ")} finished, but no conversation is bound to re-deliver into; the result stays available via ${POLL_TOOL_NAME}.`);
			finalize(stream, blocks, "stop");
			return;
		}
		// Fresh pass, or a stranded escalated result being re-delivered.
		const prompt = extractUserPrompt(context);
		const images = extractImages(context);
		// An image-only message (no text) is valid on the ACP engine; only fail
		// when there is nothing at all to send (no text, no images, no late
		// tool results to deliver).
		if (!prompt && images.length === 0 && late.length === 0) {
			deps.log?.("turn-error", { reason: "no-user-message" }, "debug");
			finalize(stream, blocks, "error", "No user message to send to agy.");
			return;
		}
		const watermark = existing?.lastMessageCount ?? 0;
		// Late turns re-open the conversation with a synthetic prompt; the digest
		// would re-send context agy already holds, so skip it.
		const digest = config.digest && late.length === 0 ? buildContextDigest(context.messages, watermark) : "";
		// G1 delivery per engine. stream-json: digest rides inline in the prompt
		// (the CLI has no context channel). ACP: the server advertises
		// `embeddedContext`, so the digest ships as a native resource block
		// instead of prompt text (plan phase 3). The preamble framing goes INTO
		// the block: an unlabeled blob of other-agent turns is a mild injection
		// surface, and the model needs the use-for-continuity-only instruction.
		// The uri is suffixed per turn so a deduping server cannot serve stale
		// content on turn 2+.
		const embeddedDigest = deps.engine === "acp" && digest ? digest : undefined;
		// G10, fresh conversations only (bound conversations ride agy's own
		// history; re-sending would bloat every prompt and bust the cache).
		// stream-json delivery is a staged agent file, NOT prompt text: agy's
		// stream-json path silently drops any turn past a ~25KB input cap and
		// the dropped turn leaves the conversation permanently unresponsive
		// (issue #2, probed 2026-09-30), and the block routinely crossed it.
		// ACP keeps the inline block (JSON-RPC transport; --agent is a CLI
		// feature). A user-configured agent always wins: never clobber it.
		const gateOpen = config.systemPrompt && !existing?.conversationId;
		const rawSysPrompt = gateOpen ? getCurrentSystemPrompt(context.messages) || undefined : undefined;
		let sysPrompt = rawSysPrompt;
		let agent = config.agent;
		if (deps.engine !== "acp") {
			if (rawSysPrompt && !config.agent) {
				const stagedName = stageSyspromptAgent(
					[SYSTEM_PROMPT_PREAMBLE, rawSysPrompt, TOOL_PRIORITY_NOTE].join("\n\n"),
				);
				if (stagedName) {
					agent = stagedName;
					sysPrompt = undefined;
					stagedAgentName = stagedName;
				}
				// Staging failed: inline fallback. The silent-drop guard below
				// keeps the resulting cap failure visible instead of quiet.
			} else if (rawSysPrompt && config.agent && !warnedUserAgentConflict) {
				warnedUserAgentConflict = true;
				deps.log?.(
					"sysprompt-agent-conflict",
					{ agent: config.agent, effect: "system prompt ships inline in the prompt (over-cap drop risk)" },
					"warn",
				);
			} else if (!rawSysPrompt && !config.agent && existing?.conversationId) {
				// Gate closed (bound conversation): pass the carrier staged for
				// THIS conversation, if any, so the driver profile never drifts on
				// "agent" and a respawned process reloads its own instructions.
				agent = stagedAgentByConversation.get(existing.conversationId);
			}
		}
		const fullPrompt =
			late.length > 0
				? buildLateResultPrompt(late, prompt || undefined)
				: buildFullPrompt(sysPrompt, embeddedDigest ? "" : digest, prompt ?? "");
		try {
			handle = await deps.driver.run({
				cwd,
				model: agyModel,
				effort,
				mode: config.mode,
				skipPermissions: config.skipPermissions,
				timeoutMin: config.turnTimeoutMin,
				inactivityMin: config.inactivityTimeoutMin,
				conversationId: redeliveryConversation ?? existing?.conversationId ?? null,
				prompt: fullPrompt,
				images: images.length > 0 ? images : undefined,
				agent,
				contextBlock: embeddedDigest
					? {
							uri: `urn:pi-bridge:context-digest/${messageCount}`,
							text: `${DIGEST_PREAMBLE}\n\n${embeddedDigest}`,
						}
					: undefined,
				signal: options?.signal,
				contextInputTokens,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Release stranded claims: the delivery never started, so the next
			// pass must find them undelivered (tombstone-borne items have no
			// callId and stay consumed, as before).
			for (const l of late) if (l.callId) deps.roundTrips.unclaim(l.callId);
			deps.log?.("turn-error", { reason: "driver-start-failed", error: msg }, "error");
			finalize(stream, blocks, "error", `agy failed to start: ${msg}`);
			return;
		}
	}

	ensureStarted(stream, blocks);
	const diffCtx = new TurnDiffContext(createExecGitOps());
	const feats: ActivityFeatures = {
		replay: deps.replay,
		nativeActive: deps.nativeActive,
		roundTrips: deps.roundTrips,
		engine: deps.engine,
		onNativeEvent: deps.onNativeEvent,
		roster: deps.roster,
		log: deps.log,
	};

	const drainTurn = async (h: TurnHandle): Promise<"parked" | undefined> => {
		for (;;) {
			const activity = await h.next();
			if (!activity) break;
			if (consumeActivity(stream, blocks, activity, diffCtx, cwd, feats) === "parked") return "parked";
		}
	};
	if ((await drainTurn(handle)) === "parked") return;

	let outcome = await handle.outcome;
	// Issue #2 recovery paths. agy's stream-json prompt path silently drops an
	// over-cap turn (SUCCESS, empty response, zero usage, NO model step) and a
	// dropped turn leaves the conversation permanently unresponsive, so both
	// failures clear the binding instead of settling a quiet empty reply —
	// settling OK here would persist a dead conversation for every later turn
	// (probe 2026-09-30: resume of a dropped-turn conversation never returns
	// a result frame). stream-json only: the ACP driver leaves the evidence
	// fields undefined.
	const silentDrop = outcome.status === "OK" && outcome.modelOutputSeen === false;
	const poisonedResume =
		outcome.status === "ERROR" &&
		outcome.deadline !== undefined &&
		outcome.sawResult === false &&
		Boolean(existing?.conversationId);
	if (silentDrop || poisonedResume) {
		if (existing?.conversationId || outcome.conversationId) {
			store.delete(key);
			if (outcome.conversationId) stagedAgentByConversation.delete(outcome.conversationId);
		}
		deps.log?.(
			"turn-error",
			{
				reason: silentDrop ? "silent-overcap-drop" : "poisoned-conversation",
				conversation: outcome.conversationId ?? null,
			},
			"error",
		);
		// A deadline with no model output is a stall/timeout, not the over-cap
		// signature: label it by its real cause (the deadline guard's recovered-
		// answer probe can settle OK with an empty response after the kill).
		const dropCause = outcome.deadline
			? "the turn hit its time limit and produced no model output"
			: "the prompt was silently dropped (agy discards prompts past ~25KB with no error)";
		finalize(
			stream,
			blocks,
			"error",
			silentDrop
				? `agy returned success but produced no model output: ${dropCause}. Common cause: a very large pasted prompt. The conversation binding was cleared; retry with a smaller prompt.`
				: "agy stopped responding on the resumed conversation (no response frame before the deadline; the conversation is dead). The binding was cleared, so the next antigravity turn starts a fresh conversation.",
		);
		return;
	}
	// Gap closer: the result landed while the turn was still live (reentry
	// above), the turn ended, and the model never polled. Same strand, same
	// fix: sweep and deliver as a late run in the same conversation. Single
	// shot: claims are single-use, so a re-delivered strand cannot reappear
	// here; a late run that parks hands recovery to the next pi pass.
	if (isContinuation && outcome.status === "OK" && !outcome.aborted) {
		const more = collectStranded();
		if (more.length > 0) {
			const conv = redeliveryConversation ?? outcome.conversationId ?? existing?.conversationId ?? null;
			deps.log?.("escalated-redelivery-turn", { tools: more.map((s) => s.name), conversation: conv }, "info");
			try {
				const lateHandle = await deps.driver.run({
					cwd,
					model: agyModel,
					effort,
					mode: config.mode,
					skipPermissions: config.skipPermissions,
					timeoutMin: config.turnTimeoutMin,
					inactivityMin: config.inactivityTimeoutMin,
					conversationId: conv,
					prompt: buildLateResultPrompt(more),
					agent: config.agent ?? (conv ? stagedAgentByConversation.get(conv) : undefined),
					signal: options?.signal,
					contextInputTokens,
				});
				if ((await drainTurn(lateHandle)) === "parked") return;
				outcome = await lateHandle.outcome;
			} catch (err) {
				// Release the claims so the next pass can retry the delivery.
				for (const l of more) if (l.callId) deps.roundTrips.unclaim(l.callId);
				deps.log?.(
					"turn-error",
					{ reason: "redelivery-start-failed", error: err instanceof Error ? err.message : String(err) },
					"error",
				);
			}
		}
	}
	if (outcome.conversationId) {
		// A different id than the stored one means the driver recreated the
		// conversation under us (ACP session-load fallback, stream-json CLI
		// dropping a stale --conversation). The recreated conversation has seen
		// NOTHING, so the record's watermark would starve the digest forever and
		// its bound id would keep the sysPrompt gate closed. Drop the record:
		// the next turn resumes from watermark 0 with the gate re-armed (issue
		// #1). The recreation turn itself is past the gate, so it is the
		// documented residual; recovery starts on the next turn.
		if (existing?.conversationId && outcome.conversationId !== existing.conversationId) {
			store.delete(key);
			stagedAgentByConversation.delete(existing.conversationId);
		} else if (outcome.status === "OK" && !outcome.aborted) {
			store.set(key, {
				conversationId: outcome.conversationId,
				lastStepIdx: -1,
				lastMessageCount: messageCount,
			});
			if (stagedAgentName) stagedAgentByConversation.set(outcome.conversationId, stagedAgentName);
		}
		// A failed or aborted turn on the SAME conversation keeps the pre-turn
		// record: whether the prompt actually landed in agy's DB is not
		// observable from here. Keeping the watermark re-delivers the missed
		// turn in the next digest (bounded by the digest cap); advancing it
		// would starve the conversation of context it may never have received.
	}
	if (outcome.aborted) {
		finalize(stream, blocks, "aborted", "Operation aborted");
		return;
	}
	if (outcome.status === "ERROR") {
		finalize(stream, blocks, "error", outcome.error ?? "agy turn failed");
		return;
	}
	if (blocks.textIdx === null && outcome.response) {
		appendText(stream, blocks, outcome.response);
	}
	if (blocks.textIdx === null && blocks.thinkingIdx === null) {
		ensureTextOpen(stream, blocks);
	}
	if (blocks.partial.usage.input < contextInputTokens) {
		blocks.partial.usage.input = contextInputTokens;
	}
	if (blocks.partial.usage.totalTokens < blocks.partial.usage.input + blocks.partial.usage.output) {
		blocks.partial.usage.totalTokens = blocks.partial.usage.input + blocks.partial.usage.output;
	}
	finalize(stream, blocks, "stop");
}

/** Build the streamSimple closure. Captures the model catalog + session store
 *  resolved at extension load. When a driver is provided, turns run on the
 *  persistent stream-json engine (config.engine selects; stream remains as
 *  fallback). */
export function createStreamSimple(
	deps: StreamSimpleDeps,
): (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	const { entries, store, roundTrips } = deps;

	return function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();
		// Fire the async turn; return the stream synchronously per pi's contract.
		// Engine selection: the latched load-time engine when the extension
		// provides one, else the per-call config read (tests). One loadConfig()
		// read per turn, shared with the session key below.
		const config = loadConfig();
		const configuredEngine = deps.engine ?? config.engine;
		const { baseId, forcedEngine } = parseModelEngine(model.id);
		const entry = entries.find((e) => e.id === baseId || e.id === model.id) ?? null;
		const agyModel = entry?.full ?? baseId;
		const supportsAcp = isAcpCapableModel(entry ?? agyModel);
		const engine = forcedEngine
			? (forcedEngine === "acp" && supportsAcp ? "acp" : "stream-json")
			: (configuredEngine === "acp" && supportsAcp ? "acp" : "stream-json");
		const selected = engine === "acp" && deps.acpDriver ? deps.acpDriver : deps.driver;
		// Plan-shaped provider turns are fail-closed on BOTH engines. ACP has
		// no plan mode at all (RC01). Stream-json is worse and probed
		// 2026-10-07: the engine WARNS that --mode plan is a no-op while
		// --disable-slash-commands is set, executes file writes even with
		// slash expansion left on (it stages a plan.md and still writes in the
		// same turn), ignores --agent toolset restrictions, and file writes
		// bypass the permission system entirely. A plan-labeled turn here is
		// write-capable, so refuse visibly instead of running false safety.
		if (config.readOnly || config.mode === "plan") {
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			if (config.readOnly) {
				deps.log?.("turn-error", { reason: "readonly-refused" }, "warn");
				finalize(
					stream,
					blocks,
					"error",
					"readOnly cannot be enforced on provider turns: the agy CLI has no review-only enforcement on any path. Plan mode stages a plan and executes the write in the same turn (probed 2026-10-07, google-antigravity/antigravity-cli#1181). Enforce read-only in the host (pi tool restrictions or the approval gate), then /agy readonly off.",
				);
				return stream;
			}
			deps.log?.("turn-error", { reason: "plan-refused" }, "warn");
			finalize(
				stream,
				blocks,
				"error",
				"Plan mode cannot be enforced on provider turns: the agy CLI stages a plan and executes writes in the same turn (probed 2026-10-07, google-antigravity/antigravity-cli#1181), and the ACP engine has no plan mode (RC01). /agy mode accept-edits, and enforce review-only in the host.",
			);
			return stream;
		}
		if (selected && roundTrips) {
			void runTurnDriver(stream, model, context, options, entries, store, {
				driver: selected,
				roundTrips,
				replay: deps.replay,
				nativeActive: deps.nativeActive,
				onNativeEvent: deps.onNativeEvent,
				roster: deps.roster,
				// Record the engine of the driver that will ACTUALLY run: if the
				// ACP driver is absent, the config switch falls back to stream,
				// and keying the session as @acp would store a stream
				// conversationId under the wrong engine scope.
				engine: selected === deps.acpDriver ? "acp" : "stream-json",
				log: deps.log,
			});
		} else {
			// Miswired extension: no driver means no engine. Fail the turn visibly
			// instead of silently producing an empty assistant message.
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			deps.log?.("turn-error", { reason: "driver-not-configured" }, "warn");
			finalize(stream, blocks, "error", "antigravity driver not configured");
		}
		return stream;
	};
}

/** Signal the start of the assistant turn exactly once. `start` is
 *  turn-level (analogous to Anthropic's message_start), not per-block  -  the
 *  per-block signals are text_start / thinking_start. */
function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

/** Append a text delta (opens the block on first use). Module-level so both
 *  engines share it. */
function appendText(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureTextOpen(stream, b);
	textAt(b.partial, b.textIdx!).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx!, delta, partial: b.partial });
}

/** Append a thinking delta (opens the block on first use). */
function appendThinking(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureThinkingOpen(stream, b);
	thinkingAt(b.partial, b.thinkingIdx!).thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: b.thinkingIdx!, delta, partial: b.partial });
}

/** Open the text block, closing the thinking block first if it's open. */
function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

/** Open the thinking block, closing the text block first if it's open. */
function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	stream.push({ type: "text_end", contentIndex: idx, content: textAt(b.partial, idx).text, partial: b.partial });
}

function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx === null) return;
	const idx = b.thinkingIdx;
	b.thinkingIdx = null;
	stream.push({ type: "thinking_end", contentIndex: idx, content: thinkingAt(b.partial, idx).thinking, partial: b.partial });
}

// Typed accessors: AssistantMessage.content is a discriminated union, but we
// always know which slot holds which block (we just pushed it). The cast is
// sound and keeps every mutation site free of scattered `as` expressions.
function textAt(p: AssistantMessage, idx: number): { type: "text"; text: string } {
	return p.content[idx] as { type: "text"; text: string };
}

function thinkingAt(p: AssistantMessage, idx: number): { type: "thinking"; thinking: string } {
	return p.content[idx] as { type: "thinking"; thinking: string };
}

/** Close any open block and push the terminal event. */
function finalize(
	stream: AssistantMessageEventStream,
	b: BlockState,
	reason: "stop" | "error" | "aborted",
	message?: string,
): void {
	closeText(stream, b);
	closeThinking(stream, b);
	if (reason === "stop") {
		b.partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: b.partial });
	} else {
		b.partial.stopReason = reason;
		if (message) b.partial.errorMessage = message;
		stream.push({ type: "error", reason, error: b.partial });
	}
	stream.end();
}
