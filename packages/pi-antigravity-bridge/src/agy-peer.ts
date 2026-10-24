/**
 * Antigravity (agy) CLI peer adapter: the agy-specific domain knowledge
 * used by pi-antigravity-bridge's ask-tool.
 *
 * Scope: the `agy models` line grammar, tiered alias resolution, plan-mode
 * prompt guards, argv construction for `agy -p`, the SQLite conversation-id
 * discovery technique, version comparison, and wall-clock time-budget notices.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Constants & Limits -----------------------------------------------------

/** setTimeout's hard ceiling: Node clamps anything above 2^31-1 ms to 1ms,
 * which would kill the peer instantly. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** The same ceiling expressed in minutes for callers that think in minutes. */
export const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);

// --- Version compare & Time budget ------------------------------------------

/**
 * Descending numeric version compare. "5.10" > "5.9" (lexical sort would
 * wrongly rank "5.9" higher because '9' > '1'). Callers pass numeric dotted
 * segments only ("6.1"), never full model slugs.
 */
export function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
}

/**
 * Tell a spawned peer its wall-clock budget so it can pace toward a complete
 * answer instead of being killed mid-task by the watchdog. Models have no
 * clock, so this buys scope pacing, not timekeeping. Magnitude-based:
 * sub-two-minute budgets get a direct-answer framing (read-only consults),
 * longer ones get the complete-answer-or-subset framing. Empty for absent
 * caps and anything under one second, which the watchdog would turn into an
 * instant kill - callers guard those separately.
 */
export function buildTimeBudgetNotice(timeoutMs: number): string {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return "";
	if (timeoutMs < 1000) {
		return "";
	}
	if (timeoutMs < 120_000) {
		const sec = Math.floor(timeoutMs / 1000);
		return `[TIME BUDGET] You have about ${sec} ${sec === 1 ? "second" : "seconds"}. The run is terminated at the limit and you may be cut off mid-task. Provide a direct, concise final answer immediately.`;
	}
	const min = Math.floor(timeoutMs / 60_000);
	return `[TIME BUDGET] You have about ${min} minutes of wall-clock time. The run is terminated at the limit and you may be cut off mid-task. Deliver a complete final answer before it; if the task cannot fit, deliver the most valuable complete subset and state what remains.`;
}

// --- Types -----------------------------------------------------------------

export type ThinkingTier = "low" | "medium" | "high";
export type Family = "flash" | "argon" | "other";

export interface ModelEntry {
	full: string; // exact agy slug, e.g. "gemini-3.6-flash-medium"
	family: Family;
	version: string | null; // "3.6" or "4"
	tier: ThinkingTier | null;
}

/** Argv-facing model resolution: the exact --model slug plus an optional
 *  --effort tier. Gemini bases split the tier out (the base slug alone is
 *  invalid without --effort); fixed-thinking families keep agy's exact slug
 *  and carry no effort. */
export interface ResolvedModel {
	model: string;
	effort?: ThinkingTier;
}

export type Mode = "plan" | "accept-edits";

/** Per-family fallback tier when none is specified and no config default.
 *  Flash and Argon both ship low/medium/high and default to medium. */
export const FAMILY_DEFAULT_TIER: Record<Family, ThinkingTier> = {
	flash: "medium",
	argon: "medium",
	other: "medium",
};

export const TIER_RANK: Record<ThinkingTier, number> = { low: 0, medium: 1, high: 2 };

/** pi thinking-level vocabulary -> agy tier, for the thinking/effort tool
 *  params. Unknown values fall to low (agy always thinks something). */
export function levelToTier(level: string): ThinkingTier {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return "high";
		default:
			return "low";
	}
}

// --- Model catalog ----------------------------------------------------------

// Static alias overlay for non-Gemini models agy may or may not surface in
// `agy models` depending on plan. When the live catalog contains an entry
// whose full string equals the overlay target, the live entry wins. When it
// does not (older agy, missing model, plan gate), the overlay entry resolves
// the alias so the user can still type "sonnet" and get a working answer.
//   "sonnet"   -> claude-sonnet-5-5 (tiered low/medium/high like Gemini)
//   "opus"     -> claude-opus-5-5 (tiered low/medium/high like Gemini)
const STATIC_ALIAS_OVERLAY: ReadonlyArray<ModelEntry> = [
	{ full: "claude-sonnet-5-5-low", family: "other", version: null, tier: "low" },
	{ full: "claude-sonnet-5-5-medium", family: "other", version: null, tier: "medium" },
	{ full: "claude-sonnet-5-5-high", family: "other", version: null, tier: "high" },
	{ full: "claude-opus-5-5-low", family: "other", version: null, tier: "low" },
	{ full: "claude-opus-5-5-medium", family: "other", version: null, tier: "medium" },
	{ full: "claude-opus-5-5-high", family: "other", version: null, tier: "high" },
];

