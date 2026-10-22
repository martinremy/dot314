import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { getSharedSession, setSharedSession } from "../src/bridge-state.ts";
import { consumeQuery } from "../src/consume-query.ts";
import { ctx, QueryContext, resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", name: "Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const envelope = (session_id, uuid, extra = {}) => ({ type: "assistant", session_id, uuid, parent_tool_use_id: null, message: { id: "anthropic-message-not-a-native-uuid", model: model.id, content: [{ type: "text", text: "answer" }] }, ...extra });
const query = messages => ({ async *[Symbol.asyncIterator]() { yield* messages; }, close() {}, async interrupt() {} });
let root;
let previous;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-checkpoint-"));
	const env = { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0", CLAUDE_BRIDGE_ISOLATED: "1" };
	previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
	setSharedSession(null);
});

afterEach(() => {
	__testSetSdkQueryFactory();
	resetStack();
	setSharedSession(null);
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

async function run(...attempts) {
	let n = 0;
	__testSetSdkQueryFactory(() => {
		if (n === 0 && attempts.length > 1) ctx().deferredUserMessages.push({ text: "steer" });
		return query(attempts[n++]);
	});
	const events = [];
	for await (const event of streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] })) events.push(event);
	assert.equal(events.at(-1).type, "done");
	return getSharedSession();
}

const init = session_id => ({ type: "system", subtype: "init", session_id });
const success = { type: "result", subtype: "success", result: "answer" };

it("persists the top-level assistant envelope UUID, never the Anthropic message id", async () => {
	const record = await run([init("native-a"), envelope("native-a", "leaf-a"), envelope("subagent", "nested-leaf", { parent_tool_use_id: "parent-call" }), success]);
	assert.equal(record.sessionId, "native-a");
	assert.equal(record.transcriptLeaf, "leaf-a");
});

it("does not stamp a session with another session's checkpoint", async () => {
	const record = await run([init("native-b"), envelope("native-a", "leaf-a"), success]);
	assert.equal(record.transcriptLeaf, undefined);
});

for (const nextEnvelope of [envelope("native-a", "leaf-continuation"), null]) {
	it(`resets the checkpoint for a deferred SDK query${nextEnvelope ? " and records its own reply" : " without an envelope"}`, async () => {
		const record = await run([init("native-a"), envelope("native-a", "leaf-first"), success], [init("native-a"), ...(nextEnvelope ? [nextEnvelope] : []), success]);
		assert.equal(record.transcriptLeaf, nextEnvelope?.uuid);
	});
}

it("ignores cancelled envelopes and keeps checkpoint state on the captured query", async () => {
	const captured = new QueryContext();
	captured.resetTurnState(model);
	const replacement = ctx();
	await consumeQuery(query([envelope("old-native", "old-leaf")]), captured, new Map(), model, {}, () => false, "unmanaged:fixture");
	assert.deepEqual(captured.transcriptCheckpoint, { sessionId: "old-native", uuid: "old-leaf" });
	assert.equal(replacement.transcriptCheckpoint, null);
	await consumeQuery(query([envelope("old-native", "cancelled-leaf")]), captured, new Map(), model, {}, () => true, "unmanaged:fixture");
	assert.equal(captured.transcriptCheckpoint, null);
});
