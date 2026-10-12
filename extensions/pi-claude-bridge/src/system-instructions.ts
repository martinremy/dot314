import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@earendil-works/pi-ai";

/** Delivers changed instructions once per running query through SDK system context. */
export function systemInstructionHooks(initial: string, render: (messages: Context["messages"]) => string) {
	let current = initial;
	let delivered = initial;
	const take: HookCallback = async (input, _toolUseId, options) => {
		if (options.signal.aborted || current === delivered) return {};
		const text = current;
		delivered = text;
		if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") {
			throw new Error("Claude bridge: unexpected instruction hook event");
		}
		return { hookSpecificOutput: {
			hookEventName: input.hook_event_name,
			additionalContext: `Pi's current system instructions replace the previous instructions:\n\n${text}`,
		} };
	};
	return {
		update(messages: Context["messages"]) { current = render(messages); },
		hooks: { PostToolUse: [{ hooks: [take] }], PostToolUseFailure: [{ hooks: [take] }] },
	};
}
