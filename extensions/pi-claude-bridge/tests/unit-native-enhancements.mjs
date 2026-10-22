import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { getSessionPath } from "cc-session-io";
import { getSharedSession, setExtensionApi, setSharedSession } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { restoreSharedSessionFromPi, schedulePersistSharedSession, syncSharedSession } from "../src/session-persistence.ts";
import { nativeTranscript, piPriors, PI_TOOL_NAMES, TOOL_NAMES, user } from "./fixtures/native-transcript.mjs";

const OLD = "11111111-2222-4333-8444-555555555555";
const MODEL = "claude-haiku-4-5";
const ORIGINAL = Buffer.from("original image").toString("base64");
const ENCODED = Buffer.from("re-encoded image").toString("base64");
const REPLACEMENT = Buffer.from("replacement image").toString("base64");
let root;
let cwd;
let claudeDir;
let previousEnv;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-native-enhancements-"));
	cwd = join(root, "project");
	claudeDir = join(root, "claude");
	mkdirSync(cwd);
	const env = { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_ISOLATED: "1" };
	previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
});

afterEach(() => {
	setExtensionApi(undefined);
	setSharedSession(null);
	resetStack();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	execFileSync("trash", [root]);
});

function writeTranscript(options = {}) {
	const transcript = nativeTranscript(OLD, cwd, options);
	const path = getSessionPath(OLD, cwd, claudeDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, transcript.records.map(JSON.stringify).join("\n") + "\n");
	return { ...transcript, path };
}

