import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createSession, getSessionPath, parseJsonlFile } from "cc-session-io";
import { getSharedSession, setExtensionApi, setSharedSession } from "../src/bridge-state.ts";
import { __testCancelAllScheduledSessionPersistence, restoreSharedSessionFromPi, schedulePersistSharedSession, syncSharedSession } from "../src/session-persistence.ts";

const messages = [
	{ role: "user", content: "hello", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
];
let root;
let cwd;
let claudeDir;
let previousDir;
let entries;
let manager;
let native;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-ownership-"));
	cwd = join(root, "project");
	claudeDir = join(root, "claude");
	mkdirSync(cwd);
	previousDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	native = createSession({ projectPath: cwd, claudeDir });
	native.addUserMessage("hello");
	native.addAssistantMessage([{ type: "text", text: "answer" }], { model: "claude-haiku-4-5" });
	native.save();
	entries = [];
	const piFile = join(root, "pi.jsonl");
	writeFileSync(piFile, "");
	manager = {
		getSessionId: () => "pi-original",
		getSessionFile: () => piFile,
		getCwd: () => cwd,
		getEntries: () => entries,
		buildSessionContext: () => ({ messages }),
	};
	setExtensionApi({ appendEntry(customType, data) {
		entries.push({ type: "custom", customType, data });
		writeFileSync(piFile, entries.map(JSON.stringify).join("\n") + "\n");
	} });
	setSharedSession({ sessionId: native.sessionId, cursor: 2, cwd, transcriptLeaf: native.records.at(-1).uuid });
});

afterEach(() => {
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	setSharedSession(null);
	if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousDir;
	execFileSync("trash", [root]);
});

async function persist() {
	schedulePersistSharedSession({ sessionManager: manager });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(entries.length, 1);
	setSharedSession(null);
}

it("persists Pi file provenance and native checkpoint, and restores an owned marker", async () => {
	await persist();
	assert.equal(entries[0].data.piSessionFile, manager.getSessionFile());
	assert.equal(entries[0].data.transcriptLeaf, native.records.at(-1).uuid);
	restoreSharedSessionFromPi({ sessionManager: manager });
	assert.equal(getSharedSession().inherited, undefined);
	assert.equal(getSharedSession().transcriptLeaf, native.records.at(-1).uuid);
	assert.equal("piSessionId" in getSharedSession(), false);
	assert.equal("piSessionFile" in getSharedSession(), false);
});

for (const identity of ["copied Pi file", "marker without a file path", "Pi session without a file"]) {
	it(`rebuilds a ${identity} separately and leaves its source files intact`, async () => {
		await persist();
		const sourceFile = native.jsonlPath;
		const companion = join(sourceFile.replace(/\.jsonl$/, ""), "tool-results", "output.txt");
		mkdirSync(dirname(companion), { recursive: true });
		writeFileSync(companion, "source companion");
		const original = readFileSync(sourceFile);
		const currentCwd = join(root, "other-project");
		mkdirSync(currentCwd);
		if (identity === "copied Pi file") {
			const copy = join(root, "copy.jsonl");
			copyFileSync(manager.getSessionFile(), copy);
			entries = readFileSync(copy, "utf8").trim().split("\n").map(JSON.parse);
			manager.getSessionFile = () => copy;
			manager.getCwd = () => currentCwd;
		} else if (identity === "marker without a file path") delete entries[0].data.piSessionFile;
		else manager.getSessionFile = () => undefined;
		restoreSharedSessionFromPi({ sessionManager: manager });
		assert.equal(getSharedSession()?.inherited, true);
		assert.equal(getSharedSession().rebuildReason, "inherited");
		assert.equal(getSharedSession().cwd, cwd);
		schedulePersistSharedSession({ sessionManager: manager });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(entries.length, 1, "a read-only source is never persisted as owned");
		const rebuilt = await syncSharedSession([...messages, { role: "user", content: "next" }], currentCwd, undefined, undefined, undefined, { fork: false });
		assert.notEqual(rebuilt.sessionId, native.sessionId);
		assert.deepEqual(readFileSync(sourceFile), original);
		assert.equal(readFileSync(companion, "utf8"), "source companion");
		assert.equal(parseJsonlFile(getSessionPath(rebuilt.sessionId, currentCwd, claudeDir))[0].message.content, "hello");
		schedulePersistSharedSession({ sessionManager: manager });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(entries.at(-1).data.piSessionFile, manager.getSessionFile());
	});
}

it("recognizes a symlink to the same Pi file as owned", async () => {
	await persist();
	const alias = join(root, "alias.jsonl");
	symlinkSync(manager.getSessionFile(), alias);
	manager.getSessionFile = () => alias;
	restoreSharedSessionFromPi({ sessionManager: manager });
	assert.equal(getSharedSession().inherited, undefined);
});

it("requires explicit parent mode for another Pi id, even with another cwd", async () => {
	await persist();
	manager.getSessionId = () => "pi-child";
	manager.getCwd = () => join(root, "child");
	restoreSharedSessionFromPi({ sessionManager: manager });
	assert.equal(getSharedSession(), null);
	restoreSharedSessionFromPi({ sessionManager: manager }, "parent");
	assert.equal(getSharedSession().inherited, true);
});

for (const field of ["piSessionId", "piSessionFile", "transcriptLeaf"]) {
	it(`rejects invalid persisted ${field} metadata`, async () => {
		await persist();
		entries[0].data[field] = 42;
		restoreSharedSessionFromPi({ sessionManager: manager }, "parent");
		assert.equal(getSharedSession(), null);
	});
}

it("captures session identity with the scheduled native snapshot", async () => {
	schedulePersistSharedSession({ sessionManager: manager });
	manager.getSessionId = () => "pi-replacement";
	manager.getSessionFile = () => join(root, "replacement.jsonl");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(entries[0].data.piSessionId, "pi-original");
	assert.equal(entries[0].data.piSessionFile, join(root, "pi.jsonl"));
});
