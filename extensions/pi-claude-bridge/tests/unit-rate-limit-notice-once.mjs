import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/account-router.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = { id: "claude-haiku-4-5", provider: "pi-claude", api: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const messages = [{ role: "user", content: "hello", timestamp: 1 }];
const warning = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.91, resetsAt: 1793000000 } };
const rejected = { type: "rate_limit_event", rate_limit_info: { ...warning.rate_limit_info, status: "rejected" } };
const success = { type: "result", subtype: "success", result: "OK" };
const failure = { type: "result", subtype: "error_during_execution", errors: ["connection error"] };
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];
let root, savedEnv, notices, events, closed, calls, keepAlive;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-notice-once-"));
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	resetStack();
	notices = [];
	events = [];
	closed = [];
	calls = 0;
	newRecipient();
	setExtensionApi({ events: { emit(name, data) { events.push({ name, data }); } }, appendEntry() {} });
	keepAlive = setInterval(() => {}, 1000);
});

afterEach(async () => {
	await Promise.all(closed);
	clearInterval(keepAlive);
	__testSetSdkQueryFactory();
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

function newRecipient() {
	__testSetBridgeIntegrityState({ ui: { notify(message, level) { notices.push({ message, level }); } } });
}

function install(sequence) {
	__testSetSdkQueryFactory(() => {
		const done = Promise.withResolvers();
		closed.push(done.promise);
		return {
			async *[Symbol.asyncIterator]() { yield* sequence; },
			close() { done.resolve(); },
			async interrupt() {},
			async accountInfo() { return {}; },
			async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return {}; },
		};
	});
}

async function send() {
	const stream = streamClaudeAgentSdk(model, { messages }, { sessionId: `notice-${calls++}`, cwd: root });
	for await (const event of stream) {}
	return stream.result();
}

it("deduplicates concurrent and later warnings for the same account and recipient", async () => {
	install([warning, warning, success]);
	await Promise.all([send(), send()]);
	await send();
	assert.equal(notices.length, 1);
	process.env.CLAUDE_CONFIG_DIR = join(root, "second-login");
	await send();
	assert.equal(notices.length, 2);
	install([{ ...warning, rate_limit_info: { ...warning.rate_limit_info, resetsAt: 1793000100 } }, success]);
	await send();
	assert.equal(notices.length, 3);
	newRecipient();
	await send();
	assert.equal(notices.length, 4);
});

it("gives an absent reset its own identity and distinguishes status and limit type", async () => {
	const withoutReset = { ...warning, rate_limit_info: { ...warning.rate_limit_info, resetsAt: undefined } };
	install([withoutReset, withoutReset, success]);
	await send();
	await send();
	assert.equal(notices.length, 1);
	install([warning, { ...warning, rate_limit_info: { ...warning.rate_limit_info, rateLimitType: "five_hour" } }, rejected, success]);
	await send();
	assert.equal(notices.length, 4);
});

it("emits every rejected request's event even when its toast was shown", async () => {
	install([rejected, failure]);
	const results = await Promise.all([send(), send()]);
	assert.equal(results.every(result => result.stopReason === "error"), true);
	assert.equal(notices.length, 1);
	assert.equal(events.filter(event => event.name === "pi-claude:rate-limit").length, 2);
});

it("does not consume notice state for a missing or throwing UI", async () => {
	install([warning, success]);
	__testSetBridgeIntegrityState({ ui: null });
	await send();
	let throws = true;
	__testSetBridgeIntegrityState({ ui: { notify(message) {
		if (throws) throw new Error("recipient unavailable");
		notices.push(message);
	} } });
	await send();
	throws = false;
	await send();
	assert.equal(notices.length, 1);
	await send();
	assert.equal(notices.length, 1);
});

it("keeps deferred notices scoped to the environment captured for the query", async () => {
	let query = 0;
	const sequences = [
		(async function* () {
			yield warning;
			process.env.CLAUDE_CONFIG_DIR = join(root, "second-login");
			ctx().deferredUserMessages.push({ text: "steer" });
			yield { type: "system", subtype: "init", session_id: "66666666-6666-4666-8666-666666666666" };
			yield success;
		})(),
		[warning, success],
	];
	__testSetSdkQueryFactory(() => ({
		async *[Symbol.asyncIterator]() { yield* sequences[query++]; },
		close() {}, async interrupt() {},
	}));
	await send();
	assert.equal(query, 2);
	assert.equal(notices.length, 1);
	install([warning, success]);
	await send();
	assert.equal(notices.length, 2);
});

it("scopes managed terminal rejections to opaque profile IDs", async () => {
	let profileId = "profile-a";
	globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = {
		version: 1,
		acquire() { return { profileId, label: "Offline", configDir: root }; },
		recordIdentity() {}, recordUsage() {}, recordSuccess() {}, recordFailure() {}, recordRateLimit() {},
	};
	install([{ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "started" }] } }, rejected, failure]);
	await send();
	await send();
	assert.equal(notices.length, 1);
	profileId = "profile-b";
	await send();
	assert.equal(notices.length, 2);
	delete globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
	await send();
	assert.equal(notices.length, 3);
});
