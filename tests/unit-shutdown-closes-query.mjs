// A query can outlive the Pi run that started it: a tool batch whose every
// result says terminate (pi-subagents' structured_output) ends the run while
// Claude Code still waits for those results. When that session then ends,
// Pi's cancel finds no run, so the bridge must close the query itself or the
// Claude Code child waits until Pi exits.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Return a value", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const SESSION = "shutdown-session";
const system = { role: "system", content: "Pi instructions", toolsAdded: [tool], timestamp: 0 };

let root;
let handlers;
let ctx;
let closed;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-shutdown-"));
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	handlers = new Map();
	claudeBridge({ on: (event, handler) => handlers.set(event, handler), registerCommand() {}, registerProvider() {}, registerTool() {}, events: { emit() {} }, appendEntry() {} });
	const sessionManager = { getSessionId: () => SESSION, getCwd: () => root, getEntries: () => [], buildSessionContext: () => ({ messages: [] }) };
	ctx = { sessionManager, cwd: root, ui: { notify() {} } };
	closed = Promise.withResolvers();
	// Claude asks for echo, then waits for its result until the query is closed.
	__testSetSdkQueryFactory(({ options }) => {
		const gate = Promise.withResolvers();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" };
				yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "mcp__custom-tools__echo", input: { id: "t0" } }] } };
				void options.mcpServers["custom-tools"].instance._registeredTools.echo.handler({ id: "t0" }, {});
				await gate.promise;
			},
			close() { closed.resolve(); gate.resolve(); },
			async interrupt() { gate.resolve(); },
		};
	});
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
	for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
});

for (const reason of ["new", "reload", "quit"]) {
	it(`closes a query still waiting for a tool result when the session ends (${reason})`, { timeout: 10_000 }, async () => {
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const events = [];
		// The run's signal never aborts: the run already ended.
		for await (const event of streamClaudeAgentSdk(model, { messages: [system, { role: "user", content: "run echo", timestamp: 1 }] }, { sessionId: SESSION, signal: new AbortController().signal })) events.push(event);
		assert.equal(events.at(-1).reason, "toolUse");
		handlers.get("session_shutdown")({ type: "session_shutdown", reason }, ctx);
		let timer;
		const leftRunning = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the Claude Code query was left running")), 1000); });
		try { await Promise.race([closed.promise, leftRunning]); } finally { clearTimeout(timer); }
	});
}
