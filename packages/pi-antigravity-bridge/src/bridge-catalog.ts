import type { BridgeTools } from "./config.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { source?: string };
}

/** Prefixes of tools that are strictly for Pi's orchestrator or review harness and must never be bridged into agy. */
const EXCLUDED_PREFIXES = ["orchestrator_", "gentle_review"] as const;

/** Exact tool names that must never be bridged into agy:
 *  1. Bridge-internal / recursive tools (AskAntigravity, web tools, activate_skill, etc.).
 *  2. Pi harness lifecycle tools (gentle_odd_phase, session_worktree_register).
 *  3. Administrative memory tools that agy has no business calling. */
const EXCLUDED_EXACT = new Set([
	// Self / recursive wrappers
	"AskAntigravity",
	"antigravity",
	"agy_web_search",
	"agy_read_url",
	"bridge_poll_result",
	"activate_skill",
	// Pi orchestrator lifecycle
	"gentle_odd_phase",
	"session_worktree_register",
	// Admin memory tools (keep mem_search, mem_save, mem_update, mem_context, mem_session_summary, mem_get_observation, mem_current_project)
	"mem_doctor",
	"mem_judge",
	"mem_compare",
	"mem_pin",
	"mem_unpin",
	"mem_timeline",
	"mem_stats",
	"mem_session_start",
	"mem_session_end",
	"mem_capture_passive",
	"mem_review",
	"mem_list_projects",
]);

export function isExcludedBridgeTool(name: string): boolean {
	if (EXCLUDED_EXACT.has(name)) return true;
	for (const prefix of EXCLUDED_PREFIXES) {
		if (name.startsWith(prefix)) return true;
	}
	return false;
}

/** The bridge has one live HTTP endpoint. Catalog and dispatch must both use
 * the CURRENT Pi active set: /mcp and pi.setActiveTools() can change it mid-session.
 * A stale tools/call must not bypass a disabled Pi tool. */
export function bridgedPiTools(
	all: BridgeToolInfo[], active: readonly string[], mode: BridgeTools, hidden: ReadonlySet<string>,
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter((tool) =>
		enabled.has(tool.name) && !hidden.has(tool.name) &&
		!isExcludedBridgeTool(tool.name) &&
		(mode === "mcp"
			? /pi-mcp-adapter/.test(tool.sourceInfo?.source ?? "")
			: tool.sourceInfo?.source !== "builtin"),
	);
}
