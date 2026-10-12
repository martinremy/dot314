import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { EventBus, SessionEntry } from "@earendil-works/pi-coding-agent";

import { collectFilesTouched, registerFilesTouchedTracking } from "./files-touched-core.ts";
import type { FileTrackingHost, FileTrackingContext, FileTrackingHandlers, NestedCompletion } from "./files-touched-contract.ts";

const cwd = "/project";
const protocol = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
type HandlerLists = { [K in keyof FileTrackingHandlers]: FileTrackingHandlers[K][] };

function entries<Details>(details: Details, id = "exec-1", isError = false) {
	return [{ id: `result-${id}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "message", message: {
		role: "toolResult", toolName: "exec", toolCallId: id, timestamp: 1,
		content: [], details, isError,
	} }] satisfies SessionEntry[];
}

type ToolResultMessage = Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "toolResult" }>;

function codemodeResult(id: string, nestedCalls: NonNullable<ToolResultMessage["nestedCalls"]>) {
	return [{ id: `result-${id}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "message", message: {
		role: "toolResult", toolName: "codemode", toolCallId: id, timestamp: 1, content: [], isError: false, nestedCalls,
	} }] satisfies SessionEntry[];
}

function trace<Input, Details>(id: string, name: string, input: Input, status = "done", details?: Details) {
	const text = name === "rp" ? "## File Actions ✅" : "ok";
	return { id, name, input, status, result: { content: [{ type: "text", text }], details, isError: false } };
}

function snapshot(traces: Array<ReturnType<typeof trace>>, status = "result", droppedTraceCount = 0) {
	return { codeMode: true, cellId: "cell-1", status, traces, droppedTraceCount };
}

