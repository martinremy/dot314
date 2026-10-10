// A Claude Code session keeps the system prompt Pi's leading system messages
// render. A later system message reaches Claude as a note where Pi holds it,
// so a change to Pi's prompt does not make Claude Code re-send the whole
// conversation uncached (src/system-notes.ts).
import "./lib/debug-env.mjs";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { getSessionPath, parseJsonlFile } from "cc-session-io";

// Not in the package's exports map: Pi's session prompt builder and section diff.
import { buildSystemPromptSections, diffSystemPromptSections } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { getSharedSession, setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const REPLACEMENT = "You are Claude Code, Anthropic's official CLI for Claude.";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_ISOLATED", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];

let root;
let cwd;
let queries;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-system-notes-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_BRIDGE_ISOLATED: "1", CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ systemPrompt: { replacement: REPLACEMENT, preservePiContext: true } }));
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
	queries = [];
	__testSetSdkQueryFactory(({ prompt, options }) => {
		queries.push({ resume: options.resume, system: options.systemPrompt.prompt, prompt: String(prompt) });
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: options.resume ?? "22222222-2222-4222-8222-222222222222" };
				yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
				yield { type: "result", subtype: "success", result: "ok" };
			},
			close() {},
			async interrupt() {},
		};
	});
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const key of ENV_KEYS) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

const base = { cwd: "/tmp/project", selectedTools: ["read", "bash"], toolSnippets: { read: "Read file contents", bash: "Execute bash commands" }, contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Use tabs." }] };
const START = buildSystemPromptSections(base);
const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const claude = (text, timestamp) => ({ role: "assistant", provider: "pi-claude", api: "claude-bridge", model: model.id, stopReason: "stop", content: [{ type: "text", text }], timestamp });
const change = (options, timestamp) => ({ role: "system", content: "", sections: diffSystemPromptSections(START, buildSystemPromptSections({ ...base, ...options })), timestamp });
const leading = { role: "system", content: "", sections: START, timestamp: 0 };

async function send(messages, sharedSession) {
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession, ui: { notify() {} } });
	for await (const _event of streamClaudeAgentSdk(model, { messages }, { cwd })) { /* drain */ }
	return queries.at(-1);
}

// The record of a Claude session holding Pi's first three messages.
const record = (systemNotes) => ({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 3, cwd, ...(systemNotes ? { systemNotes: true } : {}) });
const AGENTS = { contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Use spaces." }] };

it("keeps the session's system prompt and sends a changed section as a note before the next message", { timeout: 10_000 }, async () => {
	const started = (await send([leading, user("one", 1)], null)).system;

	const query = await send([leading, user("one", 1), claude("ok", 2), change(AGENTS, 3), user("two", 4)], record(true));

	assert.equal(query.resume, record(true).sessionId);
	assert.equal(query.system, started, "the system prompt the session started with");
	assert.match(query.prompt, /^<system-reminder>\n[\s\S]*Updated system prompt section "project_context":\n\n[\s\S]*Use spaces\.[\s\S]*<\/system-reminder>\n\ntwo$/);
});

it("sends no note for a change to a section the bridge does not send", { timeout: 10_000 }, async () => {
	const started = (await send([leading, user("one", 1)], null)).system;
	const tools = change({ toolSnippets: { read: "Read a file", bash: "Execute bash commands" } }, 3);
	assert.deepEqual(Object.keys(tools.sections), ["tools"]);

	const query = await send([leading, user("one", 1), claude("ok", 2), tools, user("two", 4)], record(true));

	assert.equal(query.system, started);
	assert.equal(query.prompt, "two");
});

it("sends a session from before notes Pi's current system prompt and no note", { timeout: 10_000 }, async () => {
	const query = await send([leading, user("one", 1), claude("ok", 2), change(AGENTS, 3), user("two", 4)], record(false));

	assert.match(query.system, /Use spaces\./);
	assert.equal(query.prompt, "two");
});

it("imports a later system message's note as a record of its own where Pi holds it, and marks the session as holding notes", { timeout: 10_000 }, async () => {
	const query = await send([leading, user("one", 1), claude("ok", 2), change(AGENTS, 3), user("two", 4), claude("ok", 5), user("three", 6)], null);

	const texts = parseJsonlFile(getSessionPath(query.resume, cwd, process.env.CLAUDE_CONFIG_DIR))
		.filter((entry) => entry.type === "user" || entry.type === "assistant")
		.map((entry) => [entry.type, entry.message.content.map((block) => block.text).join("")]);
	assert.deepEqual(texts.map(([type, text]) => [type, text.startsWith("<system-reminder>") ? "note" : text]), [
		["user", "one"], ["assistant", "ok"], ["user", "note"], ["user", "two"], ["assistant", "ok"],
	]);
	assert.match(texts[2][1], /Use spaces\./);
	assert.equal(getSharedSession().systemNotes, true);
	assert.equal(query.prompt, "three");
});
