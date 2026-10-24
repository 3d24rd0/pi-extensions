import type { Message } from "@earendil-works/pi-ai";
import type { TurnDriver } from "./driver-types.js";
import { GATE_MARKER, mapNativeToShadow, stripMarkerFields } from "./approval-gate.js";
import type { ApprovalDecision, ApprovalPayload, ApprovalParkApi } from "./mcp-server.js";
import { blocksToText } from "./prompt-digest.js";

// --- G9: no-patch pi-tool round-trips -----------------------------------------
//
// The MCP bridge's onToolCall parks the call here instead of executing it:
// the pending call is injected into the live driver turn as a bridge_call
// activity, the provider ends the pi assistant message with stopReason
// "toolUse" for the REAL pi tool, and pi's own loop executes it (native
// cards, permissions, hooks). The toolResult arrives in the NEXT stream
// call's context; resolve() then completes the parked MCP HTTP response and
// agy continues its still-running turn. No pi patch, no privileged API.

export const BRIDGE_TIMEOUT_MS = 480_000;
/** Bounded memory of failed bridge parks (late-delivery tombstones). */
export const MAX_PARK_TOMBSTONES = 64;

/** One MCP tool-result content block: text always; image blocks carry base64
 *  pixels and ride to the model on BOTH engines (ACP probe 2026-09-05;
 *  stream-json probe 2026-09-07: the CLI's MCP client delivers tool-result
 *  image content to the model). */
export interface BridgeContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface BridgeCallResultShape {
	content: BridgeContentBlock[];
	isError: boolean;
}

/** Early-ack sentinel: onToolCall settles with this when the pi tool is still
 *  running after escalateAfterMs (~20s). agy's MCP client abandons a
 *  tools/call HTTP request at ~180s (observed; see ACP-PROTOCOL-REFERENCE), so
 *  slow calls must not hold the request. The bridge answers with
 *  formatEscalatedAck and the real result arrives via bridge_poll_result (or,
 *  if agy never polls, the late-delivery path). */
export interface BridgeEscalation {
	escalated: true;
	callId: string;
	name: string;
}

export const POLL_TOOL_NAME = "bridge_poll_result";

/** Default quiet period before a park escalates to a poll handle. Well under
 *  agy's ~180s request deadline; fast tools never see it. */
export const ESCALATE_AFTER_MS = 20_000;

/** Synchronous window for delegation-shaped tools. pi subagents commonly run
 *  30-120s (issue #6) and orchestrators expect a plain tool result; past this
 *  they escalate to the poll path. The ceiling stays under agy's ~180s
 *  tools/call abandonment, which would kill the request with no result and no
 *  poll handle. */
export const DELEGATION_ESCALATE_MS = 120_000;

/** Names that get the long synchronous window: pi's agent_spawn/agent_wait
 *  family, subagent_run-style tools, *delegate*, and the Claude Code-style
 *  exact name "Agent" (start-anchored stem so incidental agent_ substrings
 *  elsewhere in a name keep the fast ack). Human-gated tools
 *  (ask_user_question) deliberately stay on the fast ack: their poll path is
 *  load-bearing for permission flows. */
const DELEGATION_NAME_RE = /subagent|delegate|^agent(_|$)/i;

/** Per-call escalation threshold. Config can add extra long-running names
 *  (escalateLongTools). */
export function defaultEscalateAfterMs(name: string, extraLongNames: readonly string[] = []): number {
	return DELEGATION_NAME_RE.test(name) || extraLongNames.includes(name) ? DELEGATION_ESCALATE_MS : ESCALATE_AFTER_MS;
}
/** Escalated parks carry a longer TTL: human-gated tools (commit previews,
 *  permission dialogs) legitimately block for many minutes. */
export const ESCALATED_TIMEOUT_MS = 1_800_000;
/** Human-decision budget for one parked approval (docs/TODO.md 2.5). Same
 *  envelope as the G9 park; the staged hook timeout exceeds it with margin
 *  (approval-hook.stagedTimeoutSeconds). Exported: the extension needs the
 *  same number for hooks.json staging and the hook script deadline. */
