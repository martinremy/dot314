// A host that runs the bridge itself (not Pi) can restart while a turn waits
// for tool results. The query that made those calls died with it, so the
// request carrying the results finds none. When the host marks that request
// as a resumed turn, the bridge rebuilds Claude's session on a new id from
// every message and continues with a prompt of its own; the turn gets a real
// reply instead of the orphaned path's empty end_turn. Without the mark, or
// when the request is not that shape, every path stays as it was: Pi never
// sets the mark.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession, openSession } from "cc-session-io";

import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { historyDigest } from "../src/history-digest.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const RESUMED = Symbol.for("kendex.pi.claude-bridge.host-resumed-turn.v1");
const PROMPT = "Continue from the completed tool results above; do not repeat completed tool calls.";
const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "pi-claude", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Return a value", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const lane = "22222222-2222-4222-8222-222222222222";
const oldSessionId = "11111111-1111-4111-8111-111111111111";
const system = { role: "system", content: "Pi instructions", toolsAdded: [tool], timestamp: 0 };
const prompt = { role: "user", content: "run echo", timestamp: 1 };
const calling = (...ids) => ({
	role: "assistant", provider: "pi-claude", model: model.id, stopReason: "toolUse", timestamp: 2,
	content: ids.map((id) => ({ type: "toolCall", id, name: "echo", arguments: { id } })),
});
const result = (id, text = `output ${id}`, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError, timestamp: 3 });
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };

let root;
let oldBytes;
let calls;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-host-resumed-"));
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	resetStack();
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
	// The record the host restored for this conversation: Claude's session
	// the dead query was writing.
	const old = createSession({ sessionId: oldSessionId, projectPath: root, claudeDir: root });
	old.importMessages([{ role: "user", content: "old history" }]);
	old.save();
	oldBytes = readFileSync(old.jsonlPath, "utf8");
	runInRequestLane(lane, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: oldSessionId, cursor: 2, cwd: root }, ui: { notify() {} } }));
	calls = [];
	__testSetSdkQueryFactory(({ prompt: sent, options }) => {
		calls.push({ prompt: sent, options });
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: options.resume ?? "33333333-3333-4333-8333-333333333333" };
				yield { type: "assistant", message: { content: [{ type: "text", text: "continued" }] } };
				yield { type: "result", subtype: "success", result: "continued" };
			},
			close() {},
			async interrupt() {},
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

const request = (messages, extra = {}) => collect(streamClaudeAgentSdk(model, { messages }, { cwd: root, sessionId: lane, [RESUMED]: true, ...extra }));
const done = (events) => events.filter((event) => event.type === "done").map((event) => event.message);
const record = () => runInRequestLane(lane, () => __testGetBridgeIntegrityState().sharedSession);
const importedBlocks = (sessionId) => readFileSync(openSession({ sessionId, projectPath: root, claudeDir: root }).jsonlPath, "utf8")
	.trim().split("\n").map((line) => JSON.parse(line).message?.content).flatMap((content) => Array.isArray(content) ? content : []);

describe("a host-resumed turn", () => {
	const granted = {
		"a single result": [calling("t0"), result("t0")],
		"a denied result": [calling("t0"), result("t0", "Denied by the user", true)],
		"a parallel batch": [calling("t0", "t1"), result("t1"), result("t0")],
	};
	for (const [name, turn] of Object.entries(granted)) {
		it(`continues ${name} on a new Claude session holding every result`, async () => {
			const messages = [system, prompt, ...turn];
			const events = await request(messages);
			assert.equal(calls.length, 1);
			assert.equal(calls[0].prompt, PROMPT);
			const resumed = calls[0].options.resume;
			assert.ok(resumed && resumed !== oldSessionId, "a new session id");
			assert.equal(readFileSync(openSession({ sessionId: oldSessionId, projectPath: root, claudeDir: root }).jsonlPath, "utf8"), oldBytes, "the old transcript is left alone");
			const blocks = importedBlocks(resumed);
			const results = turn.filter((message) => message.role === "toolResult");
			assert.deepEqual(blocks.filter((block) => block.type === "tool_use").map((block) => block.id), turn[0].content.map((block) => block.id));
			assert.deepEqual(
				blocks.filter((block) => block.type === "tool_result").map((block) => [block.tool_use_id, block.is_error === true]).sort(),
				results.map((message) => [message.toolCallId, message.isError]).sort(),
			);
			assert.equal(events.some((event) => event.type === "error"), false);
			assert.deepEqual(done(events).map((message) => message.content), [[{ type: "text", text: "continued" }]]);
			// The prompt is the bridge's own: the record covers the host's messages only.
			assert.equal(record().sessionId, resumed);
			assert.equal(record().cursor, messages.length);
			assert.equal(record().historyDigest, historyDigest(messages));
		});
	}

	it("leaves the next prompt resuming that session warm", async () => {
		const messages = [system, prompt, calling("t0"), result("t0")];
		const [reply] = done(await request(messages));
		await request([...messages, reply, { role: "user", content: "next", timestamp: 5 }], { [RESUMED]: undefined });
		assert.equal(calls.length, 2);
		assert.equal(calls[1].prompt, "next");
		assert.equal(calls[1].options.resume, calls[0].options.resume);
	});
});

describe("a request the host did not resume keeps today's path", () => {
	const orphaned = async (events) => {
		assert.equal(calls.length, 0, "no query starts");
		assert.deepEqual(done(events).map((message) => [message.stopReason, message.content]), [["stop", []]]);
		assert.equal(record().sessionId, oldSessionId);
	};

	it("without the option", async () => {
		await orphaned(await request([system, prompt, calling("t0"), result("t0")], { [RESUMED]: undefined }));
	});

	it("when it is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const events = await request([system, prompt, calling("t0"), result("t0")], { signal: controller.signal });
		assert.equal(calls.length, 0, "no query starts");
		assert.equal(events.some((event) => event.type === "done" && event.message.content.length > 0), false);
		assert.equal(record().sessionId, oldSessionId);
	});

	it("when the results do not answer every call before them", async () => {
		await orphaned(await request([system, prompt, calling("t0", "t1"), result("t0")]));
	});

	it("when a query of this process is in its lane", async () => {
		const live = { id: "live-query" };
		runInRequestLane(lane, () => { ctx().activeQuery = live; });
		const events = await request([system, prompt, calling("t0"), result("t0")]);
		assert.equal(calls.length, 0, "no query starts");
		assert.deepEqual(done(events).map((message) => message.content), [[]]);
		assert.equal(runInRequestLane(lane, () => ctx().activeQuery), live, "the live query is untouched");
	});

	it("when a query of this process made the call", async () => {
		runInRequestLane(lane, () => { ctx().forwardedToolCallIds.add("t0"); });
		const events = await request([system, prompt, calling("t0"), result("t0")]);
		assert.equal(calls.length, 0, "no query starts");
		assert.deepEqual(done(events).map((message) => [message.stopReason, message.content]), [["stop", []]]);
	});

	it("when a user message follows the results", async () => {
		await request([system, prompt, calling("t0"), result("t0"), { role: "user", content: "and then this", timestamp: 4 }]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].prompt, "and then this");
	});
});