// Short alias → overlay full string. Used by resolveModel to recognize
// friendly short names ("sonnet") that the family-parser (flash/argon) does
// not match. The overlay entries are also merged into the live catalog for
// exact-string passthrough, so this map only needs to cover the short names.
const STATIC_SHORT_ALIAS: ReadonlyMap<string, string> = new Map([
	["sonnet", "claude-sonnet-5-5"],
	["opus", "claude-opus-5-5"],
]);

/** Filter catalog entries if needed. Preserved for pipeline compatibility. */
export function filterHiddenModels(entries: ModelEntry[]): ModelEntry[] {
	return entries;
}

/** Merge the live catalog with the static alias overlay. Live entries win on
 *  case-insensitive full-string equality so an updated `agy models` listing
 *  always takes precedence over the hardcoded fallback. */
export function mergeCatalog(live: ModelEntry[]): ModelEntry[] {
	const seen = new Set(live.map((e) => e.full.toLowerCase()));
	const merged = [...live];
	for (const entry of STATIC_ALIAS_OVERLAY) {
		if (!seen.has(entry.full.toLowerCase())) merged.push(entry);
	}
	return merged;
}

/** Parse one `agy models` line into a structured entry. */
export function parseModelLine(line: string): ModelEntry | null {
	// agy prints TWO columns: "<slug>  <display label>". --model takes only the
	// slug (col 1), so split it off; the label is display-only. A bare-slug line
	// (no whitespace) splits to itself.
	const full = line.trim().split(/\s+/)[0] ?? "";
	if (!full) return null;

	const lower = full.toLowerCase();
	const family: Family = lower.includes("flash")
		? "flash"
		: lower.includes("argon")
			? "argon"
			: "other";

	const versionMatch = lower.startsWith("gemini-") ? lower.match(/(\d+(?:\.\d+)?)/) : lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;

	const tierMatch = lower.match(/-(low|medium|high)$/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	return { full, family, version, tier };
}

/** Pick the available tier closest in rank to the preferred one. Distance
 *  ties (e.g. Low/High around Medium) break toward the higher tier so
 *  "latest and greatest" wins when a family lacks the requested tier. */
function nearestTier(available: ThinkingTier[], preferred: ThinkingTier): ThinkingTier {
	if (available.includes(preferred)) return preferred;
	const sorted = [...available].sort((a, b) => {
		const da = Math.abs(TIER_RANK[a] - TIER_RANK[preferred]);
		const db = Math.abs(TIER_RANK[b] - TIER_RANK[preferred]);
		return da !== db ? da - db : TIER_RANK[b] - TIER_RANK[a];
	});
	return sorted[0] ?? preferred;
}

/** Build the argv-facing resolution from a picked catalog entry. Gemini and
 *  Claude bases (slugs starting "gemini-"/"claude-") accept a separate
 *  --effort, so split the tier suffix out of the slug: the base alone
 *  (claude-sonnet-5-5) is what --model wants, and the tier goes to --effort
 *  (agy rejects a bare base: "requires --effort"). Only unverified families
 *  keep agy's exact slug whole, so an unknown suffix can never trigger an
 *  unsupported --effort. */
function toResolved(full: string, tier: ThinkingTier | null): ResolvedModel {
	if (tier && /^(gemini|claude)-/.test(full.toLowerCase())) {
		return { model: full.replace(/-(low|medium|high)$/, ""), effort: tier };
	}
	return { model: full };
}

/** Resolve a tiered base id - a short-alias target ("claude-sonnet-5-5") or a
 *  bare base slug the provider itself advertises - to the catalog variant
 *  nearest the requested tier. A bare base alone is invalid upstream
 *  ("requires --effort"), so the pick always rides the split in toResolved;
 *  with no variants in the catalog, the overlay/exact entry or the raw base
 *  passes through unchanged. */
function resolveTieredBase(
	base: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
	preferredTier: ThinkingTier | undefined,
): ResolvedModel {
	const needle = base.toLowerCase();
	const variants = entries.filter((e) => e.full.toLowerCase().startsWith(`${needle}-`));
	if (variants.length > 0) {
		const tiers = variants.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null);
		const preferred =
			preferredTier ??
			(tiers.includes(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER.other);
		const chosen = nearestTier(tiers, preferred);
		const picked = variants.find((e) => e.tier === chosen) ?? variants[0];
		return toResolved(picked.full, picked.tier);
	}
	const fromCatalog = entries.find((e) => e.full.toLowerCase() === needle);
	return toResolved(fromCatalog?.full ?? base, fromCatalog?.tier ?? null);
}

/**
 * Resolve a friendly alias / partial name to an argv-facing {model, effort?}.
 * Returns null only when the family is unrecognized; the caller then passes
 * the raw input straight to agy.
 */
export function resolveAgyModel(
	input: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
	/** Explicit thinking param (thinking/effort). Beats a tier embedded in
	 *  the alias ("flash high") and the configured default; clamped to the
	 *  family's real tiers, ignored for fixed-thinking families. */
	preferredTier?: ThinkingTier,
): ResolvedModel | null {
	const lower = input.toLowerCase().trim();

	// 1. Exact full-string match (case-insensitive).
	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return toResolved(exact.full, exact.tier);

	// 1b. Static short alias ("sonnet" / "opus").
	if (STATIC_SHORT_ALIAS.has(lower)) {
		return resolveTieredBase(
			STATIC_SHORT_ALIAS.get(lower) as string,
			entries,
			defaultThinking,
			preferredTier,
		);
	}

	// 2. Parse the alias.
	let family: Family | null = lower.includes("flash")
		? "flash"
		: lower.includes("argon")
			? "argon"
			: null;
	const versionMatch = lower.match(/(\d+(?:\.\d+)?)/);
	const version = versionMatch ? versionMatch[1] : null;
	const tierMatch = lower.match(/\b(low|medium|high)\b/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	// "gemini" alone, "default", or empty -> default family (flash).
	if (!family && (/gemini/.test(lower) || lower === "" || lower === "default")) {
		family = "flash";
	}
	if (!family) {
		if (
			entries.some((e) => e.full.toLowerCase().startsWith(`${lower}-`)) ||
			entries.some((e) => e.full.toLowerCase() === lower)
		) {
			return resolveTieredBase(lower, entries, defaultThinking, preferredTier);
		}
		return null; // unknown family -> let agy handle it
	}

	// 3. Filter by family.
	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) return null;

	// 4. Pin version if specified; otherwise pick the HIGHEST version.
	if (version) {
		const versioned = candidates.filter((e) => e.version === version);
		if (versioned.length > 0) candidates = versioned;
	} else {
		const aliases = candidates.filter((e) => e.version === null);
		if (aliases.length > 0) {
			candidates = aliases;
		} else {
			const versions = candidates
				.map((e) => e.version)
				.filter((v): v is string => v !== null)
				.sort(compareVersionsDesc);
			if (versions.length > 0) {
				const top = versions[0];
				const latest = candidates.filter((e) => e.version === top);
				if (latest.length > 0) candidates = latest;
			}
		}
	}

	// 5. Pick tier: explicit > config default (if the family offers it) >
	//    family default.
	const familyTiers = new Set(
		candidates.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null),
	);
	if (familyTiers.size === 0) return toResolved(candidates[0].full, null);

	const preferred =
		preferredTier ??
		tier ??
		(familyTiers.has(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER[family]);
	const chosenTier = nearestTier([...familyTiers], preferred);
	const picked = candidates.find((e) => e.tier === chosenTier) ?? candidates[0];
	return toResolved(picked.full, picked.tier);
}

// --- Prompt assembly -------------------------------------------------------

export const PLAN_HEADLESS_GUARD = [
	"",
	"--- Headless session constraints ---",
	"- Do not run shell commands. Command execution is denied in this session, and any attempt ends the session immediately with no answer.",
	"- Work only from the material provided in this prompt.",
	"- If information you need is missing, state exactly what is missing in your answer instead of trying to fetch it.",
].join("\n");

export const AGENT_REVIEW_GUARD = [
	"",
	"--- Review constraints ---",
	"- Read-only review. Do not create, modify, or delete any files, including through shell commands (no redirects, tee, rm, mv, git commit).",
	"- Prefer the staged material and view_file for reading. If you run a read-only command (git log, git diff, rg, ls) and it comes back denied, the run ends without an answer: state what you could not check instead of retrying commands.",
	"- Work from the material provided in this prompt; if information you need is missing, state exactly what is missing in your answer.",
].join("\n");

export function buildFinalPrompt(
	prompt: string,
	mode: Mode,
	digest: boolean,
	agentDamper = false,
): string {
	let out = digest ? `(Use compact digests, not full file contents.)\n${prompt}` : prompt;
	if (mode === "plan") out += agentDamper ? AGENT_REVIEW_GUARD : PLAN_HEADLESS_GUARD;
	return out;
}

// --- Argv building ----------------------------------------------------------

export const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export interface BuildAgyArgsOptions {
	cwd: string;
	resolved: ResolvedModel;
	mode: Mode;
	reviewerAgentName?: string | null;
	skipPermissions: boolean;
	conversationId?: string | null;
	timeoutMinutes: number;
	addDirs?: string[];
	extraArgs: string[];
	prompt: string;
}

export function buildAgyArgs(opts: BuildAgyArgsOptions): string[] {
	const args: string[] = ["--add-dir", opts.cwd];
	const extra =
		opts.mode === "plan"
			? opts.extraArgs.filter((a) => !a.startsWith("--dangerously-skip-permissions"))
			: opts.extraArgs;
	if (extra.length) args.push(...extra);
	if (opts.resolved.model) args.push("--model", opts.resolved.model);
	if (opts.resolved.effort) args.push("--effort", opts.resolved.effort);
	args.push("--mode", opts.mode);
	if (opts.reviewerAgentName) args.push("--agent", opts.reviewerAgentName);
	if (opts.skipPermissions && opts.mode !== "plan") {
		args.push("--dangerously-skip-permissions");
	}
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	args.push("--print-timeout", `${opts.timeoutMinutes}m`);
	for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
	args.push("-p", opts.prompt);

	return args;
}

// --- Conversation discovery ------------------------------------------------

export const CONVERSATIONS_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

/** Snapshot the set of conversation ids (*.db stems) currently on disk. */
export function snapshotConversations(dir: string): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const f of entries) {
		if (f.endsWith(".db")) out.add(f.slice(0, -3));
	}
	return out;
}

