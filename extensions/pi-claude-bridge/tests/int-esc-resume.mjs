#!/usr/bin/env node
// Claude Code answers a resumed transcript that ends on a user record (a tool
// result, or a message whose reply Pi dropped after an Esc) with a synthetic
// "No response requested." reply, which it also writes to the transcript.
// Claude reads that reply as its own. These tests rebuild a session the way
// the bridge does after an Esc, resume it with the bridge's child env, and
// check Claude Code added no such reply. The tool-result case depends on
// Claude Code honoring the undocumented `isVirtual` flag (session-persistence
// endOnAssistant), so a Claude Code update that drops it fails here.
//
// Requires: Claude Code logged in. Spends a few Haiku turns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { z } from "zod";
import { setSharedSession } from "../src/bridge-state.ts";
import { resolveClaudeExecutable } from "../src/claude-executable.ts";
import { syncSharedSession } from "../src/session-persistence.ts";
import { extractUserPrompt } from "../src/user-prompt.ts";

const MODEL = "claude-haiku-4-5";
const FILLER = "No response requested.";
const echo = createSdkMcpServer({ name: "custom-tools", version: "1.0.0", tools: [
	tool("echo", "Echo text back", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] })),
] });
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const claude = (stopReason, content) => ({ role: "assistant", provider: "pi-claude", api: "claude-bridge", model: MODEL, stopReason, content, timestamp: Date.now() });
const ASK = "Do not call any tools. Reply with one short sentence.";

async function rebuildAndResume(messages) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bridge-esc-resume-")));
	setSharedSession(null);
	const synced = await syncSharedSession(messages, cwd, new Map([["echo", "mcp__custom-tools__echo"]]), MODEL);
	assert.ok(synced.sessionId, "the context rebuilds into a Claude session");
	const path = getSessionPath(synced.sessionId, cwd);
	try {
		const executable = resolveClaudeExecutable();
		for await (const _message of query({ prompt: extractUserPrompt(messages.slice(synced.promptStart)), options: {
			resume: synced.sessionId, cwd, model: MODEL, maxTurns: 1, settingSources: [], tools: [],
			mcpServers: { "custom-tools": echo },
			...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
			env: { ...process.env, DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0", CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1" },
		} })) { /* drain */ }
		return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	} finally {
		setSharedSession(null);
		rmSync(dirname(path), { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

const fillers = (records) => records.filter((record) => record.type === "assistant" && JSON.stringify(record.message?.content).includes(FILLER));

test("a rebuild that ends on a tool result gets no filler reply", { timeout: 120_000 }, async () => {
	const records = await rebuildAndResume([
		user("Call echo with the text hi."),
		claude("toolUse", [{ type: "toolCall", id: "toolu_esc_1", name: "echo", arguments: { text: "hi" } }]),
		{ role: "toolResult", toolCallId: "toolu_esc_1", toolName: "echo", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: Date.now() },
		user(ASK),
	]);
	assert.deepEqual(fillers(records), []);
	assert.ok(records.some((record) => record.isVirtual === true), "the rebuild's virtual record is still there");
});

test("a rebuild after an Esc cut off a reply gets no filler reply", { timeout: 120_000 }, async () => {
	const records = await rebuildAndResume([
		user("Say hi."),
		claude("stop", [{ type: "text", text: "Hi." }]),
		user("Count to three."),
		claude("aborted", []),
		user(ASK),
	]);
	assert.deepEqual(fillers(records), []);
});