function assistantCall(id: string, name: string, args: { path: string } | { cmd: string } | { command: string }): SessionEntry {
	return { id: `call-${id}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "message", message: {
		role: "assistant", api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "toolCall", id, name, arguments: args }],
	} };
}

function harness() {
	const hooks: HandlerLists = {
		tool_execution_update: [], tool_result: [], session_start: [], session_tree: [], session_shutdown: [],
	};
	const emitter = new EventEmitter();
	const completions = new Set<(value: NestedCompletion) => void>();
	const inputs = new Map<string, { name: string; input: unknown }>();
	const warnings: string[] = [];
	const events: EventBus = {
		on(name, fn) {
			emitter.on(name, fn);
			return () => { emitter.off(name, fn); };
		},
		emit(name, value) { emitter.emit(name, value); },
	};
	const pi: FileTrackingHost = { events, on(name, fn) { hooks[name].push(fn); } };
	const ctx: FileTrackingContext = { hasUI: true, ui: { notify(message) { warnings.push(message); } } };
	const broker = { protocol, isActive: () => true, register() {
		throw new Error("The recorder must not subscribe to preflight");
	}, registerCompletion(fn: (value: NestedCompletion) => void) {
		completions.add(fn);
		return () => { completions.delete(fn); };
	} };
	events.on(`${protocol}/request`, () => events.emit(`${protocol}/available`, broker));
	registerFilesTouchedTracking(pi);
	const emit = (name: "session_tree" | "session_start" | "session_shutdown") => {
		inputs.clear();
		for (const fn of hooks[name]) fn();
	};
	const complete = <Result,>(id: string, status: "success" | "error", result: Result) => {
		const captured = inputs.get(id);
		assert.ok(captured);
		inputs.delete(id);
		for (const fn of completions) fn({ toolCallId: id, toolName: captured.name, input: captured.input, cwd, status, result });
	};
	const completeSnapshot = (details: ReturnType<typeof snapshot> | undefined) => {
		if (!details) return;
		for (const item of details.traces) {
			const captured = inputs.get(item.id);
			if (!captured || (item.status !== "done" && item.status !== "error")) continue;
			complete(item.id, item.status === "error" ? "error" : "success", item.result);
		}
	};
	return {
		pi, warnings, emit, complete,
		start<Input>(id: string, name: string, input: Input) {
			inputs.set(id, { name, input });
		},
		update(details: ReturnType<typeof snapshot>, id = "exec-1") {
			completeSnapshot(details);
			for (const fn of hooks.tool_execution_update) fn({ toolName: "exec", toolCallId: id, partialResult: { details } });
		},
		finish(details: ReturnType<typeof snapshot> | undefined, id = "exec-1", toolName = "exec", isError = false, input: { cell_id?: string } = {}) {
			completeSnapshot(details);
			let result: ReturnType<FileTrackingHandlers["tool_result"]> = undefined;
			for (const fn of hooks.tool_result) result = fn({ toolName, toolCallId: id, input, details, isError }, ctx) ?? result;
			if (isError) inputs.clear();
			return entries(result?.details ?? details, id);
		},
	};
}

test("nested traces record tool-mediated file activity even when the outer cell fails", () => {
	const files = collectFilesTouched(entries(snapshot([
		trace("read", "rp", { call: "read_file", args: { path: "/project/a.ts" } }),
		trace("edit", "rp", { call: "apply_edits", args: { path: "/project/a.ts" } }),
		trace("failed", "edit", { path: "/project/failed.ts" }, "error"),
		trace("running", "write", { path: "/project/running.ts" }, "running"),
	]), "exec-1", true), cwd);
	assert.deepEqual(files.map((file) => [file.path, [...file.operations]]), [["/project/a.ts", ["read", "edit"]]]);
});

test("completion hooks supply long patch inputs and save only file operations", () => {
	const h = harness();
	const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-" + "old".repeat(6000) + "\n+new\n*** End Patch";
	h.start("patch", "apply_patch", patch);
	const details = snapshot([trace("patch", "apply_patch", "[value truncated]", "done", {
		status: "success", result: { changedFiles: ["a.ts"], createdFiles: [], deletedFiles: [], movedFiles: [] },
	})]);
	const saved = h.finish(details);
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/a.ts"]);
	assert.equal(JSON.stringify(saved).includes("oldoldold"), false);
	assert.deepEqual(h.warnings, []);
});

test("saved traces retain known paths when non-path fields are truncated", () => {
	const saved = entries(snapshot([
		trace("write", "write", { path: "/project/large.ts", content: "[value truncated]" }),
		trace("rp-edit", "rp", { call: "apply_edits", args: { path: "/project/edit.ts", search: "[value truncated]", replace: "new" } }),
		trace("bad-path", "write", { path: "[value truncated]", content: "body" }),
	]));
	assert.deepEqual(
		collectFilesTouched(saved, cwd).map((file) => [file.path, [...file.operations]]).sort(),
		[["/project/edit.ts", ["edit"]], ["/project/large.ts", ["write"]]],
	);
});

test("live completions survive trace eviction and duplicate recorder registration", () => {
	const h = harness();
	registerFilesTouchedTracking(h.pi);
	h.start("first", "edit", { path: "first.ts" });
	h.update(snapshot([trace("first", "edit", { path: "first.ts" })], "running"));
	h.start("second", "write", { path: "second.ts" });
	const saved = h.finish(snapshot([trace("second", "write", { path: "second.ts" })], "result", 1));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path).sort(), ["/project/first.ts", "/project/second.ts"]);
	assert.deepEqual(h.warnings, []);
});

test("live success needs no RepoPrompt heading and full patch results survive trace truncation", () => {
	const h = harness();
	h.start("rp", "rp", { call: "file_actions", args: { action: "create", path: "/project/new.ts" } });
	h.complete("rp", "success", { content: [{ type: "text", text: "a different presentation" }], isError: false });
	const patch = "*** Begin Patch\n*** Update File: changed.ts\n@@\n-old\n+new\n*** End Patch";
	h.start("patch", "apply_patch", patch);
	h.complete("patch", "success", { details: {
		padding: "x".repeat(70_000), status: "success",
		result: { changedFiles: ["changed.ts"], createdFiles: [], deletedFiles: [], movedFiles: [] },
	} });
	const saved = h.finish(snapshot([
		trace("rp", "rp", "[value truncated]"),
		trace("patch", "apply_patch", "[value truncated]", "done", { trace_truncated: true }),
	]));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path).sort(), ["/project/changed.ts", "/project/new.ts"]);
	assert.deepEqual(h.warnings, []);
});

test("completion records stay with their owning cells when calls finish out of order", () => {
	const h = harness();
	for (const id of ["a", "b"]) {
		h.start(id, "edit", { path: `${id}.ts` });
		h.update({ ...snapshot([trace(id, "edit", {}, "running")], "running"), cellId: id }, `exec-${id}`);
	}
	h.complete("b", "success", {});
	h.complete("a", "success", {});
	for (const id of ["a", "b"]) {
		const saved = h.finish({ ...snapshot([trace(id, "edit", {})]), cellId: id }, `exec-${id}`);
		assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), [`/project/${id}.ts`]);
	}
	assert.deepEqual(h.warnings, []);
});

test("failed completions keep structured partial patch effects and skip calls with no result", () => {
	const h = harness();
	h.start("patch", "apply_patch", "*** Begin Patch\n*** Update File: yes.ts\n@@\n-old\n+new\n*** Update File: no.ts\n@@\n-old\n+new\n*** End Patch");
	h.complete("patch", "error", { details: { status: "partial_failure", result: {
		changedFiles: ["yes.ts"], createdFiles: [], deletedFiles: [], movedFiles: [],
	} } });
	h.start("cancelled", "edit", { path: "cancelled.ts" });
	h.complete("cancelled", "error", undefined);
	const saved = h.finish(snapshot([trace("patch", "apply_patch", "[value truncated]", "error"),
		trace("cancelled", "edit", {}, "error")], "terminated"));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/yes.ts"]);
	assert.deepEqual(h.warnings, []);
});

test("custom-tool string results retain no-op edit detection", () => {
	const h = harness();
	h.start("noop", "rp", { call: "apply_edits", args: { path: "unchanged.ts" } });
	h.complete("noop", "success", "Applied: 0");
	const saved = h.finish(snapshot([trace("noop", "rp", "[value truncated]")]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.deepEqual(h.warnings, []);
});

test("malformed completion results cannot turn uncertain edits into successful operations", () => {
	const h = harness();
	h.start("invalid", "edit", { path: "uncertain.ts" });
	assert.throws(() => h.complete("invalid", "success", { isError: "yes" }), /Invalid PCC tool result/);
	const saved = h.finish(snapshot([trace("invalid", "edit", { path: "uncertain.ts" })]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 1);
});

test("malformed saved operation records are rejected at the session boundary", () => {
	const saved = entries({ filesTouched: { version: 1, incomplete: false,
		calls: [{ toolCallId: "bad", actions: [{ kind: "touch", path: 42, operation: "edit" }] }],
	} });
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
});

test("malformed RepoPrompt CLI JSON reports incomplete attribution", () => {
	const h = harness();
	const input = { cmd: "rp-cli -c apply_edits -j '{not json}'" };
	h.start("invalid-cli", "exec_command", input);
	const saved = h.finish(snapshot([trace("invalid-cli", "exec_command", input)]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 1);
});

test("yielded cells attribute each completion once across exec and wait", () => {
	const h = harness();
	h.start("one", "edit", { path: "one.ts" });
	const one = trace("one", "edit", { path: "one.ts" });
	const first = h.finish(snapshot([one], "yielded"));
	h.start("two", "edit", { path: "two.ts" });
	const second = h.finish(snapshot([one, trace("two", "edit", { path: "two.ts" })]), "wait-1", "wait");
	assert.deepEqual(collectFilesTouched(first.concat(second), cwd).map((file) => file.path).sort(), ["/project/one.ts", "/project/two.ts"]);
	assert.deepEqual(collectFilesTouched(second, cwd).map((file) => file.path), ["/project/two.ts"]);
});

test("partial patches retain confirmed changes and cancelled calls add no edits", () => {
	const patch = "*** Begin Patch\n*** Update File: yes.ts\n@@\n-old\n+new\n*** Update File: no.ts\n@@\n-old\n+new\n*** End Patch";
	const files = collectFilesTouched(entries(snapshot([
		trace("patch", "apply_patch", patch, "error", {
			status: "partial_failure", result: { changedFiles: ["yes.ts"], createdFiles: [], deletedFiles: [], movedFiles: [] },
		}),
		trace("cancelled", "edit", { path: "cancelled.ts" }, "error"),
	], "terminated")), cwd);
	assert.deepEqual(files.map((file) => file.path), ["/project/yes.ts"]);
});

test("missing or truncated evidence warns without failing the enclosing tool", () => {
	const h = harness();
	const saved = h.finish(snapshot([trace("lost", "edit", { path: "[value truncated]" })], "result", 1));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 1);
});

test("Pi codemode call records attribute completed file tools like direct calls", () => {
	const files = collectFilesTouched(codemodeResult("cm-1", { complete: true, calls: [
		{ id: "cm-1/1", name: "read", status: "ok", arguments: { path: "/project/a.ts" } },
		{ id: "cm-1/2", name: "write", status: "ok", arguments: { path: "notes.md", content: "x" } },
		{ id: "cm-1/3", name: "edit", status: "error", arguments: { path: "/project/failed.ts", edits: [] }, error: "no match" },
		{ id: "cm-1/4", name: "bash", status: "ok", arguments: { command: "cd sub && mv old.ts new.ts" } },
		{ id: "cm-1/5", name: "rp", status: "ok", arguments: { call: "apply_edits", args: { path: "/project/b.ts" } } },
		{ id: "cm-1/6", name: "get_goal", status: "ok", arguments: {} },
	] }), cwd);
	assert.deepEqual(files.map((file) => [file.path, [...file.operations]]), [
		["/project/a.ts", ["read"]], ["/project/notes.md", ["write"]], ["/project/sub/new.ts", ["move"]], ["/project/b.ts", ["edit"]],
	]);
});

test("Pi codemode records that lost file-tool evidence report incomplete attribution", (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const files = collectFilesTouched([
		...codemodeResult("cm-lossy", { complete: false, calls: [
			{ id: "cm-lossy/1", name: "write", status: "ok", argumentsBytes: 9904 },
			{ id: "cm-lossy/2", name: "read", status: "ok", arguments: { path: "/project/kept.ts" } },
		] }),
		...codemodeResult("cm-unfinished", { complete: true, calls: [
			{ id: "cm-unfinished/1", name: "write", status: "unfinished", arguments: { path: "/project/maybe.ts", content: "x" } },
		] }),
		...codemodeResult("cm-patch", { complete: true, calls: [
			{ id: "cm-patch/1", name: "apply_patch", status: "ok", arguments: { input: "*** Begin Patch\n*** Add File: p.ts\n+x\n*** End Patch" } },
		] }),
	], cwd);
	assert.deepEqual(files.map((file) => [file.path, [...file.operations]]), [["/project/kept.ts", ["read"]]]);
	assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0].toolCallId), ["cm-lossy", "cm-unfinished", "cm-patch"]);
});

test("truncated read output does not make a known read incomplete", () => {
	const h = harness();
	h.start("read", "read", { path: "read.ts" });
	const read = trace("read", "read", { path: "read.ts" });
	read.result.content[0].text = "contents\n[Trace output truncated]";
	const saved = h.finish(snapshot([read]));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/read.ts"]);
	assert.deepEqual(h.warnings, []);
});

test("ordinary output and diff text containing trace markers are not missing file evidence", () => {
	for (const [name, input, details] of [
		["exec_command", { cmd: "cat test.ts" }, { output: 'const marker = "[value truncated]";' }],
		["rp", { call: "apply_edits", args: { path: "/project/test.ts" } }, { diff: '+const marker = "[value truncated]";' }],
	] as const) {
		const h = harness();
		h.start("marker", name, input);
		const saved = h.finish(snapshot([trace("marker", name, input, "done", details)]));
		assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/test.ts"]);
		assert.deepEqual(h.warnings, []);
	}
});

test("recorder ownership is shared across distinct Pi event-bus facades", () => {
	const h = harness();
	registerFilesTouchedTracking({ ...h.pi, events: { on: h.pi.events.on, emit: h.pi.events.emit } });
	const saved = h.finish(snapshot([trace("missing", "edit", { path: "[value truncated]" })]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 1);
});

test("repeated coverage gaps retain incomplete records but notify only once per session load", () => {
	const h = harness();
	for (const id of ["first", "second"]) {
		const saved = h.finish(snapshot([trace(id, "edit", { path: "[value truncated]" })]), id);
		const entry = saved[0];
		assert.ok(entry.message.details && "filesTouched" in entry.message.details);
		assert.equal(entry.message.details.filesTouched.incomplete, true);
	}
	assert.equal(h.warnings.length, 1);
	h.emit("session_tree");
	h.finish(snapshot([trace("tree", "edit", { path: "[value truncated]" })]));
	assert.equal(h.warnings.length, 1);
	h.emit("session_start");
	h.finish(snapshot([trace("new-session", "edit", { path: "[value truncated]" })]));
	assert.equal(h.warnings.length, 2);
});

test("a dropped completion after an observed start is reported as incomplete", () => {
	const h = harness();
	h.start("lost", "edit", { path: "lost.ts" });
	h.update(snapshot([trace("lost", "edit", { path: "lost.ts" }, "running")], "running"));
	h.start("other", "read", { path: "other.ts" });
	const saved = h.finish(snapshot([trace("other", "read", { path: "other.ts" })], "result", 1));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/other.ts"]);
	assert.equal(h.warnings.length, 1);
});

test("a no-op edit is excluded while earlier completed work survives cell cancellation", () => {
	const h = harness();
	h.start("read", "read", { path: "read.ts" });
	h.update(snapshot([trace("read", "read", { path: "read.ts" })], "running"));
	h.start("noop", "rp", { call: "apply_edits", args: { path: "noop.ts" } });
	const noop = trace("noop", "rp", { call: "apply_edits", args: { path: "noop.ts" } }, "done", { editNoop: true });
	noop.result.content[0].text = "Applied: 0";
	const saved = h.finish(snapshot([noop], "terminated"));
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/read.ts"]);
});

for (const cli of ["rp-cli", "rpce-cli"]) {
	for (const expression of [
		'read_file --path "/project/a b.ts"',
		'apply_edits path="/project/a b.ts" search=old replace=new',
		'call apply_edits {"path":"/project/a b.ts","search":"x && y","replace":"new"} && read other.ts',
	]) {
		test(`${cli} exec supports named arguments and chained JSON calls: ${expression}`, () => {
			const cmd = `${cli} --exec '${expression}'`;
			const files = collectFilesTouched(entries(snapshot([trace("shell", "exec_command", { cmd })])), cwd);
			assert.ok(files.some((file) => file.path === "/project/a b.ts"));
		});
	}
	for (const flag of ["-c", "--call"]) {
		test(`${cli} ${flag} JSON arguments preserve paths and escaped content`, () => {
			const cmd = `${cli} -w 1 ${flag} apply_edits -j '${JSON.stringify({ path: "/project/a b.ts", search: "a\nb", replace: "c" })}'`;
			const messages = [
				assistantCall("shell", "exec_command", { cmd }),
				...entries({}, "shell"),
			];
			assert.deepEqual(collectFilesTouched(messages, cwd).map((file) => file.path), ["/project/a b.ts"]);
		});
		test(`${cli} ${flag} JSON arguments allow leading whitespace`, () => {
			const cmd = `${cli} -w 1 ${flag} apply_edits -j ' ${JSON.stringify({ path: "/project/spaced.ts", search: "a", replace: "b" })}'`;
			const messages = [
				assistantCall("shell", "exec_command", { cmd }),
				...entries({}, "shell"),
			];
			assert.deepEqual(collectFilesTouched(messages, cwd).map((file) => file.path), ["/project/spaced.ts"]);
		});
	}
	test(`${cli} nested shell exec syntax tracks read and move`, () => {
		const cmd = `${cli} -e 'read "/project/a b.ts" && file move /project/old.ts /project/new.ts'`;
		const files = collectFilesTouched(entries(snapshot([trace("shell", "exec_command", { cmd, workdir: "/project" })])), cwd);
		assert.deepEqual(files.map((file) => [file.path, [...file.operations]]), [["/project/a b.ts", ["read"]], ["/project/new.ts", ["move"]]]);
	});
}

test("branch changes release pending completions before later trace ownership", () => {
	const h = harness();
	h.start("edit", "edit", { path: "abandoned.ts" });
	h.complete("edit", "success", {});
	h.emit("session_tree");
	const saved = h.finish(snapshot([trace("edit", "edit", { path: "selected.ts" })]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 1);
});

test("returned RepoPrompt errors are not successful file effects", () => {
	for (const details of [{ error: "blocked" }, { isError: true }]) {
		const h = harness();
		const input = { call: "apply_edits", args: { path: "never-edited.ts" } };
		h.start("returned-error", "rp", input);
		const saved = h.finish(snapshot([trace("returned-error", "rp", input, "done", details)]));
		assert.deepEqual(collectFilesTouched(saved, cwd), []);
	}
});

test("completion hooks retain the returned error flag even when the trace status is done", () => {
	const h = harness();
	const input = { call: "apply_edits", args: { path: "never-edited.ts" } };
	h.start("unknown", "rp", input);
	const failed = trace("unknown", "rp", input, "done", { mode: "call", tool: "apply_edits", editNoop: false });
	failed.result.content[0].text = "Search text not found";
	failed.result.isError = true;
	const saved = h.finish(snapshot([failed]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.equal(h.warnings.length, 0);
});

test("saved rp_exec blocked deletions are not recorded as successful effects", () => {
	const denied = trace("denied-delete", "rp_exec", { cmd: "file delete /project/keep.ts" }, "done", { blocked: true, reason: "delete" });
	denied.result.content[0].text = "Blocked potential delete command";
	const files = collectFilesTouched(entries(snapshot([denied])), cwd);
	assert.deepEqual(files, []);
});

test("RepoPrompt calls outside file tracking do not produce incomplete-file warnings", () => {
	const h = harness();
	const input = { call: "get_file_tree", args: { type: "roots" } };
	h.start("roots", "rp", input);
	const roots = trace("roots", "rp", input);
	roots.result.content[0].text = "## File Tree ✅";
	const saved = h.finish(snapshot([roots]));
	assert.deepEqual(collectFilesTouched(saved, cwd), []);
	assert.deepEqual(h.warnings, []);
});

test("nested RepoPrompt root spellings coalesce like direct tool calls", () => {
	const root = "/workspace/agent";
	const spellings = ["package.json", "agent/package.json", "agent:package.json", `${root}/package.json`];
	const files = collectFilesTouched(entries(snapshot(spellings.map((path, index) =>
		trace(`read-${index}`, "rp", { call: "read_file", args: { path } }),
	))), root);
	assert.deepEqual(files.map((file) => file.path), [`${root}/package.json`]);
});

test("an aborted outer call retains completed effects and releases unfinished inputs", () => {
	const h = harness();
	h.start("read", "read", { path: "read.ts" });
	h.start("unfinished", "edit", { path: "never-edited.ts" });
	h.update(snapshot([
		trace("read", "read", { path: "read.ts" }),
		trace("unfinished", "edit", { path: "never-edited.ts" }, "running"),
	], "running"));
	const saved = h.finish(undefined, "exec-1", "exec", true);
	assert.deepEqual(collectFilesTouched(saved, cwd).map((file) => file.path), ["/project/read.ts"]);
	assert.equal(h.warnings.length, 1);
	h.start("unfinished", "edit", { path: "selected.ts" });
	const after = h.finish(snapshot([trace("unfinished", "edit", { path: "selected.ts" })]), "exec-2");
	assert.deepEqual(collectFilesTouched(after, cwd).map((file) => file.path), ["/project/selected.ts"]);
});

test("completions arriving between exec and wait are saved in the wait result", () => {
	const h = harness();
	h.start("between", "edit", { path: "between.ts" });
	const before = h.finish(snapshot([trace("between", "edit", { path: "between.ts" }, "running")], "yielded"));
	const completed = trace("between", "edit", { path: "between.ts" });
	h.update(snapshot([completed], "running"));
	const after = h.finish(snapshot([completed]), "wait-1", "wait");
	assert.deepEqual(collectFilesTouched(before.concat(after), cwd).map((file) => file.path), ["/project/between.ts"]);
});

test("an aborted wait without a new trace snapshot releases its pending cell", () => {
	const h = harness();
	h.start("unfinished", "edit", { path: "never-edited.ts" });
	h.finish(snapshot([trace("unfinished", "edit", { path: "never-edited.ts" }, "running")], "yielded"));
	const aborted = h.finish(undefined, "wait-1", "wait", true, { cell_id: "cell-1" });
	assert.deepEqual(collectFilesTouched(aborted, cwd), []);
	assert.equal(h.warnings.length, 1);
	h.start("unfinished", "edit", { path: "later.ts" });
	const later = h.finish(snapshot([trace("unfinished", "edit", { path: "later.ts" })]), "exec-2");
	assert.deepEqual(collectFilesTouched(later, cwd).map((file) => file.path), ["/project/later.ts"]);
});

for (const cli of ["rp-cli", "rpce-cli"]) {
	test(`${cli} cannot resolve another workspace's relative paths from the shell cwd`, () => {
		const h = harness();
		const input = { cmd: `${cli} -w 99 -c apply_edits -j '{"path":"src/file.ts","search":"a","replace":"b"}'`, workdir: "/shell" };
		h.start("remote", "exec_command", input);
		const saved = h.finish(snapshot([trace("remote", "exec_command", input)]));
		assert.deepEqual(collectFilesTouched(saved, cwd), []);
		assert.equal(h.warnings.length, 1);
	});

	test(`${cli} cannot resolve another workspace's root-qualified paths from the shell cwd`, () => {
		const h = harness();
		const input = { cmd: `${cli} -w 99 -c apply_edits -j '{"path":"project:src/file.ts","search":"a","replace":"b"}'`, workdir: "/shell" };
		h.start("remote", "exec_command", input);
		const saved = h.finish(snapshot([trace("remote", "exec_command", input)]));
		assert.deepEqual(collectFilesTouched(saved, cwd), []);
		assert.equal(h.warnings.length, 1);
	});
}

