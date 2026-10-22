// What loading the extension adds to Pi: the provider, its session hooks and
// the /pi-claude commands. It adds no Pi tool, so the tool list Claude gets is
// only the session's own tools.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import claudeBridge from "../src/index.ts";

function load() {
	const pi = {
		tools: [],
		commands: new Map(),
		on: () => {},
		registerCommand: (name, command) => pi.commands.set(name, command),
		registerProvider: () => {},
		registerTool: (tool) => pi.tools.push(tool.name),
		events: { emit: () => {} },
		appendEntry: () => {},
	};
	claudeBridge(pi);
	return pi;
}

describe("loading the extension", () => {
	for (const enabled of [true, false]) {
		it(`leaves the parent's traffic flag unchanged when enabled=${enabled}`, () => {
			const root = mkdtempSync(join(tmpdir(), "bridge-load-env-"));
			const keys = ["PI_CODING_AGENT_DIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
			const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
			try {
				process.env.PI_CODING_AGENT_DIR = root;
				writeFileSync(join(root, "claude-bridge.json"), JSON.stringify({ enabled }));
				for (const value of [undefined, "0"]) {
					if (value === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
					else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = value;
					load();
					assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, value);
				}
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				execFileSync("trash", [root]);
			}
		});
	}

	it("registers no Pi tool", () => {
		assert.deepEqual(load().tools, []);
	});

	it("marks the API object for a host that resumes turns", () => {
		assert.equal(load()[Symbol.for("kendex.pi.claude-bridge.host-resume.v1")], true);
	});

	it("answers /pi-claude incidents as an unknown argument", async () => {
		const notices = [];
		await load().commands.get("pi-claude").handler("incidents", { ui: { notify: (message, level) => notices.push([message, level]) }, cwd: process.cwd() });
		assert.deepEqual(notices, [["Unknown /pi-claude argument.", "warning"]]);
	});
});