function writeImageTranscript(file) {
	const transcript = nativeTranscript(OLD, cwd, { imageResult1: ENCODED });
	const content = transcript.records.find(record => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_1").message.content[0].content;
	content[1].source.media_type = "image/jpeg";
	content[2].text = `[Image: source: ${file}, original 3000x2000, displayed at 1500x1000]`;
	const path = getSessionPath(OLD, cwd, claudeDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, transcript.records.map(JSON.stringify).join("\n") + "\n");
	return path;
}

const savedImagePath = () => join(getSessionPath(OLD, cwd, claudeDir).replace(/\.jsonl$/, ""), "tool-results", "image.png");
const rebuild = priors => syncSharedSession([...priors, user("next")], cwd, TOOL_NAMES, MODEL, undefined, { customToolNameToPi: PI_TOOL_NAMES });

for (const [name, content, expected] of [
	["mixed text and image", [{ type: "text", text: "  first" }, { type: "image", data: REPLACEMENT, mimeType: "image/png" }, { type: "text", text: "second \n" }], "first\nsecond"],
	["image-only", [{ type: "image", data: REPLACEMENT, mimeType: "image/png" }], "Command failed with no output"],
]) {
	it(`rebuilds ${name} failures twice as text only`, async () => {
		const priors = piPriors({ image1: ORIGINAL });
		priors[4].content = content;
		const original = structuredClone(priors);
		const results = sessionId => readFileSync(getSessionPath(sessionId, cwd, claudeDir), "utf8").trim().split("\n").map(JSON.parse)
			.flatMap(record => Array.isArray(record.message?.content) ? record.message.content.filter(block => block.type === "tool_result") : []);
		const first = await rebuild(priors);
		const imported = results(first.sessionId);
		assert.deepEqual(imported.map(block => [block.tool_use_id, block.is_error === true]), [["toolu_fixture_1", false], ["toolu_fixture_2", true], ["toolu_fixture_3", true]]);
		assert.equal(imported[1].content, expected);
		assert.ok(imported[0].content.some(block => block.type === "image" && block.source.data === ORIGINAL), "successful images remain in native history");
		setSharedSession({ ...getSharedSession(), needsRebuild: true, rebuildReason: "history-rewritten" });
		const second = await rebuild(priors);
		assert.equal(second.sync.forked, priors.length, "the native prefix matches the first import");
		assert.deepEqual(results(second.sessionId), imported);
		assert.deepEqual(priors, original);
	});
}

it("copies a previously imported failed result with its original image blocks", async () => {
	const transcript = writeTranscript();
	const failed = transcript.records.find(record => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_2").message.content[0];
	failed.content = [{ type: "text", text: "File not found: notes.md" }, { type: "image", source: { type: "base64", data: ORIGINAL, media_type: "image/png" } }];
	writeFileSync(transcript.path, transcript.records.map(JSON.stringify).join("\n") + "\n");
	const priors = piPriors();
	priors[4].content.push({ type: "image", data: ORIGINAL, mimeType: "image/png" });
	setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
	const result = await rebuild(priors);
	assert.equal(result.sync.forked, 7);
	const records = readFileSync(getSessionPath(result.sessionId, cwd, claudeDir), "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(records.find(record => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_2").message.content[0], failed);
});

it("copies only a fork's verified parent prefix into its own working directory", { timeout: 10_000 }, async () => {
	const old = writeTranscript();
	const bytes = readFileSync(old.path, "utf8");
	const appended = Promise.withResolvers();
	setExtensionApi({ appendEntry: (customType, data) => appended.resolve([{ type: "custom", customType, data }]) });
	setSharedSession({ sessionId: OLD, cursor: piPriors().length, cwd });
	schedulePersistSharedSession({ sessionManager: { getSessionId: () => "pi-parent", buildSessionContext: () => ({ messages: piPriors() }) } });
	const entries = await appended.promise;
	setSharedSession(null);
	const childCwd = join(root, "child-worktree");
	mkdirSync(childCwd);
	const context = { cwd: childCwd, sessionManager: { getEntries: () => entries, getSessionId: () => "pi-child", getCwd: () => childCwd, buildSessionContext: () => ({ messages: piPriors() }) } };
	restoreSharedSessionFromPi(context);
	assert.equal(getSharedSession(), null, "an ordinary restore cannot adopt another session's marker");
	restoreSharedSessionFromPi(context, "parent");
	appendFileSync(old.path, '{"type":"assistant"');
	const result = await syncSharedSession([...piPriors(), user("child task")], childCwd, TOOL_NAMES, MODEL, undefined, { customToolNameToPi: PI_TOOL_NAMES });
	assert.equal(result.sync.forked, 7);
	assert.notEqual(result.sessionId, OLD);
	assert.ok(existsSync(getSessionPath(result.sessionId, childCwd, claudeDir)));
	assert.equal(readFileSync(old.path, "utf8"), bytes + '{"type":"assistant"');
});

it("preserves verified original images when replacing their source session", async () => {
	const file = savedImagePath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, Buffer.from(ORIGINAL, "base64"));
	writeImageTranscript(file);
	setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
	const first = await rebuild(piPriors({ image1: ORIGINAL }));
	assert.equal(first.sync.forked, 7);
	assert.equal(existsSync(file), false, "the verified replacement deleted the original session");
	setSharedSession({ ...getSharedSession(), needsRebuild: true, rebuildReason: "history-rewritten" });
	const unchanged = await rebuild(piPriors({ image1: ORIGINAL }));
	assert.ok(unchanged.sync.forked >= 7, "the copied evidence still verifies the unchanged image");
	setSharedSession({ ...getSharedSession(), needsRebuild: true, rebuildReason: "history-rewritten" });
	const changed = await rebuild(piPriors({ image1: REPLACEMENT }));
	assert.equal(changed.sync.forked, 1);
	const text = readFileSync(getSessionPath(changed.sessionId, cwd, claudeDir), "utf8");
	assert.ok(text.includes(REPLACEMENT));
	assert.ok(!text.includes(ENCODED));
});

for (const evidence of ["missing", "changed", "outside", "symlink", "directory symlink", "session symlink"]) {
	it(`rejects re-encoded image evidence that is ${evidence}`, async () => {
		let file = savedImagePath();
		mkdirSync(dirname(file), { recursive: true });
		if (evidence === "changed") writeFileSync(file, Buffer.from(REPLACEMENT, "base64"));
		if (evidence === "outside" || evidence === "symlink") {
			const outside = join(root, "outside.png");
			writeFileSync(outside, Buffer.from(ORIGINAL, "base64"));
			if (evidence === "symlink") symlinkSync(outside, file);
			else file = outside;
		}
		if (evidence === "directory symlink" || evidence === "session symlink") {
			const directory = evidence === "directory symlink" ? dirname(file) : dirname(dirname(file));
			const outside = join(root, "outside-directory");
			const outsideFile = evidence === "directory symlink" ? join(outside, "image.png") : join(outside, "tool-results", "image.png");
			mkdirSync(dirname(outsideFile), { recursive: true });
			writeFileSync(outsideFile, Buffer.from(ORIGINAL, "base64"));
			execFileSync("trash", [directory]);
			symlinkSync(outside, directory);
		}
		writeImageTranscript(file);
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		const result = await rebuild(piPriors({ image1: ORIGINAL }));
		assert.equal(result.sync.forked, 1);
		const text = readFileSync(getSessionPath(result.sessionId, cwd, claudeDir), "utf8");
		assert.ok(text.includes(ORIGINAL));
		assert.ok(!text.includes(ENCODED));
	});
}