test("direct and nested moves preserve the last redirect when a source path is reused", () => {
	const direct = (id: string, name: string, args: Parameters<typeof assistantCall>[2]): SessionEntry[] => [
		assistantCall(id, name, args),
		...entries({}, id),
	];
	const history = [
		...entries(snapshot([trace("move-first", "rp", { call: "file_actions", args: {
			action: "move", path: "/project/reused.ts", new_path: "/project/first.ts",
		} })])),
		...direct("write", "write", { path: "reused.ts" }),
		...direct("read", "read", { path: "reused.ts" }),
		...direct("move-last", "bash", { command: "mv reused.ts last.ts" }),
	];
	const files = collectFilesTouched(history, cwd);
	assert.deepEqual([...files.find((file) => file.path === "/project/first.ts")!.operations], ["move"]);
	assert.deepEqual([...files.find((file) => file.path === "/project/last.ts")!.operations].sort(), ["move", "read", "write"]);
});

test("rp_exec and shell CLIs share named argument spellings and create classification", () => {
	for (const pathArg of ['path="project:a b.ts"', '--path "project:a b.ts"', '--path="project:a b.ts"']) {
		const files = collectFilesTouched(entries(snapshot([trace(pathArg, "rp_exec", {
			cmd: `file_actions --action=create ${pathArg}`,
		})])), cwd);
		assert.deepEqual(files.map((file) => [file.path, [...file.operations]]), [["/project/a b.ts", ["write"]]]);
	}
	const moved = collectFilesTouched(entries(snapshot([trace("move", "rp_exec", {
		cmd: 'file_actions action=move path=old.ts --new-path="new file.ts"',
	})])), cwd);
	assert.deepEqual(moved.map((file) => [file.path, [...file.operations]]), [["/project/new file.ts", ["move"]]]);
});
