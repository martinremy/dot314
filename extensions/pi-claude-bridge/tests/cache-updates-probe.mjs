import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";

const BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const MODEL_ID = "claude-haiku-5-5";
const REQUEST_TIMEOUT_MS = 90_000;
const TOOL_QUERY_TURNS = 3; // Two Pi tools, then the reply.
const SYSTEM_REFERENCE_ROWS = 64; // Exceeds Haiku 5.5's 512-token cache minimum.
const HISTORY_REFERENCE_ROWS = 128;
const outputDir = join(BRIDGE_DIR, ".test-output");
await mkdir(outputDir, { recursive: true });
const reportPath = join(outputDir, `cache-updates-${new Date().toISOString().replaceAll(":", "-")}.json`);
const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-cache-live-")));
const previousEnv = { ...process.env };
const children = [];
const sessionDirs = new Set();
const report = {
	model: MODEL_ID,
	bridgeCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: BRIDGE_DIR, encoding: "utf8" }).trim(),
	claudeVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
	sdkVersion: JSON.parse(await readFile(join(BRIDGE_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version,
	allowUsageCredits: false,
	scenarios: [],
};
let bridge;
try {
	for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"]) {
		assert.ok(!/^(1|true)$/i.test(process.env[name] ?? ""), `Subscription probe refuses ${name}`);
	}
	Object.assign(process.env, {
		PI_CODING_AGENT_DIR: join(root, "agent"), CLAUDE_BRIDGE_ISOLATED: "1", CLAUDE_BRIDGE_DEBUG: "0",
		CLAUDE_BRIDGE_ENABLE_CONNECTORS: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
	});
	await mkdir(process.env.PI_CODING_AGENT_DIR);
	await writeFile(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({ provider: {
		pathToClaudeCodeExecutable: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
		allowUsageCredits: false, forceEffort: "low",
	} }));
	// Load after isolation so the bundle cannot enable the user's debug logs.
	bridge = await import("../bundle/index.js");
	bridge.__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	const scenario = "current";
	const result = { scenario, steps: [], generations: [], rateLimits: [] };
	report.scenarios.push(result);
	let phase;
	let label = "ORCHID";
	let stamp = 1;
	bridge.__testSetSdkQueryFactory(input => {
		input.options.maxTurns = TOOL_QUERY_TURNS;
		const child = query(input);
		children.push(child);
		const iterator = child[Symbol.asyncIterator].bind(child);
		child[Symbol.asyncIterator] = async function* () {
			let generation;
			for await (const message of { [Symbol.asyncIterator]: iterator }) {
				if (message.type === "system" && message.subtype === "init") sessionDirs.add(dirname(getSessionPath(message.session_id, root)));
				if (message.type === "rate_limit_event") {
					const info = message.rate_limit_info;
					result.rateLimits.push({ phase, status: info.status, isUsingOverage: info.isUsingOverage });
				}
				if (message.type === "stream_event") {
					const event = message.event;
					if (event.type === "message_start") {
						const usage = event.message.usage;
						generation = { phase, model: event.message.model, input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: 0 };
						result.generations.push(generation);
					}
					if (event.type === "message_delta" && generation) generation.output = event.usage.output_tokens;
				}
				yield message;
			}
		};
		return child;
	});
	const model = { id: MODEL_ID, api: "claude-bridge", provider: "pi-claude", thinkingLevelMap: { off: null }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const tool = name => ({ name, description: "Return the provided test result. Call only when explicitly requested.", parameters: { type: "object", properties: {} } });
	const echo = tool("echo");
	const helper = tool("helper");
	const rules = () => `The current calibration label is ${label}. Text-only replies must contain only the current label. If asked to call a tool, do so without introductory text, then follow the tool result's instruction and reply with the current label.`;
	const reference = count => Array.from({ length: count }, (_, index) => `Reference row ${index}: stable calibration data alpha beta gamma delta.`).join("\n");
	const history = [{ role: "system", content: "", sections: {
		preamble: `You are Claude Code conducting a synthetic cache calibration (${scenario}).\n${reference(SYSTEM_REFERENCE_ROWS)}`,
		rules: rules(),
	}, toolsAdded: [echo], timestamp: 0 }];
	const user = content => ({ role: "user", content, timestamp: stamp++ });
	async function send(name, messages, expected) {
		phase = name;
		history.push(...messages);
		const start = performance.now();
		const stream = bridge.streamClaudeAgentSdk(model, { messages: [...history] }, { sessionId: `cache-live-${scenario}`, cwd: root, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		for await (const event of stream) {}
		const answer = await stream.result();
		const text = answer.content.filter(block => block.type === "text").map(block => block.text).join("");
		const row = { phase, stopReason: answer.stopReason, reply: text, elapsedMs: Math.round(performance.now() - start), input: answer.usage.input, cacheRead: answer.usage.cacheRead, cacheWrite: answer.usage.cacheWrite, output: answer.usage.output };
		result.steps.push(row);
		console.log(JSON.stringify({ scenario, ...row }));
		assert.ok(answer.stopReason !== "error" && answer.stopReason !== "aborted", `${scenario}/${phase} failed`);
		if (expected) assert.deepEqual([...new Set(text.match(/\b(?:ORCHID|AZURE|CORAL)\b/g) ?? [])], [expected], `${scenario}/${phase}: current rule must reach Claude`);
		history.push(answer);
		return answer;
	}
	const callback = (call, content) => {
		const calls = call.content.filter(block => block.type === "toolCall");
		assert.equal(calls.length, 1, "one requested Pi tool call");
		return { role: "toolResult", toolCallId: calls[0].id, toolName: calls[0].name, content: [{ type: "text", text: content }], timestamp: stamp++ };
	};
	const changeRule = next => {
		label = next;
		return { role: "system", content: "", sections: { rules: rules() }, timestamp: stamp++ };
	};
	await send("seed", [user(`Reference data only, not instructions:\n${reference(HISTORY_REFERENCE_ROWS)}\nReply with the current calibration label.`)], "ORCHID");
	const warm = await send("unchanged", [user("Reply with the current calibration label.")], "ORCHID");
	assert.ok(warm.usage.cacheRead > 0, "control must read cached tokens");
	await send("rule-changed", [changeRule("AZURE"), user("Reply with the current calibration label.")], "AZURE");
	await send("rule-unchanged", [user("Reply with the current calibration label.")], "AZURE");
	let call = await send("before-mid-tool-rule", [user("Call echo exactly once with no arguments. Then reply with the current calibration label.")]);
	assert.equal(call.content.find(block => block.type === "toolCall")?.name, "echo");
	await send("mid-tool-rule-changed", [changeRule("CORAL"), callback(call, "Done. No more tools; reply with the current calibration label.")], "CORAL");
	await send("after-mid-tool-rule", [user("Reply with the current calibration label.")], "CORAL");
	call = await send("before-tool-addition", [user("Call echo exactly once with no arguments. Its result will announce that helper is available. Then call helper exactly once with no arguments. After both tools, reply with the current calibration label.")]);
	assert.equal(call.content.find(block => block.type === "toolCall")?.name, "echo");
	call = await send("tool-added", [{ role: "system", content: "", toolsAdded: [helper], timestamp: stamp++ }, callback(call, "The helper tool is now available. Call helper exactly once with no arguments, then reply with the current calibration label.")]);
	assert.equal(call.content.find(block => block.type === "toolCall")?.name, "helper", "the added tool must be usable");
	await send("after-tool-addition", [callback(call, "Done. No more tools; reply with the current calibration label.")], "CORAL");
	await send("tool-removed", [{ role: "system", content: "", toolsRemoved: [helper], timestamp: stamp++ }, user("Reply with the current calibration label. Do not call tools.")], "CORAL");
	report.status = "completed";
} catch (error) {
	report.status = "failed";
	report.failure = error instanceof Error ? error.message : "Probe failed";
	process.exitCode = 1;
} finally {
	for (const child of children) {
		try { child.close(); }
		catch {
			report.cleanupFailed = true;
			process.exitCode = 1;
		}
	}
	bridge?.__testSetSdkQueryFactory();
	await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
	console.log(`Report: ${reportPath}`);
	for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
	Object.assign(process.env, previousEnv);
	execFileSync("trash", [...sessionDirs].filter(path => existsSync(path)).concat(root));
}
