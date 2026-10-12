import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { __testSetBridgeIntegrityState, __testSetSdkQueryFactory, streamClaudeAgentSdk } from "../src/index.ts";
import { deleteSharedSessionLane, setExtensionApi } from "../src/bridge-state.ts";
import { deleteQueryLane } from "../src/query-state.ts";

const SESSION = "system-update-delivery";
const ORIGINAL_RULE = "Explain commands before running them.";
const UPDATED_RULE = "Require human approval before writing files.";
const model = { id: "claude-haiku-4-5", provider: "pi-claude", api: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_BRIDGE_ISOLATED", "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT"];

let root;
let previousEnv;
let queries;
let deliveredUpdates;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-system-delivery-"));
	previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_ISOLATED: "1", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" });
	setExtensionApi({ events: { emit() {} }, appendEntry() {} });
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	queries = [];
	deliveredUpdates = [];
	__testSetSdkQueryFactory(({ prompt, options }) => {
		const first = queries.length === 0;
		queries.push({ system: options.systemPrompt.prompt, prompt });
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "claude-system-update" };
				for (const matcher of options.hooks?.UserPromptSubmit ?? []) {
					for (const hook of matcher.hooks) {
						const result = await hook({ hook_event_name: "UserPromptSubmit" }, undefined, { signal: new AbortController().signal });
						if (result.hookSpecificOutput?.additionalContext) deliveredUpdates.push(result.hookSpecificOutput.additionalContext);
					}
				}
				if (first) {
					const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
					await options.mcpServers["custom-tools"].instance.connect(serverTransport);
					const client = new Client({ name: "offline-claude", version: "1.0.0" });
					await client.connect(clientTransport);
					try {
						yield { type: "assistant", message: { id: "tool-message", content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__echo", input: {} }] } };
						const result = await client.callTool({ name: "echo", arguments: {}, _meta: { "claudecode/toolUseId": "t1" } });
						for (const matcher of options.hooks?.PostToolUse ?? []) {
							for (const hook of matcher.hooks) {
								const update = await hook({ hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "mcp__custom-tools__echo" }, undefined, { signal: new AbortController().signal });
								if (update.hookSpecificOutput?.additionalContext) deliveredUpdates.push(update.hookSpecificOutput.additionalContext);
							}
						}
						yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: result.content }] } };
					} finally {
						await client.close();
					}
				}
				yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
				yield { type: "result", subtype: "success", result: "ok", session_id: "claude-system-update" };
			},
			close() {},
			async interrupt() {},
		};
	});
});

it("delivers a mid-tool rule through a system-context hook before the next reply", { timeout: 10_000 }, async () => {
	const start = [
		{ role: "system", content: "", sections: { rules: ORIGINAL_RULE }, toolsAdded: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }], timestamp: 0 },
		{ role: "user", content: "run echo", timestamp: 1 },
	];
	const calling = await send(start);
	const updated = [...start, calling,
		{ role: "toolResult", toolCallId: "t1", toolName: "echo", content: [{ type: "text", text: "result" }], timestamp: 2 },
		{ role: "system", content: "", sections: { rules: UPDATED_RULE }, timestamp: 3 },
	];
	const answer = await send(updated);
	assert.equal(answer.stopReason, "stop");
	assert.equal(deliveredUpdates.filter(text => text.includes(UPDATED_RULE)).length, 1, "the post-tool hook must deliver the changed rule before the next reply");
	await send([...updated, answer, { role: "user", content: "next task", timestamp: 4 }]);
	assert.ok(queries[1].system.includes(UPDATED_RULE), "a resumed query also receives the current rule");
	assert.equal(deliveredUpdates.filter(text => text.includes(UPDATED_RULE)).length, 1, "a new query must not resend an acknowledged update");
});

afterEach(() => {
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	deleteQueryLane(SESSION);
	deleteSharedSessionLane(SESSION);
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

async function send(messages) {
	const stream = streamClaudeAgentSdk(model, { messages }, { sessionId: SESSION, cwd: root });
	for await (const event of stream) {}
	return stream.result();
}

it("sends a system rule changed during a tool call with the next query", { timeout: 10_000 }, async () => {
	const start = [
		{ role: "system", content: "", sections: { rules: ORIGINAL_RULE }, toolsAdded: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }], timestamp: 0 },
		{ role: "user", content: "run echo", timestamp: 1 },
	];
	const calling = await send(start);
	assert.equal(calling.stopReason, "toolUse");
	const updated = [...start, calling,
		{ role: "system", content: "", sections: { rules: UPDATED_RULE }, timestamp: 2 },
		{ role: "toolResult", toolCallId: "t1", toolName: "echo", content: [{ type: "text", text: "result" }], timestamp: 3 },
	];
	const answer = await send(updated);
	assert.equal(answer.stopReason, "stop");
	await send([...updated, answer, { role: "user", content: "next task", timestamp: 4 }]);
	assert.equal(queries.length, 2);
	assert.ok(queries[1].system.includes(UPDATED_RULE), "the next query must receive the changed system rule");
	assert.ok(!queries[1].system.includes(ORIGINAL_RULE), "a replaced rule must not remain in the system prompt");
});