export type OpenDbResolver = (
	rootPid: number,
	dir: string,
	candidates: Set<string>,
) => string | null;

function readProcStat(pid: number): { pid: number; ppid: number } | null {
	let raw: string;
	try {
		raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const closeParen = raw.lastIndexOf(")");
	if (closeParen < 0) return null;
	const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
	const ppid = Number(fields[1]);
	if (!Number.isFinite(ppid)) return null;
	return { pid, ppid };
}

function collectDescendants(rootPid: number): Set<number> {
	const out = new Set<number>([rootPid]);
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return out;
	}
	const ppidOf = new Map<number, number>();
	for (const e of entries) {
		if (!/^\d+$/.test(e)) continue;
		const s = readProcStat(Number(e));
		if (s) ppidOf.set(s.pid, s.ppid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of ppidOf) {
			if (out.has(pid)) continue;
			if (out.has(ppid)) {
				out.add(pid);
				changed = true;
			}
		}
	}
	return out;
}

function safeRealpath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

export const procTreeOpenDbResolver: OpenDbResolver = (rootPid, dir, candidates) => {
	if (candidates.size <= 1) return null;
	if (process.platform !== "linux") return null;
	const dirResolved = safeRealpath(dir);
	const tree = collectDescendants(rootPid);
	const found = new Set<string>();
	for (const pid of tree) {
		let fds: string[];
		try {
			fds = fs.readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			const base = path.basename(target);
			if (!base.endsWith(".db")) continue;
			if (dirResolved && safeRealpath(path.dirname(target)) !== dirResolved) continue;
			const id = base.slice(0, -3);
			if (candidates.has(id)) found.add(id);
		}
	}
	if (found.size === 1) return [...found][0] ?? null;
	return null;
};

interface BindOptions {
	pid?: number;
	resolveOpenDb?: OpenDbResolver;
	onAmbiguous?: () => void;
}

export function newConversationId(
	dir: string,
	before: Set<string>,
	opts: BindOptions = {},
): string | null {
	const created = [...snapshotConversations(dir)].filter((id) => !before.has(id));
	if (created.length === 0) return null;
	if (created.length === 1) return created[0] ?? null;
	if (opts.pid !== undefined) {
		const resolve = opts.resolveOpenDb ?? procTreeOpenDbResolver;
		const hit = resolve(opts.pid, dir, new Set(created));
		if (hit && created.includes(hit)) return hit;
	}
	opts.onAmbiguous?.();
	return null;
}
