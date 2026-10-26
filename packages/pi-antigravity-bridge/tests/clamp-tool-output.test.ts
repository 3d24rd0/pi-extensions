import { describe, expect, it } from "vitest";
import { clampToolOutput, MAX_TOOL_OUTPUT_CHARS } from "../src/provider.js";

describe("clampToolOutput", () => {
	it("leaves outputs under the maximum budget untouched", () => {
		const shortText = "hello world\nline 2";
		expect(clampToolOutput(shortText)).toBe(shortText);
	});

	it("truncates outputs that exceed the maximum budget with a clean notice", () => {
		const longText = "a".repeat(MAX_TOOL_OUTPUT_CHARS + 500);
		const clamped = clampToolOutput(longText);

		expect(clamped.startsWith("a".repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
		expect(clamped).toContain("output truncated by antigravity-bridge: 500 characters omitted");
		expect(clamped).toContain("StartLine/EndLine");
	});

	it("respects custom maxChars parameter", () => {
		const text = "1234567890abcdefghij";
		const clamped = clampToolOutput(text, 10);
		expect(clamped.startsWith("1234567890")).toBe(true);
		expect(clamped).toContain("10 characters omitted");
	});
});
