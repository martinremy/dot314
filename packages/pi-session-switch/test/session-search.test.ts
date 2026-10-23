import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	initTheme,
	SessionSelectorComponent,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

import { installSearchSelectionReset } from "../../../extensions/session-switch/session-search.ts";

const originalKeybindings = getKeybindings();
const keybindings = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.session.rename": { defaultKeys: "ctrl+r" },
	"app.session.delete": { defaultKeys: "ctrl+d" },
});
const keys = {
	tab: "\t",
	pageDown: "\x1b[6~",
	down: "\x1b[B",
	left: "\x1b[D",
	backspace: "\x7f",
	clearQuery: "\x15",
	enter: "\r",
	rename: "\x12",
	delete: "\x04",
	escape: "\x1b",
	pasteStart: "\x1b[200~",
	pasteEnd: "\x1b[201~",
};

beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(keybindings);
});

afterEach(() => {
	setKeybindings(originalKeybindings);
});

function session(id: string, text: string, modified: number): SessionInfo {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/project",
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: text,
		allMessagesText: text,
	};
}

async function openSelector(sessions: SessionInfo[], scope: "current" | "all") {
	let onRender = () => {};
	const selected: string[] = [];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		(path) => selected.push(path),
		() => {},
		() => {},
		() => onRender(),
		{ renameSession: async () => {} },
	);
	installSearchSelectionReset(selector);
	await new Promise<void>((resolve) => { onRender = resolve; });
	if (scope === "all") {
		await new Promise<void>((resolve) => {
			onRender = () => {
				if (selector.getSessionList().getSelectedSessionPath()) resolve();
			};
			selector.handleInput(keys.tab);
		});
	}
	return { selector, list: selector.getSessionList(), selected };
}

describe.each(["current", "all"] as const)("session search in %s scope", (scope) => {
	test("query edits bring the best match into view after paging through results", async () => {
		const recent = Array.from({ length: 60 }, (_, index) =>
			session(String(index).padStart(3, "0"), `a l p h a ${index}`, 1000 - index));
		const best = session("old", "alpha", 1);
		const { selector, list, selected } = await openSelector([...recent, best], scope);
		for (let page = 0; page < 5; page += 1) selector.handleInput(keys.pageDown);
		for (const char of "alpha") selector.handleInput(char);
		expect(list.getSelectedSessionPath()).toBe(best.path);
		expect(selector.render(100).join("\n")).toContain("alpha");

		selector.handleInput(keys.down);
		expect(list.getSelectedSessionPath()).toBe(recent[0]!.path);
		selector.handleInput(keys.backspace);
		expect(list.getSelectedSessionPath()).toBe(best.path);

		selector.handleInput(keys.clearQuery);
		expect(list.getSelectedSessionPath()).toBe(recent[0]!.path);
		selector.handleInput(`${keys.pasteStart}alpha${keys.pasteEnd}`);
		expect(list.getSelectedSessionPath()).toBe(best.path);
		selector.handleInput(keys.enter);
		expect(selected).toEqual([best.path]);
	});

	test("follows better loaded matches until the user navigates", async () => {
		const weak = session("one", "a l p h a", 3);
		const best = session("two", "alpha", 1);
		const newerBest = session("tri", "alpha", 2);
		const { selector, list } = await openSelector([weak], scope);
		selector.handleInput("alpha");
		selector.handleInput(keys.left);
		list.setSessions([weak, best], scope === "all");
		expect(list.getSelectedSessionPath()).toBe(best.path);

		selector.handleInput(keys.down);
		expect(list.getSelectedSessionPath()).toBe(weak.path);
		list.setSessions([weak, newerBest, best], scope === "all");
		expect(list.getSelectedSessionPath()).toBe(weak.path);
	});

	test("rename and delete-confirmation input do not reset search selection", async () => {
		const weak = session("one", "a l p h a", 3);
		const best = session("two", "alpha", 1);
		const { selector, list } = await openSelector([weak, best], scope);
		selector.handleInput("alpha");
		selector.handleInput(keys.down);
		expect(list.getSelectedSessionPath()).toBe(weak.path);

		selector.handleInput(keys.rename);
		selector.handleInput("another name");
		selector.handleInput(keys.escape);
		expect(list.getSelectedSessionPath()).toBe(weak.path);
		selector.handleInput(keys.delete);
		selector.handleInput("ignored text");
		selector.handleInput(keys.escape);
		expect(list.getSelectedSessionPath()).toBe(weak.path);
	});
});
