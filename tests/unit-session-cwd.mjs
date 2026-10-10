// Pi passes providers no working directory, and one process can run sessions
// in several: pi-subagents runs a foreground child in the parent's process, in
// the child's worktree. Claude Code tells the model the directory it starts in,
// so each query must start in its own Pi session's directory.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import claudeBridge, { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { __testCancelAllScheduledSessionPersistence } from "../src/session-persistence.ts";

const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const CHILD = "child-session";
const system = { role: "system", content: "Pi instructions", timestamp: 0 };

let root;
let worktree;
let cwds;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-session-cwd-"));
	worktree = realpathSync(mkdtempSync(join(tmpdir(), "bridge-worktree-")));
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	cwds = [];
	__testSetSdkQueryFactory(({ options }) => {
		cwds.push(options.cwd);
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: `claude-${cwds.length}` };
				yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
				yield { type: "result", subtype: "success", result: "ok" };
			},
			close() {},
			async interrupt() {},
		};
	});
});

afterEach(() => {
	__testCancelAllScheduledSessionPersistence();
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
	for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"]) delete process.env[key];
	rmSync(root, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

async function ask(text) {
	for await (const _event of streamClaudeAgentSdk(model, { messages: [system, { role: "user", content: text, timestamp: Date.now() }] }, { sessionId: CHILD }));
}

it("starts Claude Code in the directory of the Pi session it serves, not the process's", { timeout: 10_000 }, async () => {
	assert.notEqual(worktree, process.cwd());
	const handlers = new Map();
	claudeBridge({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand() {}, registerProvider() {}, registerTool() {},
		events: { emit() {} },
		appendEntry() {},
	});
	const sessionManager = { getSessionId: () => CHILD, getCwd: () => worktree, getEntries: () => [], buildSessionContext: () => ({ messages: [] }) };
	const ctx = { sessionManager, cwd: worktree, ui: { notify() {} } };

	handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await ask("in the worktree");
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
	await ask("after the session ended");

	assert.deepEqual(cwds, [worktree, process.cwd()]);
});
