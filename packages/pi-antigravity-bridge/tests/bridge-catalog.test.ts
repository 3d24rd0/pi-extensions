import { describe, expect, it } from "vitest";
import { bridgedPiTools, isExcludedBridgeTool } from "../src/bridge-catalog.js";

const all = [
	{ name: "web_search", sourceInfo: { source: "pi-web-search" } },
	{ name: "mcp:files", sourceInfo: { source: "pi-mcp-adapter" } },
	{ name: "read", sourceInfo: { source: "builtin" } },
	{ name: "antigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "AskAntigravity", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_web_search", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "agy_read_url", sourceInfo: { source: "pi-antigravity-bridge" } },
	{ name: "orchestrator_consult", sourceInfo: { source: "gentle-pi" } },
	{ name: "gentle_review", sourceInfo: { source: "gentle-pi" } },
	{ name: "mem_doctor", sourceInfo: { source: "gentle-engram" } },
	{ name: "mem_search", sourceInfo: { source: "gentle-engram" } },
];

describe("live Pi bridge catalog", () => {
	it("uses the active set, not the registered set", () => {
		expect(bridgedPiTools(all, ["read", "web_search"], "all", new Set()).map((t) => t.name)).toEqual(["web_search"]);
		expect(bridgedPiTools(all, ["mcp:files"], "all", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
	});
	it("supports session-only hide, MCP-only mode, and bridge-off", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set(["web_search", "mem_search"])).map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "mcp", new Set()).map((t) => t.name)).toEqual(["mcp:files"]);
		expect(bridgedPiTools(all, active, "none", new Set()).map((t) => t.name)).toEqual([]);
	});
	it("never exposes the bridge's own tools, including the web wrappers", () => {
		const active = all.map((tool) => tool.name);
		expect(bridgedPiTools(all, active, "all", new Set()).map((t) => t.name)).toEqual(["web_search", "mcp:files", "mem_search"]);
	});
	it("filters out orchestrator, review lifecycle, and admin memory tools", () => {
		expect(isExcludedBridgeTool("orchestrator_consult")).toBe(true);
		expect(isExcludedBridgeTool("orchestrator_send_message")).toBe(true);
		expect(isExcludedBridgeTool("gentle_review")).toBe(true);
		expect(isExcludedBridgeTool("gentle_review_capture")).toBe(true);
		expect(isExcludedBridgeTool("gentle_odd_phase")).toBe(true);
		expect(isExcludedBridgeTool("mem_doctor")).toBe(true);
		expect(isExcludedBridgeTool("mem_judge")).toBe(true);
		expect(isExcludedBridgeTool("mem_search")).toBe(false);
		expect(isExcludedBridgeTool("mem_save")).toBe(false);
	});
});
