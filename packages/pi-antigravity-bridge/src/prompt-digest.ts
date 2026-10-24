import type { Message, TranscriptContext } from "@earendil-works/pi-ai";

/** Extract the latest user message as a flat prompt string. agy maintains its
 *  own conversation history via --conversation, so we collapse pi's structured
 *  message to text. Returns null if the last message isn't a user message. */
export function extractUserPrompt(context: TranscriptContext): string | null {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user") return null;
	const content = last.content;
	if (typeof content === "string") return content;
	// Flatten text blocks; images ride separately via extractImages (ACP only).
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim() || null;
}

/** Image blocks of the latest user message (pi-ai ImageContent: base64 data
 *  + mimeType). The ACP engine forwards them as typed content blocks; the
 *  stream-json CLI prompt is text-only, so its driver simply ignores these. */
export function extractImages(context: TranscriptContext): Array<{ data: string; mimeType: string }> {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user" || typeof last.content === "string") return [];
	return last.content
		.filter((b): b is { type: "image"; data: string; mimeType: string } => b.type === "image")
		.map((b) => ({ data: b.data, mimeType: b.mimeType }));
}
// --- G1: pi-side context digest --------------------------------------------------
//
// agy keeps its OWN conversation history (resumed via --conversation), so it
// already holds every turn it produced. What it lacks is pi-side context it was
// never spawned for: pi's compaction summaries and turns handled by OTHER
// providers (or pi's own tools). pi materializes all of that into
// context.messages every turn (verified: session-manager.js -> convertToLlm),
// so we build a DELTA digest from those messages and prepend it to the prompt.
// No pi patch, no new MCP tool. See docs/PI-BRIDGE-GAPS.md (G1).

const COMPACTION_MARKER = "compacted into the following summary";

export const DIGEST_PREAMBLE =
	"[The following is context from the broader pi session that this Antigravity turn was not directly spawned for: compaction summaries and turns handled by other providers or pi's own tools. Your own prior turns are already in your conversation history. Use this for continuity only.]";

// --- pi system prompt (G10) ----------------------------------------------------
//
// pi normalizes the system prompt into the transcript every turn (read via
// getCurrentSystemPrompt): its own operating instructions
// plus every AGENTS.md/CLAUDE.md it loaded (global agent dir first, then
// ancestors). The provider used to drop it, so agy models never saw the user's
// machine-level or project-level instructions. agy has no system-prompt flag
// (verified against `agy --help`), so the only delivery path is the prompt
// text. We prepend it as a delimited block on the FIRST prompt of a fresh
// conversation only: agy keeps its own history, the block stays byte-identical
// afterwards, and agy's server-side prompt cache keeps hitting.

export const SYSTEM_PROMPT_PREAMBLE =
	"[The following is the system prompt of the pi session that spawned this conversation: operating instructions plus project context (AGENTS.md files). Apply it for this whole conversation.]";

export const SYSTEM_PROMPT_END = "[END SYSTEM PROMPT]";

/** Brief tool-priority note appended inside every system prompt block: agy
 *  runs embedded in pi, so its native interactive tools never reach the
 *  user. Equivalent Pi Bridge tools must win. Concrete clashes observed
 *  live: agy picked its native ask_question over the bridge's
 *  ask_user_question and the question never displayed; on ACP its native
 *  view_file rejects real filesystem paths (artifact sandbox), so reads of
 *  the user's machine must go through the bridge. Rides the systemPrompt
 *  gate: the note ships only when the system prompt ships. */
export const TOOL_PRIORITY_NOTE =
	"[Tool priority: this conversation runs inside pi, not as a standalone agy session; the user only sees what surfaces in pi. Native interactive tools, for example ask_question, never reach the user. When a Pi Bridge tool covers the same purpose, always use the Pi Bridge tool; for user questions use ask_user_question. Your native file tools such as view_file only read brain artifacts and reject real filesystem paths; for any path on the user's machine use the Pi Bridge tools (read, ls, grep, find, edit, execute). Delegate subagent work the same way: when pi's tool list includes a delegation tool (for example subagent, Agent, agent_spawn, agent_wait, or subagent_run), always delegate through it and never through the native invoke_subagent, run_subagent, or manage_subagents; use native ones only if no pi delegation tool is listed, because native subagents run inside agy and are invisible to pi and anything watching it. Long-running bridge calls do not fail: after ~20 seconds the bridge answers STILL RUNNING with a callId; fetch the result with bridge_poll_result and poll until it lands. For work you already know is long, prefer exec_command's session-output pattern or background agents so you keep working while it runs.]";

/** Assemble the full agy prompt: system prompt block, pi-side digest, user
 *  prompt. Empty parts are dropped. Pure; exported for unit testing.
 *  Pass systemPrompt only on a fresh conversation (see runTurnDriver). */
