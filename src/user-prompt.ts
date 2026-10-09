// The prompt a fresh query sends Claude Code for Pi's trailing user
// messages. Claude Code records exactly this as the prompt's user record, so
// a rebuild that keeps Claude Code's own records (native-fork.ts) compares
// Pi's user messages through the same functions.

import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import { isSkippedAssistant, lastConversationIndex, messageContentToText } from "./convert.ts";
import { debug } from "./debug.ts";

/** Claude Code's own record of an Esc that cut off a reply. */
export const INTERRUPTED_MARKER = "[Request interrupted by user]";

/** Where the prompt of a query that sends Pi's whole context starts: the
 *  trailing user messages, with any reply among them that failed or was cut
 *  off by Esc. The import drops such a reply (convert.ts isSkippedAssistant),
 *  so as history the unanswered message before it would end Claude Code's
 *  transcript, and Claude Code resumes a transcript that ends on a user
 *  message with a synthetic "No response requested." reply, which Claude
 *  reads as its own. In the prompt, a cut-off reply reads as Claude Code's
 *  own record of the Esc. System messages among or after them belong to the
 *  run but add nothing to the prompt (convert.ts lastConversationIndex). */
export function promptRunStart(messages: Context["messages"]): number {
	let start = lastConversationIndex(messages);
	if (messages[start]?.role !== "user") return start;
	while (start > 0 && (messages[start - 1].role === "user" || messages[start - 1].role === "system" || isSkippedAssistant(messages[start - 1]))) start--;
	return start;
}

/** The content each message of a prompt run contributes, in order: a user
 *  message's own, INTERRUPTED_MARKER for a reply cut off by Esc, nothing for
 *  a failed one. Null when the run holds no user message or anything that
 *  belongs in history. */
function promptParts(run: Context["messages"]): Array<string | Extract<Context["messages"][number], { role: "user" }>["content"]> | null {
	const messages = run.filter((message) => message.role !== "system");
	if (!messages.some((message) => message.role === "user")) return null;
	if (messages.some((message) => message.role !== "user" && !isSkippedAssistant(message))) return null;
	return messages.flatMap((message) =>
		message.role === "user" ? [message.content] : message.role === "assistant" && message.stopReason === "aborted" ? [INTERRUPTED_MARKER] : []);
}

/** Whether Claude Code would read `content` as one of its own slash commands:
 *  a fresh prompt then runs the command and never reaches Claude, and a
 *  message queued mid-turn is held until the turn ends. Pi has already run
 *  its own commands, so whatever reaches the bridge is meant for Claude; the
 *  bridge sends such a message with `client_composed: true`, which delivers
 *  it as written. That also skips Claude Code's per-turn reminders on that
 *  turn, so only messages with a text block that starts with "/" get it. */
export function slashLed(content: string | ContentBlockParam[]): boolean {
	const texts = typeof content === "string" ? [content] : content.flatMap((block) => block.type === "text" ? [block.text] : []);
	return texts.some((text) => text.trimStart().startsWith("/"));
}

/** Combine a prompt run (promptRunStart) into a single SDK prompt.
 *
 *  Representation divergence, accepted on purpose: this MERGES N pi user
 *  messages into ONE Claude user record ("\n\n"-joined), while a REBUILD
 *  (convertPiMessages in convert.ts) imports the same pi history as N separate
 *  user records. Streaming N SDKUserMessages instead would collapse N pi turns
 *  into one Pi reply with double-counted usage, so the join stays. The merged
 *  form is only ever a query's live prompt — it is never re-imported. A
 *  rebuild that forks Claude Code's own transcript (native-fork.ts) keeps
 *  the merged record when it equals this join of Pi's whole run of user
 *  messages, and imports Pi's messages after it as separate records. */
export function extractUserPrompt(messages: Context["messages"]): string | null {
	const parts = promptParts(messages);
	if (!parts) return null;
	return parts.map((content) => typeof content === "string" ? content : messageContentToText(content) || "").join("\n\n");
}

/** Combine consecutive user messages as ContentBlockParam[] while preserving images.
 *  Returns null if no images — caller should fall back to the string prompt.
 *  Same N-into-1 merge as extractUserPrompt (see its comment for why). */
export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const parts = promptParts(messages);
	if (!parts) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (let partIndex = 0; partIndex < parts.length; partIndex++) {
		const content = parts[partIndex];
		if (partIndex > 0) blocks.push({ type: "text", text: "\n\n" });
		if (typeof content === "string") {
			if (content) blocks.push({ type: "text", text: content });
			continue;
		}
		if (!Array.isArray(content)) {
			debug(`extractUserPromptBlocks: content is ${typeof content}`);
			continue;
		}
		debug(`extractUserPromptBlocks: ${content.length} blocks, types=${content.map((b: any) => b.type).join(",")}`);
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
				if (!(block as any).data || !(block as any).mimeType) {
					debug(`image block missing data or mimeType, skipping`);
					continue;
				}
				hasImage = true;
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
				});
			}
		}
	}
	return hasImage ? blocks : null;
}
