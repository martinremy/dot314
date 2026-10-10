// Pi records a change to its system prompt as a later system message in the
// history (pi-ai transcript.ts): `content` is appended to the prompt and
// `sections` patch it by name. A Claude Code session keeps the system prompt
// Pi's leading system messages render, and each later system message reaches
// Claude as a note where Pi holds it, as Pi's own Anthropic provider sends it
// mid-conversation. A changed system prompt would make Claude Code re-send
// the whole conversation uncached.

import { contentText, getCurrentSystemMessage, type Context } from "@earendil-works/pi-ai";

type PiMessage = Context["messages"][number];

/** The note for each of Pi's later system messages that changes the system
 *  prompt the bridge sends, by message. */
export type SystemNotes = ReadonlyMap<PiMessage, string>;

/** How many system messages open the history: the prompt a session keeps. */
export function leadingSystemCount(messages: Context["messages"]): number {
	let count = 0;
	while (messages[count]?.role === "system") count++;
	return count;
}

/** The notes for `messages`. `render` is the system prompt the bridge sends
 *  for a history. A note names each section the prompt the bridge sends
 *  starts or stops carrying as written, or carries changed; the bridge drops
 *  some of Pi's (its tool list reaches Claude as tool definitions), and which
 *  ones depends on Pi's base. It falls back to the whole new prompt when the
 *  change shows in no section. */
export function systemPromptNotes(messages: Context["messages"], render: (messages: Context["messages"]) => string): SystemNotes {
	const notes = new Map<PiMessage, string>();
	let before: string | undefined;
	for (let index = leadingSystemCount(messages); index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "system") continue;
		before ??= render(messages.slice(0, index));
		const after = render(messages.slice(0, index + 1));
		if (after === before) continue;
		const previous = getCurrentSystemMessage(messages.slice(0, index))?.sections ?? {};
		const current = getCurrentSystemMessage(messages.slice(0, index + 1))?.sections ?? {};
		const parts: string[] = [];
		const text = contentText(message.content);
		if (text && after.includes(text)) parts.push(text);
		for (const name of new Set([...Object.keys(current), ...Object.keys(previous)])) {
			const old = previous[name];
			const now = current[name];
			const had = Boolean(old) && before.includes(old!);
			const has = Boolean(now) && after.includes(now!);
			if (has && (now !== old || !had)) parts.push(`Updated system prompt section "${name}":\n\n${now}`);
			else if (had && !has) parts.push(`Removed system prompt section "${name}".`);
		}
		const body = parts.length > 0 ? parts.join("\n\n") : `The system prompt now reads:\n\n${after}`;
		notes.set(message, `<system-reminder>\nPi changed your system prompt. Follow it as changed here.\n\n${body}\n</system-reminder>`);
		before = after;
	}
	return notes;
}