export function buildFullPrompt(
	systemPrompt: string | undefined,
	digest: string,
	prompt: string,
): string {
	const parts: string[] = [];
	if (systemPrompt) {
		parts.push(`${SYSTEM_PROMPT_PREAMBLE}\n\n${systemPrompt}\n\n${TOOL_PRIORITY_NOTE}\n\n${SYSTEM_PROMPT_END}`);
	}
	if (digest) {
		parts.push(`${DIGEST_PREAMBLE}\n\n${digest}`);
	}
	if (prompt) {
		parts.push(prompt);
	}
	return parts.join("\n\n---\n\n");
}

/** Flatten any message content shape (string or content-block array) to text.
 *  Drops images, thinking, and tool-call blocks. */
export function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

/** A compaction summary arrives wrapped in pi's boilerplate prefix/suffix.
 *  Return just the summary body. */
function stripCompactionWrapping(t: string): string {
	const open = t.indexOf("<summary>");
	const close = t.lastIndexOf("</summary>");
	if (open >= 0 && close > open) return t.slice(open + "<summary>".length, close).trim();
	return t.trim();
}

export interface DigestOptions {
	/** Provider id whose assistant turns are already in agy's own DB and so
	 *  must be skipped to avoid double-counting. Default "antigravity". */
	ownProvider?: string;
	/** Soft cap on the digest body (0 = unbounded). Default 8000. */
	maxChars?: number;
}

/** Build a delta digest of pi-side context agy was not spawned for: the most
 *  recent compaction summary plus turns since the watermark that were not
 *  produced by this provider. Pure: no I/O. Exported for unit testing.
 *
 *  Delta, not replay: skip our own assistant turns (provider === ownProvider)
 *  and clamp the window to after any compaction (pre-compaction detail is
 *  either already in agy's DB or summarized by the injected summary).
 *
 *  Fidelity note: other-provider assistant turns contribute only their text
 *  blocks; tool-call and thinking blocks are dropped. The intent (which tool)
 *  is lost, but their results still surface separately as toolResult messages. */
export function buildContextDigest(
	messages: Message[],
	watermark: number,
	opts: DigestOptions = {},
): string {
	const own = opts.ownProvider ?? "antigravity";
	const maxChars = opts.maxChars ?? 8000;
	if (messages.length === 0) return "";

	let summaryPart: string | null = null;
	const deltaParts: string[] = [];

	// 1. Most-recent compaction summary (scan the whole list; it is never in
	//    agy's DB, so it is always safe and high-value to inject).
	let lastCompactionIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER)) {
			lastCompactionIdx = i;
			summaryPart = `[pi compaction summary]\n${stripCompactionWrapping(t)}`;
			break;
		}
	}

	// 2. Delta since the watermark, excluding the trailing current prompt.
	//    Clamp start to just after the compaction summary when one is present.
	let start = Math.max(0, Math.floor(watermark));
	if (lastCompactionIdx >= 0) start = Math.max(start, lastCompactionIdx + 1);
	const end = Math.max(0, messages.length - 1);
	for (let i = start; i < end; i++) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (m.provider === own) continue; // our own turn: already in agy's DB
			const t = blocksToText(m.content).trim();
			if (!t) continue;
			deltaParts.push(`[assistant turn from ${m.provider}]\n${t}`);
		} else if (m.role === "user") {
			const t = blocksToText(m.content);
			if (t.includes(COMPACTION_MARKER)) continue; // injected as summaryPart
			if (!t.trim()) continue;
			deltaParts.push(`[earlier user message]\n${t}`);
		} else if (m.role === "toolResult") {
			const t = blocksToText(m.content).trim();
			deltaParts.push(
				`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${t || "(no text output)"}`,
			);
		}
	}

	// Assemble. The compaction summary is always kept intact (it is the
	// canonical compressed history). The DELTA is truncated from the newest end
	// backward when over budget: recent context matters more for continuity
	// than older detail, so drop the oldest delta first. If even the newest
	// single item exceeds the budget, keep its tail slice.
	const SEP = "\n\n";
	const MARKER = "[truncated]";
	let delta = deltaParts.join(SEP);
	if (maxChars > 0) {
		const budget = Math.max(0, maxChars - (summaryPart ? summaryPart.length + SEP.length : 0));
		if (delta.length > budget) {
			const kept: string[] = [];
			let used = 0;
			for (let i = deltaParts.length - 1; i >= 0; i--) {
				const cost = deltaParts[i].length + (kept.length > 0 ? SEP.length : 0);
				if (used + cost > budget) break;
				kept.unshift(deltaParts[i]);
				used += cost;
			}
			if (kept.length > 0) {
				delta = `${MARKER}\n${kept.join(SEP)}`;
			} else {
				const room = Math.max(0, budget - MARKER.length - 1);
				delta = room > 0 ? `${MARKER}\n${deltaParts[deltaParts.length - 1].slice(-room)}` : "";
			}
		}
	}

	return [summaryPart, delta]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(SEP);
}
