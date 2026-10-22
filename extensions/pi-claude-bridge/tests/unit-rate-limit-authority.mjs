import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { getSharedSession, setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { consumeLikePi } from "./lib/pi-frame-consumer.mjs";

const model = { id: "claude-haiku-4-5", provider: "pi-claude", api: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Echo", parameters: { type: "object", properties: {} } };
const messages = [
	{ role: "system", content: "Offline instructions", toolsAdded: [tool], timestamp: 0 },
	{ role: "user", content: "run echo", timestamp: 1 },
];
const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1793000000 } };
const success = { type: "result", subtype: "success", result: "recovered" };
const failure = { type: "result", subtype: "error_during_execution", errors: ["API Error: 500 connection error"] };
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];
let root, savedEnv, keepAlive, events, queries;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-limit-authority-"));
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	resetStack();
	events = [];
	queries = [];
	setExtensionApi({ events: { emit(name, data) { events.push({ name, data }); } }, appendEntry() {} });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	keepAlive = setInterval(() => {}, 1000);
});

afterEach(async () => {
	await Promise.all(queries.map(query => query.closed.promise));
	clearInterval(keepAlive);
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

function install(sequence, { stall = false } = {}) {
	__testSetSdkQueryFactory(() => {
		const closed = Promise.withResolvers();
		const interrupted = Promise.withResolvers();
		queries.push({ closed, interrupted });
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "55555555-5555-4555-8555-555555555555" };
				for await (const message of sequence) {
					if (message instanceof Error) throw message;
					yield message;
				}
				if (stall) await interrupted.promise;
			},
			close() { closed.resolve(); },
			async interrupt() { interrupted.resolve(); },
		};
	});
}

async function send(history = messages, options = {}) {
	return consumeLikePi(streamClaudeAgentSdk(model, { messages: history }, { sessionId: "limit-authority", cwd: root, ...options }));
}

function assertQuota(run) {
	assert.equal(run.events.at(-1).type, "error");
	assert.equal(run.final.stopReason, "error");
	assert.match(run.final.errorMessage, /^Claude usage quota exceeded:.*seven_day.*resets.*2026/s);
	assert.equal(isRetryableAssistantError(run.final), false);
}

for (const [label, tail] of [
	["connection error", [{ type: "assistant", error: "connection_error", message: { content: [{ type: "text", text: "Connection error." }] } }]],
	["execution error", [failure]],
	["iterator throw", [new Error("API Error: 500 connection error")]],
	["success-labelled error", [{ ...success, is_error: true }, new Error("connection error")]],
]) {
	it(`retains rejected quota after ${label}`, async () => {
		install([rejected, ...tail]);
		const run = await send();
		assertQuota(run);
		assert.match(run.final.errorMessage, /connection error/i);
	});
}

it("preserves Claude Code's recognizable usage-limit message", async () => {
	const detail = "You've hit your weekly limit · resets Thursday 4am";
	install([rejected, new Error(detail)]);
	const run = await send();
	assert.equal(run.final.errorMessage, detail);
	assert.equal(isRetryableAssistantError(run.final), false);
});

it("uses an explicit quota cause when the SDK supplied no limit or reset", async () => {
	install([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, new Error("connection error")]);
	const run = await send();
	assert.match(run.final.errorMessage, /^Claude usage quota exceeded:/);
	assert.equal(isRetryableAssistantError(run.final), false);
});

it("clears a recovered rejection and leaves a later failure unchanged", async () => {
	install([rejected, success]);
	const recovered = await send();
	assert.equal(recovered.final.stopReason, "stop");
	assert.equal(recovered.final.content[0].text, "recovered");
	await queries[0].closed.promise;
	install([failure]);
	const next = await send([...messages, recovered.final, { role: "user", content: "next", timestamp: 3 }]);
	assert.equal(next.final.errorMessage, failure.errors[0]);
	assert.equal(isRetryableAssistantError(next.final), true);
});

it("clears rejection on successful recovery before a later iterator error", async () => {
	install([rejected, success, new Error("connection error after result")]);
	const run = await send();
	assert.equal(run.final.errorMessage, "connection error after result");
	assert.equal(isRetryableAssistantError(run.final), true);
});

it("starts deferred consumption without the previous query's rejection", async () => {
	install((async function* () {
		ctx().deferredUserMessages.push({ text: "steer" });
		yield rejected;
		install([failure]);
	})());
	const run = await send();
	assert.equal(queries.length, 2);
	assert.equal(run.final.errorMessage, failure.errors[0]);
	assert.equal(isRetryableAssistantError(run.final), true);
});

it("retains a rejection received while Pi executes a tool", async () => {
	const release = Promise.withResolvers();
	install((async function* () {
		yield { type: "assistant", message: { id: "tool-message", content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__echo", input: {} }] } };
		await release.promise;
		yield rejected;
		yield failure;
	})());
	const calling = await send();
	assert.equal(calling.final.stopReason, "toolUse");
	release.resolve();
	await queries[0].closed.promise;
	const result = { role: "toolResult", toolCallId: "t1", toolName: "echo", content: [{ type: "text", text: "output" }], timestamp: 3 };
	assertQuota(await send([...messages, calling.final, result]));
	assert.equal(calling.final.stopReason, "toolUse");
});

it("ends an idle rejected request as quota without a stream-idle resume event", async () => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "20ms";
	runInRequestLane("limit-authority", () => __testSetBridgeIntegrityState({ sharedSession: {
		sessionId: "55555555-5555-4555-8555-555555555555", cursor: 0, cwd: root,
	} }));
	install([rejected], { stall: true });
	assertQuota(await send());
	assert.equal(events.filter(event => event.name === "pi-claude:rate-limit").length, 1);
	assert.equal(events.some(event => event.data.rateLimitType === "stream_idle"), false);
	await queries[0].closed.promise;
	const session = runInRequestLane("limit-authority", getSharedSession);
	assert.equal(session.forceRotate, true);
	assert.equal(session.rebuildReason, "idle-timeout");
});

it("keeps cancellation authoritative after a rejection", async () => {
	const controller = new AbortController();
	install((async function* () {
		yield rejected;
		controller.abort();
		yield failure;
	})());
	const run = await send(messages, { signal: controller.signal });
	assert.equal(run.final.stopReason, "aborted");
	assert.doesNotMatch(run.final.errorMessage, /quota/);
});

it("keeps usage-credit policy authoritative after a rejection", async () => {
	install([rejected, { type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true } }]);
	const run = await send();
	assert.match(run.final.errorMessage, /billing:.*usage credits/s);
	assert.doesNotMatch(run.final.errorMessage, /quota exceeded/);
	assert.equal(isRetryableAssistantError(run.final), false);
});