it("compares image-source-like text returned by Pi as ordinary tool content", async () => {
	const old = writeTranscript({ imageResult1: ORIGINAL });
	const records = old.records;
	const result = records.find(record => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_1");
	result.message.content[0].content.push({ type: "text", text: "[Image: source: old-user-text.png]" });
	writeFileSync(old.path, records.map(JSON.stringify).join("\n") + "\n");
	const priors = piPriors({ image1: ORIGINAL });
	priors[2].content.push({ type: "text", text: "[Image: source: changed-user-text.png]" });
	setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
	const copied = await rebuild(priors);
	assert.equal(copied.sync.forked, 1);
	const text = readFileSync(getSessionPath(copied.sessionId, cwd, claudeDir), "utf8");
	assert.ok(text.includes("changed-user-text.png"));
	assert.ok(!text.includes("old-user-text.png"));
});

it("does not treat image-source-like text in an imported Pi result as SDK metadata", async () => {
	const before = piPriors({ image1: ORIGINAL });
	before[2].content.push({ type: "text", text: "[Image: source: user-caption.png]" });
	await rebuild(before);
	setSharedSession({ ...getSharedSession(), needsRebuild: true, rebuildReason: "history-rewritten" });
	const after = piPriors({ image1: ORIGINAL });
	const replaced = await rebuild(after);
	assert.equal(replaced.sync.forked, 1);
	assert.ok(!readFileSync(getSessionPath(replaced.sessionId, cwd, claudeDir), "utf8").includes("user-caption.png"));
});

it("does not promote an unrelated saved file into evidence for a later replacement", async () => {
	const file = savedImagePath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, Buffer.from(REPLACEMENT, "base64"));
	const path = writeImageTranscript(file);
	const records = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
	const result = records.find(record => record.message?.content?.[0]?.tool_use_id === "toolu_fixture_1");
	result.message.content[0].content[1].source = { type: "base64", media_type: "image/png", data: ORIGINAL };
	writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
	setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "history-rewritten" });
	const first = await rebuild(piPriors({ image1: ORIGINAL }));
	assert.equal(first.sync.forked, 7);
	setSharedSession({ ...getSharedSession(), needsRebuild: true, rebuildReason: "history-rewritten" });
	const replaced = await rebuild(piPriors({ image1: REPLACEMENT }));
	assert.equal(replaced.sync.forked, 1);
});

for (const [name, content] of [["interactive_shell", "No such tool"], ["ToolSearch", [{ type: "tool_reference", tool_name: "mcp__custom-tools__bash" }]]]) {
	it(`copies Claude Code's self-answered ${name} call without adding it to Pi's tools`, async () => {
		const transcript = nativeTranscript(OLD, cwd);
		const at = transcript.records.findIndex(record => record.message?.content?.[0]?.id === "toolu_fixture_1");
		const next = transcript.records[at];
		const callId = "own-call";
		const callUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const resultUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const call = { ...next, uuid: callUuid, message: { ...next.message, content: [{ type: "tool_use", id: callId, name, input: name === "ToolSearch" ? { query: "select:mcp__custom-tools__bash" } : {} }] } };
		const result = { ...next, type: "user", uuid: resultUuid, parentUuid: callUuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content, is_error: name === "interactive_shell" }] } };
		next.parentUuid = resultUuid;
		transcript.records.splice(at, 0, call, result);
		const path = getSessionPath(OLD, cwd, claudeDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, transcript.records.map(JSON.stringify).join("\n") + "\n");
		setSharedSession({ sessionId: OLD, cursor: 5, cwd, needsRebuild: true, rebuildReason: "abort", forceRotate: true });
		const copied = await rebuild(piPriors());
		assert.equal(copied.sync.forked, 7);
		const records = readFileSync(getSessionPath(copied.sessionId, cwd, claudeDir), "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(records.filter(record => record.message?.content?.[0]?.id === callId).length, 1);
		assert.equal(records.filter(record => record.message?.content?.[0]?.tool_use_id === callId).length, 1);
	});
}
