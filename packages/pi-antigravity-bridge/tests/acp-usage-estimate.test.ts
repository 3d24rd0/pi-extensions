import { describe, expect, test } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens, estimateTranscriptTokens, synthesizeUsage } from "../src/acp/usage-estimate.js";

describe("estimateTranscriptTokens", () => {
	test("returns 0 for empty or undefined messages", () => {
		expect(estimateTranscriptTokens(undefined)).toBe(0);
		expect(estimateTranscriptTokens([])).toBe(0);
	});

	test("estimates across system, user, assistant, and toolResult messages", () => {
		const now = Date.now();
		const messages: Message[] = [
			{ role: "system", content: "You are an assistant.", timestamp: now },
			{ role: "user", content: "Hello world", timestamp: now },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "pondering deeply" },
					{ type: "text", text: "Answer here" },
					{ type: "toolCall", id: "c1", name: "view_file", arguments: { path: "a.ts" } },
				],
				api: "agy-bridge" as any,
				provider: "antigravity",
				model: "gemini-flash",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "view_file",
				content: [{ type: "text", text: "file contents line" }],
				isError: false,
				timestamp: now,
			},
		];
		const tokens = estimateTranscriptTokens(messages);
		expect(tokens).toBeGreaterThan(15);
	});
});

describe("estimateTokens", () => {
	test("counts word runs and single punctuation, skips whitespace", () => {
		// "Hello" + "," + "world" + "!" = 4 matches
		expect(estimateTokens("Hello, world!")).toBe(4);
		expect(estimateTokens("  spaced   out  ")).toBe(2);
		expect(estimateTokens("")).toBe(0);
	});

	test("CJK: one match per character (inherent to the copied mechanism)", () => {
		expect(estimateTokens("日本語")).toBe(3);
	});
});

describe("synthesizeUsage", () => {
	const base = {
		prompt: "one two three",
		textTokens: 2,
		thoughtTokens: 1,
		textDeltas: 2,
		thoughtDeltas: 1,
	};

	test("estimate mode: regex over prompt + response + thought", () => {
		const u = synthesizeUsage({ ...base, mode: "estimate" });
		expect(u).toEqual({
			input_tokens: 3,
			output_tokens: 3, // response 2 + thought 1
			thinking_tokens: 1,
			total_tokens: 6,
		});
	});

	test("context block text counts toward input", () => {
		const u = synthesizeUsage({ ...base, mode: "estimate", contextText: "alpha beta" });
		expect(u?.input_tokens).toBe(5);
		expect(u?.total_tokens).toBe(8);
	});

	test("direct mode: 1 token per streamed delta", () => {
		const u = synthesizeUsage({ ...base, mode: "direct" });
		expect(u).toMatchObject({
			input_tokens: 3, // input is always regex-estimated
			output_tokens: 3, // 2 text deltas + 1 thought delta
			thinking_tokens: 1,
		});
	});

	test("off mode: undefined", () => {
		expect(synthesizeUsage({ ...base, mode: "off" })).toBeUndefined();
	});

	test("empty turn: undefined (nothing worth reporting)", () => {
		expect(
			synthesizeUsage({
				mode: "estimate",
				prompt: "",
				textTokens: 0,
				thoughtTokens: 0,
				textDeltas: 0,
				thoughtDeltas: 0,
			}),
		).toBeUndefined();
	});
});
