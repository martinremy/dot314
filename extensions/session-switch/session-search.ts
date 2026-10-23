import type { SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";

const NAVIGATION_ACTIONS = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const;

const SessionSearchStateSchema = Type.Object({
	searchInput: Type.Unknown(),
	selectedIndex: Type.Number(),
	selectionTouched: Type.Boolean(),
});

/** Query edits select the first result; navigating the list keeps that session selected during updates. */
export function installSearchSelectionReset(selector: SessionSelectorComponent): void {
	const list = selector.getSessionList();
	// ponytail: Uses Pi's private search state until SessionList exposes query-change and selection-reset APIs.
	const state: unknown = list;
	if (!Check(SessionSearchStateSchema, state) || !(state.searchInput instanceof Input)) {
		throw new Error("Pi SessionList has an unsupported search-state shape");
	}
	const searchInput = state.searchInput;
	const handleInput = list.handleInput.bind(list);
	list.handleInput = (data) => {
		const query = searchInput.getValue();
		const selectionTouched = state.selectionTouched;
		handleInput(data);
		if (searchInput.getValue() !== query) {
			state.selectedIndex = 0;
			state.selectionTouched = false;
		} else {
			const kb = getKeybindings();
			const navigated = NAVIGATION_ACTIONS.some((action) => kb.matches(data, action));
			if (!navigated) state.selectionTouched = selectionTouched;
		}
	};
}