export const APPROVAL_PARK_MS = BRIDGE_TIMEOUT_MS;

export interface PollView {
	state: "running" | "done" | "failed";
	name: string;
	text?: string;
	isError?: boolean;
	reason?: string;
	images?: Array<{ data: string; mimeType: string }>;
	/** A terminal result the model already received via a poll. Set only by
	 *  markDelivered (the real poll path); poll() stays pure so internal
	 *  peeks (escalatedNames) never mark. */
	delivered?: boolean;
	/** The agy conversation this call belongs to. Stamped at turn end so an
	 *  unpolled result can be re-delivered to the right conversation
	 *  (first-turn parks never reach the provider's store.set). */
	conversationId?: string;
}

/** Escalated bridge calls. Bounded: past the cap, oldest settled entries
 *  evict first (a running call is never evicted while a newer one is). */
export class EscalationRegistry {
	#calls = new Map<string, PollView>();
	#trim(): void {
		// Soft cap: only settled entries evict. Evicting a RUNNING call would
		// strand its result (settle becomes a no-op, poll reports unknown), so
		// saturating the cap with in-flight calls grows the map instead.
		// Delivered entries evict first: an undelivered result still has a
		// recovery path (redelivery), a delivered one only serves late polls.
		while (this.#calls.size > MAX_PARK_TOMBSTONES) {
			const settled = [...this.#calls.entries()].filter(([, e]) => e.state !== "running");
			const victim = (settled.find(([, e]) => e.delivered) ?? settled[0])?.[0];
			if (victim === undefined) break;
			this.#calls.delete(victim);
		}
	}
	escalate(callId: string, name: string): void {
		this.#calls.set(callId, { name, state: "running" });
		this.#trim();
	}
	settleDone(callId: string, text: string, isError: boolean, images: Array<{ data: string; mimeType: string }> = []): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "done";
		e.text = text;
		e.isError = isError;
		if (images.length > 0) e.images = images;
		this.#trim();
	}
	settleFailed(callId: string, reason: string): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "failed";
		e.reason = reason;
		this.#trim();
	}
	poll(callId: string): PollView | undefined {
		const e = this.#calls.get(callId);
		return e ? { ...e } : undefined;
	}

	/** Record that the model received this terminal result (the real poll
	 *  path calls this when the view is not running). Running entries and
	 *  unknown ids are a no-op. */
	markDelivered(callId: string): boolean {
		const e = this.#calls.get(callId);
		if (!e || e.state === "running") return false;
		e.delivered = true;
		return true;
	}

	/** Single-use claim of a done-but-undelivered result: returns the view
	 *  and marks it delivered in one step, so a later pass can never deliver
	 *  it twice. The entry stays pollable for a late model poll. Failed
	 *  escalations are excluded: their pending entry is gone, so the
	 *  tombstone path is their single delivery channel. */
	claimUndelivered(callId: string): (PollView & { callId: string }) | undefined {
		const e = this.#calls.get(callId);
		if (!e || e.state !== "done" || e.delivered) return undefined;
		e.delivered = true;
		return { ...e, callId };
	}

	/** Registry-wide sweep: claim every done-but-undelivered result. A
	 *  toolResult is consumed by its own pass (resolve deletes the pending
	 *  entry), so a strand that survives its first pass can only be found
	 *  here, not in a later pass's results. Failed escalations stay with the
	 *  tombstone path. */
	claimAllUndelivered(): Array<PollView & { callId: string }> {
		const out: Array<PollView & { callId: string }> = [];
		for (const [callId, e] of this.#calls) {
			const claimed = e.state === "done" && !e.delivered ? { ...e, callId } : undefined;
			if (claimed) {
				e.delivered = true;
				out.push(claimed);
			}
		}
		return out;
	}

	/** Release a claim whose delivery failed to start (driver.run threw): the
	 *  result returns to the undelivered pool for the next recovery pass. */
	unclaim(callId: string): void {
		const e = this.#calls.get(callId);
		if (e && e.state === "done") e.delivered = false;
	}

	/** Stamp every running escalation with the ended turn's conversation id
	 *  (extensions fire this from onTurnEnd). First stamp wins: the ended
	 *  turn is the conversation the call was made in; a later turn-end (the
	 *  call can outlive several turns while a human answers) must not
	 *  re-route the delivery. Entries that escalate later stay unstamped. */
	stampConversation(conversationId: string): void {
		for (const e of this.#calls.values()) {
			if (e.state === "running") e.conversationId ??= conversationId;
		}
	}
}

