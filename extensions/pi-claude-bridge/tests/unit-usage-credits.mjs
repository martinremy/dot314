import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, onPiHistoryReplaced, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { recordProjectTrust } from "../src/config.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const model = { id: "claude-haiku-4-5", provider: "pi-claude", api: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = { name: "echo", description: "Echo", parameters: { type: "object", properties: {} } };
const system = { role: "system", content: "Offline instructions", toolsAdded: [tool], timestamp: 0 };
const prompt = { role: "user", content: "run echo", timestamp: 1 };
const overage = { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true, rateLimitType: "overage" } };
const answer = { type: "result", subtype: "success", result: "should not continue" };
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_ISOLATED", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];

let root;
let previousEnv;
let queries;
let events;
let keepAlive;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-usage-credits-"));
	previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	delete process.env.CLAUDE_BRIDGE_ISOLATED;
	resetStack();
	queries = [];
	events = [];
	setExtensionApi({ events: { emit(name, data) { events.push({ name, data }); } }, appendEntry() {} });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	keepAlive = setInterval(() => {}, 1000);
});

afterEach(() => {
	clearInterval(keepAlive);
	__testSetSdkQueryFactory();
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	setExtensionApi(undefined);
	resetStack();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function fakeQuery(messages) {
	const closed = Promise.withResolvers();
	const record = { interrupted: false, closed };
	queries.push(record);
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" };
			yield* messages;
		},
		close() { closed.resolve(); },
		async interrupt() { record.interrupted = true; },
		async accountInfo() { return { subscriptionType: "max" }; },
		async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
	};
}

async function send(messages, options = {}) {
	const stream = streamClaudeAgentSdk(model, { messages }, { sessionId: "usage-credits", cwd: root, ...options });
	for await (const event of stream) {}
	return stream.result();
}

function assertBlocked(result) {
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /billing:.*usage credits.*provider\.allowUsageCredits/s);
	assert.equal(isRetryableAssistantError(result), false);
	assert.equal(queries.length, 1, "no automatic replacement query");
	assert.equal(queries[0].interrupted, true);
	assert.equal(events.some(event => event.name === "pi-claude:rate-limit"), false, "no automatic rate-limit resume");
}

for (const managed of [false, true]) {
	it(`stops unapproved usage credits ${managed ? "without rotating managed accounts" : "on a single login"}`, { timeout: 10_000 }, async () => {
		if (managed) globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = {
			version: 1,
			acquire() { return { profileId: "offline-profile", label: "Offline", configDir: join(root, "profile") }; },
			recordIdentity() {}, recordUsage() {}, recordSuccess() {},
			recordFailure() { assert.fail("a billing policy must not disable an account"); },
			recordRateLimit() { assert.fail("a billing policy is not a quota rejection"); },
		};
		__testSetSdkQueryFactory(() => fakeQuery([overage, answer]));
		assertBlocked(await send([system, prompt]));
	});
}

it("allows usage credits only after user configuration explicitly enables them", { timeout: 10_000 }, async () => {
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { allowUsageCredits: true } }));
	__testSetSdkQueryFactory(() => fakeQuery([overage, answer]));
	const result = await send([system, prompt]);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.content[0].text, answer.result);
	assert.equal(queries[0].interrupted, false);
});

it("cannot be enabled by trusted project configuration or a truthy user value", { timeout: 10_000 }, async () => {
	const project = join(root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { allowUsageCredits: true } }));
	writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ provider: { allowUsageCredits: "true" } }));
	recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
	__testSetSdkQueryFactory(() => fakeQuery([overage, answer]));
	assertBlocked(await send([system, prompt], { cwd: project }));
});

it("leaves plan-covered requests running", { timeout: 10_000 }, async () => {
	__testSetSdkQueryFactory(() => fakeQuery([{ ...overage, rate_limit_info: { status: "allowed", isUsingOverage: false } }, answer]));
	assert.equal((await send([system, prompt])).stopReason, "stop");
	assert.equal(queries[0].interrupted, false);
});

for (const scenario of ["tool", "restart", "cancelled restart"]) {
	it(`stops usage credits during ${scenario}`, { timeout: 10_000 }, async () => {
		const controller = new AbortController();
		const release = Promise.withResolvers();
		__testSetSdkQueryFactory(() => {
			if (queries.length > 0) return fakeQuery([answer]);
			const query = fakeQuery((async function* () {
				yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__echo", input: {} }] } };
				await release.promise;
				yield overage;
				yield answer;
			})());
			const interrupt = query.interrupt;
			query.interrupt = async () => { release.resolve(); await interrupt(); };
			return query;
		});
		const calling = await send([system, prompt]);
		assert.equal(calling.stopReason, "toolUse");
		const result = { role: "toolResult", toolCallId: "t1", toolName: "echo", content: [{ type: "text", text: "tool output" }], timestamp: 3 };
		let completion;
		if (scenario !== "tool") {
			runInRequestLane("usage-credits", () => onPiHistoryReplaced("session_compact"));
			completion = send([system, prompt, calling, result], { signal: controller.signal });
			if (scenario === "cancelled restart") controller.abort();
		} else {
			release.resolve();
			await queries[0].closed.promise;
			completion = send([system, prompt, calling, result]);
		}
		const completed = await completion;
		if (scenario === "cancelled restart") {
			assert.equal(completed.stopReason, "aborted");
			assert.equal(queries.length, 1);
		} else assertBlocked(completed);
		assert.equal(calling.stopReason, "toolUse", "the delivered tool turn stays unchanged");
	});
}

it("keeps cancellation authoritative when the overage event arrives after Esc", { timeout: 10_000 }, async () => {
	const controller = new AbortController();
	__testSetSdkQueryFactory(() => fakeQuery((async function* () {
		controller.abort();
		yield overage;
		yield answer;
	})()));
	assert.equal((await send([system, prompt], { signal: controller.signal })).stopReason, "aborted");
});