export function formatEscalatedAck(e: BridgeEscalation): BridgeCallResultShape {
	return {
		content: [
			{
				type: "text",
				text: [
					`STILL RUNNING: the pi tool "${e.name}" has not finished yet.`,
					`Call ${POLL_TOOL_NAME} with callId "${e.callId}" to get the result. Poll again if it still reports running; you may do other work between polls.`,
					"Do NOT end your turn while this call is unresolved: keep polling until it reports done or failed. Ending the turn strands the result.",
				].join("\n"),
			},
		],
		isError: false,
	};
}

export function formatPollAnswer(callId: string, view: PollView | undefined): BridgeCallResultShape {
	if (!view) {
		return {
			content: [
				{
					type: "text",
					text: `Error: no escalated bridge call "${callId}". It either finished within the first seconds (its result is in your original tool result) or the callId is wrong.`,
				},
			],
			isError: true,
		};
	}
	if (view.state === "running") {
		return {
			content: [{ type: "text", text: `STILL RUNNING: "${view.name}" (callId ${callId}) has not finished. Poll again later.` }],
			isError: false,
		};
	}
	if (view.state === "failed") {
		return {
			content: [{ type: "text", text: `Error: bridge call "${view.name}" (callId ${callId}) failed: ${view.reason}` }],
			isError: true,
		};
	}
	return {
		content: [
			...(view.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
			{ type: "text", text: view.text || "(no output)" },
		],
		isError: view.isError ?? false,
	};
}

export interface PendingRoundTrip {
	/** "bridge": parked MCP HTTP call; resolve() completes it.
	 *  "rt": native re-exec / wrapper round-trip; pi already executed, the
	 *  toolResult only confirms continuation, nothing remote to settle.
	 *  "approval": parked approval gate decision; resolve() maps the shadow
	 *  tool result to allow/deny and completes the /approval ticket. */
	kind: "bridge" | "rt" | "approval";
	name: string;
	/** Approval entries only: the agy native tool this decision is for. */
	nativeName?: string;
	/** Approval entries only: park start, for the latency audit field. */
	started?: number;
	resolve?: (r: BridgeCallResultShape | BridgeEscalation) => void;
	reject?: (e: Error) => void;
	timer?: NodeJS.Timeout;
	/** Set when the early-ack fired: the HTTP request was answered with a poll
	 *  handle, so the settling value must go to the registry, not the socket. */
	escalated?: boolean;
	escalateTimer?: NodeJS.Timeout;
	onAbort?: () => void;
	signal?: AbortSignal;
}

/** Replay store for the display-only `antigravity` wrapper tool. The
 *  provider records each mutating agy step's output before emitting the
 *  toolUse; the wrapper tool's execute() returns it, so pi renders a real
 *  toolCall/toolResult pair without re-running anything. */
export class WrapperReplay {
	#map = new Map<string, string>();
	set(key: string, output: string): void {
		this.#map.set(key, output);
	}
	get(key: string): string | undefined {
		return this.#map.get(key);
	}
	/** Single-use consume: wrapper execute() takes the entry so stale outputs
	 *  cannot be enumerated by later callers and the map cannot grow unbounded. */
	take(key: string): string | undefined {
		const v = this.#map.get(key);
		this.#map.delete(key);
		return v;
	}
	get size(): number {
		return this.#map.size;
	}
}

export interface ToolRoundTripsOptions {
	escalateAfterMs?: number | ((name: string) => number);
}

export class ToolRoundTrips {
	#pending = new Map<string, PendingRoundTrip>();
	/** Failed bridge parks: the pi tool keeps running and its toolResult will
	 *  arrive with the park already gone. Bounded; consumed by the
	 *  late-delivery path (see buildLateResultPrompt). */
	#dead = new Map<string, { name: string; reason: string }>();
	#escalations = new EscalationRegistry();
	#escalateAfterMs: number | ((name: string) => number);
	#getDriver: () => TurnDriver;
	#log: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
	/** Approval park controls (mcp-server handle). Assigned by the extension
	 *  only after at least one shadow tool is registered, so an approval
	 *  toolUse can never dispatch to the REAL builtin and execute locally. */
	#approvalPark?: ApprovalParkApi;

	/** Accepts a driver or a getter: with two engines wired, the ACTIVE driver
	 *  is resolved at call time from config (plan §9.5). */
	constructor(
		driver: TurnDriver | (() => TurnDriver),
		log?: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void,
		opts: ToolRoundTripsOptions = {},
	) {
		this.#getDriver = typeof driver === "function" ? driver : () => driver;
		this.#log = log ?? (() => {});
		this.#escalateAfterMs = opts.escalateAfterMs ?? defaultEscalateAfterMs;
	}

	get pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	/** Call ids whose park already failed (tombstones). */
	get deadIds(): string[] {
		return [...this.#dead.keys()];
	}

	/** Take and clear the tombstone for a failed park, if any. */
	consumeDead(toolCallId: string): { name: string; reason: string } | undefined {
		const dead = this.#dead.get(toolCallId);
		if (!dead) return undefined;
		this.#dead.delete(toolCallId);
		return dead;
	}

	/** Poll view for an escalated call (undefined when the id never escalated:
	 *  fast calls settle synchronously and need no handle). */
	poll(callId: string): PollView | undefined {
		return this.#escalations.poll(callId);
	}

	/** Mark a terminal escalated result as received by the model. Only the
	 *  real poll path (extensions) calls this; poll() stays pure. */
	markDelivered(callId: string): boolean {
		return this.#escalations.markDelivered(callId);
	}

	/** Single-use claim of a settled-but-undelivered escalated result (the
	 *  model ended its turn instead of polling). */
	claimUndelivered(callId: string): (PollView & { callId: string }) | undefined {
		return this.#escalations.claimUndelivered(callId);
	}

	/** Registry-wide sweep for done-but-undelivered results: a toolResult is
	 *  consumed by its own pass, so multi-pass strands are only findable
	 *  here. */
	claimAllUndelivered(): Array<PollView & { callId: string }> {
		return this.#escalations.claimAllUndelivered();
	}

	/** Release a claim whose delivery failed to start. */
	unclaim(callId: string): void {
		this.#escalations.unclaim(callId);
	}

	/** Stamp running escalations with the ended turn's conversation id so an
	 *  unpolled result can be re-delivered to the right conversation. */
	stampConversation(conversationId: string): void {
		this.#escalations.stampConversation(conversationId);
	}

	/** Wire the approval park (mcp-server handle.approvals). The extension
	 *  assigns this AFTER the shadow tools are registered; see onApproval. */
	set approvalPark(api: ApprovalParkApi | undefined) {
		this.#approvalPark = api;
	}

	/** Approval gate (docs/TODO.md 2.5): a PreToolUse hook parked a native agy
	 *  tool call. Interrupt the pi-side view of the still-running agy turn
	 *  with a toolUse for the SHADOW tool (same bridge_call mechanism as G9,
	 *  so both drivers pause their turn timers); pi's permission extensions
	 *  gate it, the shadow execute() consults the fallback policy, and the
	 *  arriving toolResult maps to the terminal decision (resolve()).
	 *  Every failure path denies fail-closed: an approval must never be
	 *  granted by accident. */
	onApproval(ticket: string, payload: ApprovalPayload): void {
		const deny = (reason: string): void => {
			this.#log("approval-denied-pre-park", { ticket, reason });
			this.#approvalPark?.resolve(ticket, { allow: false, reason });
		};
		if (!this.#approvalPark) return deny("shadow tools are not registered");
		const native = payload?.toolCall?.name;
		if (typeof native !== "string" || native.length === 0) return deny("approval payload has no tool name");
		const handle = this.#getDriver().activeHandle;
		if (!handle) return deny("no active antigravity turn");
		const args = (payload.toolCall.args && typeof payload.toolCall.args === "object"
			? payload.toolCall.args
			: {}) as Record<string, unknown>;
		const mapped = mapNativeToShadow(native, args);
		if (!mapped) return deny(`tool ${native} is not in the approval matcher set`);
		const entry: PendingRoundTrip = {
			kind: "approval",
			name: mapped.shadow,
			nativeName: native,
			started: Date.now(),
			timer: setTimeout(() => {
				this.#failApproval(
					ticket,
					`approval gate timed out after ${Math.round(APPROVAL_PARK_MS / 1000)}s`,
					"timeout",
				);
			}, APPROVAL_PARK_MS),
		};
		this.#pending.set(ticket, entry);
		handle.pushExternal({
			type: "bridge_call",
			callId: ticket,
			name: mapped.shadow,
			args: {
				...mapped.input,
				[GATE_MARKER]: true,
				__agyTicket: ticket,
				__agyTool: native,
			},
		});
		this.#log("approval-parked", { ticket, native, shadow: mapped.shadow });
	}

	/** Settle a parked approval with a deny. Used by the park timeout and
	 *  failAll; the ticket is answered (fail closed) and the pending entry
	 *  dropped, so the late shadow tool result logs as approval-late. */
	#failApproval(ticket: string, reason: string, cause: "timeout" | "shutdown"): void {
		const entry = this.#pending.get(ticket);
		this.#pending.delete(ticket);
		if (entry?.timer) clearTimeout(entry.timer);
		const resolved = this.#approvalPark?.resolve(ticket, { allow: false, reason }) ?? false;
		this.#log(
			resolved ? `approval-${cause}` : "approval-late",
			{ ticket, native: entry?.nativeName, shadow: entry?.name, reason },
			resolved && cause === "timeout" ? "warn" : "debug",
		);
		this.#getDriver().kickIdle();
	}

	/** Fail all pending calls (driver recycle/shutdown path). Escalated bridge
	 *  calls are skipped: their HTTP request was already answered with a poll
	 *  handle, and the agy turn ending does NOT make the still-running pi tool
	 *  a failure. They settle through resolve(), their own 30m timer, or an
	 *  abort signal on the pi tool call. */
	failAll(reason: string): void {
		for (const id of [...this.#pending.keys()]) {
			const entry = this.#pending.get(id);
			if (entry?.kind === "approval") {
				this.#failApproval(id, reason, "shutdown");
				continue;
			}
			if (entry?.kind === "bridge" && entry.escalated) continue;
			this.#fail(id, reason);
		}
	}

	#fail(callId: string, reason: string): void {
		const entry = this.#pending.get(callId);
		if (!entry) return;
		if (entry.kind === "rt") {
			// Nothing to reject, but the entry must not leak past turn death.
			this.#pending.delete(callId);
			return;
		}
		this.#pending.delete(callId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		this.#dead.set(callId, { name: entry.name, reason });
		while (this.#dead.size > MAX_PARK_TOMBSTONES) {
			const oldest = this.#dead.keys().next().value;
			if (oldest === undefined) break;
			this.#dead.delete(oldest);
		}
		if (entry.escalated) this.#escalations.settleFailed(callId, reason);
		entry.reject!(new Error(reason));
		this.#getDriver().kickIdle();
		this.#log("round-trip-fail", { callId, name: entry.name, reason });
	}

	/** Park the MCP call: inject into the live agy turn. Fast calls settle
	 *  with the real BridgeCallResultShape. Calls still running after
	 *  escalateAfterMs settle with a BridgeEscalation sentinel instead: the
	 *  bridge answers the HTTP request with a poll handle while pi keeps
	 *  executing, so agy's ~180s request deadline is never hit. The real
	 *  result reaches agy via bridge_poll_result, or via the late-delivery
	 *  path if agy never polls. Fail-closed: timeout/abort still reject. */
	onToolCall = (
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<BridgeCallResultShape | BridgeEscalation> => {
		const handle = this.#getDriver().activeHandle;
		if (!handle) {
			return Promise.reject(
				new Error(
					"no active antigravity turn; the pi tool bridge only works while an antigravity model is streaming",
				),
			);
		}
		return new Promise<BridgeCallResultShape | BridgeEscalation>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#fail(callId, `pi tool round-trip timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`);
			}, BRIDGE_TIMEOUT_MS);
			const onAbort = () => this.#fail(callId, "agy disconnected before the tool result arrived");
			signal.addEventListener("abort", onAbort, { once: true });
			const entry: PendingRoundTrip = { kind: "bridge", name, resolve, reject, timer, onAbort, signal };
			const escalateAfterMs = typeof this.#escalateAfterMs === "function" ? this.#escalateAfterMs(name) : this.#escalateAfterMs;
			if (escalateAfterMs > 0) {
				entry.escalateTimer = setTimeout(() => {
					const e = this.#pending.get(callId);
					// Resolved (or failed) between arm and fire: nothing to escalate.
					if (!e || e.kind !== "bridge") return;
					e.escalated = true;
					// Human-gated calls (commit previews, permission dialogs) can
					// block far longer than the standard park TTL; re-arm generously.
					if (e.timer) {
						clearTimeout(e.timer);
						e.timer = setTimeout(() => {
							this.#fail(callId, `escalated bridge call timed out after ${ESCALATED_TIMEOUT_MS / 60_000} minutes`);
						}, ESCALATED_TIMEOUT_MS);
					}
					this.#escalations.escalate(callId, e.name);
					resolve({ escalated: true, callId, name: e.name });
				}, escalateAfterMs);
			}
			this.#pending.set(callId, entry);
			// Strip the internal marker fields from model-supplied args (peer
			// review 2026-09-07): a real bridge call must never arrive at the
			// shadow's gate branch with a forged __agyGate/__agyTicket.
			handle.pushExternal({ type: "bridge_call", callId, name, args: stripMarkerFields(args) });
		});
	};

	/** Track a native re-exec or wrapper round-trip: pi executes the tool in
	 *  its own loop; the arriving toolResult only confirms continuation. */
	track(id: string, name: string): void {
		this.#pending.set(id, { kind: "rt", name });
	}

	/** Complete a parked call from a pi toolResult message. Returns false when
	 *  the id matches nothing pending. Image blocks ride the result on both
	 *  engines (probe-verified on each); the late-delivery prompt stays
	 *  text-only (see PI-BRIDGE-GAPS). */
	resolve(
		toolCallId: string,
		text: string,
		isError: boolean,
		images: Array<{ data: string; mimeType: string }> = [],
	): boolean {
		const entry = this.#pending.get(toolCallId);
		if (!entry) return false;
		this.#pending.delete(toolCallId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
		if (entry.kind === "rt") {
			this.#log("round-trip-rt-done", { callId: toolCallId, name: entry.name, isError });
			return true;
		}
		if (entry.kind === "approval") {
			clearTimeout(entry.timer);
			this.#pending.delete(toolCallId);
			// Decision mapping (docs/TODO.md 2.5): block/error -> deny with the
			// text (pi turns a tool_call block into an error tool result, so both
			// paths land here); synthetic success -> allow.
			const decision: ApprovalDecision = isError
				? { allow: false, reason: text || `blocked by approval gate (${entry.nativeName})` }
				: { allow: true };
			const delivered = this.#approvalPark?.resolve(toolCallId, decision) ?? false;
			// Audit trail (docs/TODO.md 2.7): decision, source, latency.
			this.#log(
				delivered ? "approval-decision" : "approval-late",
				{
					ticket: toolCallId,
					native: entry.nativeName,
					shadow: entry.name,
					decision: decision.allow ? "allow" : "deny",
					source: isError ? "extension-block" : "policy",
					reason: decision.allow ? undefined : decision.reason,
					latencyMs: Date.now() - (entry.started ?? 0),
				},
				delivered ? "info" : "debug",
			);
			this.#getDriver().kickIdle();
			return true;
		}
		// Escalated call: the HTTP response already carried the poll handle, so
		// the result lands in the registry for the next bridge_poll_result. The
		// original promise settled with the sentinel; re-resolving is a silent
		// no-op, so gate it to keep that explicit.
		if (entry.escalated) {
			this.#escalations.settleDone(toolCallId, text, isError, images);
		} else {
			entry.resolve!({
				content: [
					...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
					{ type: "text", text },
				],
				isError,
			});
		}
		this.#getDriver().kickIdle();
		this.#log("round-trip-resolved", { callId: toolCallId, name: entry.name, isError });
		return true;
	}
}

/** Image blocks of a tool result (pi's read on an image file, screenshots).
 *  Forwarded to agy as MCP image content (see BridgeContentBlock) on both
 *  engines. Size relies on pi's own inline-image resize cap upstream; no
 *  second cap here. */
export function extractResultImages(content: unknown): Array<{ data: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is { type: "image"; data: string; mimeType: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "image",
		)
		.map((b) => ({ data: b.data, mimeType: b.mimeType }))
		.filter((i) => typeof i.mimeType === "string" && typeof i.data === "string" && i.data.length > 0);
}

/** Extract toolResult messages whose toolCallId is still parked, as text plus
 *  any image blocks (forwarded as MCP image content on both engines). */
export function collectToolResults(
	messages: Message[],
	pendingIds: readonly string[],
): Array<{ toolCallId: string; text: string; isError: boolean; images: Array<{ data: string; mimeType: string }> }> {
	if (pendingIds.length === 0) return [];
	const pending = new Set(pendingIds);
	const out: Array<{ toolCallId: string; text: string; isError: boolean; images: Array<{ data: string; mimeType: string }> }> = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const id = (m as { toolCallId?: string }).toolCallId;
		if (!id || !pending.has(id)) continue;
		out.push({
			toolCallId: id,
			text: blocksToText(m.content).trim(),
			isError: m.isError === true,
			images: extractResultImages(m.content),
		});
	}
	return out;
}

export interface LateToolResult {
	/** Escalated results only: the registry callId, so a failed delivery can
	 *  unclaim it. Tombstone-borne results have none (already consumed). */
	callId?: string;
	name: string;
	reason: string;
	text: string;
	isError: boolean;
}

/** Frame late tool results so agy treats them as the results its bridge calls
 *  never received: a park whose round-trip died while the pi tool ran, or an
 *  escalated result the model never polled. The reason carries the framing. */
export function buildLateResultPrompt(late: LateToolResult[], userPrompt?: string): string {
	const blocks = late.map((r) =>
		[
			`pi tool "${r.name}": ${r.reason}.`,
			r.isError ? "The tool reported an error:" : "Result:",
			r.text.trim() || "(no output)",
		].join("\n"),
	);
	const header = "Late tool delivery: treat the following as the results of your earlier tool calls.";
	const body = [header, ...blocks].join("\n\n");
	return userPrompt ? `${body}\n\n${userPrompt}` : body;
}
