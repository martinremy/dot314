import { readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

function canonicalize(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Returns a diagnostic rejection reason when the marker's Pi id or cwd differs. */
export function shouldRestorePersistedBridgeEntry(
	persisted: { piSessionId?: string; cwd: string },
	currentPiSessionId: string | undefined,
	currentCwd: string | undefined,
): string | undefined {
	if (!persisted.piSessionId) return "missing piSessionId";
	if (currentPiSessionId && persisted.piSessionId !== currentPiSessionId) {
		return `piSessionId mismatch (persisted=${persisted.piSessionId} current=${currentPiSessionId})`;
	}
	if (currentCwd && canonicalize(persisted.cwd) !== canonicalize(currentCwd)) {
		return `cwd mismatch (persisted=${persisted.cwd} current=${currentCwd})`;
	}
	return undefined;
}

interface RestoreIdentity {
	storedPiSessionId: string | undefined;
	currentPiSessionId: string | undefined;
	storedPiSessionFile: string | undefined;
	currentPiSessionFile: string | undefined;
	storedCwd: string;
	currentCwd: string | undefined;
	source: "own" | "parent";
}

type RestoredTranscriptOwnership = { kind: "own" } | { kind: "copy" } | { kind: "reject"; reason: string };

/** A copy may be read for a rebuild, but never resumed or replaced in place. */
export function assessRestoredTranscriptOwnership(identity: RestoreIdentity): RestoredTranscriptOwnership {
	const persisted = { piSessionId: identity.storedPiSessionId, cwd: identity.storedCwd };
	const rejection = shouldRestorePersistedBridgeEntry(persisted, identity.currentPiSessionId, undefined);
	if (rejection) {
		if (identity.source === "parent" && identity.storedPiSessionId && identity.currentPiSessionId) return { kind: "copy" };
		return { kind: "reject", reason: rejection };
	}
	if (!identity.currentPiSessionId || !identity.storedPiSessionFile || !identity.currentPiSessionFile ||
		canonicalize(identity.storedPiSessionFile) !== canonicalize(identity.currentPiSessionFile)) return { kind: "copy" };
	const cwdRejection = shouldRestorePersistedBridgeEntry(persisted, identity.currentPiSessionId, identity.currentCwd);
	return cwdRejection ? { kind: "reject", reason: cwdRejection } : { kind: "own" };
}

export type TranscriptInspection =
	| { kind: "unchanged" }
	| { kind: "changed"; reason: "leaf-missing" | "conversation-appended" }
	| { kind: "unavailable"; reason: "unreadable" | "malformed" | "incomplete" };

const blockSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), source: z.object({ type: z.string() }) }),
	z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.unknown() }),
	z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string() }),
	z.object({ type: z.literal("thinking"), thinking: z.string() }),
	z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
]);
const messageSchema = z.object({ model: z.string().optional(), content: z.union([z.string(), z.array(blockSchema)]) });
const recordSchema = z.object({
	type: z.string(),
	uuid: z.string().optional(),
	isSidechain: z.boolean().optional(),
	isMeta: z.boolean().optional(),
	message: messageSchema.optional(),
	attachment: z.object({ type: z.string() }).optional(),
}).refine(record => (record.type !== "user" && record.type !== "assistant") || record.message !== undefined);
type TranscriptRecord = z.infer<typeof recordSchema>;

const INTERRUPTION_MARKERS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

function isConversationInput(record: TranscriptRecord): boolean {
	if (record.isSidechain === true || record.isMeta === true) return false;
	if (record.type === "attachment") return Boolean(record.attachment) && record.attachment.type === "queued_command";
	if (record.type === "assistant") return record.message.model !== "<synthetic>";
	if (record.type !== "user") return false;
	const content = record.message.content;
	if (!Array.isArray(content)) return !INTERRUPTION_MARKERS.has(content);
	if (content.length === 1 && content[0].type === "text" && INTERRUPTION_MARKERS.has(content[0].text)) return false;
	return content.some(block => block.type !== "tool_result");
}

/** Scans complete JSONL records once; unreadable or partial evidence cannot prove safe reuse. */
export function inspectTranscriptAfterLeaf(transcriptPath: string, leafUuid: string): TranscriptInspection {
	let text: string;
	try { text = readFileSync(transcriptPath, "utf8"); } catch { return { kind: "unavailable", reason: "unreadable" }; }
	if (text.length > 0 && !text.endsWith("\n")) return { kind: "unavailable", reason: "incomplete" };
	let found = false;
	let appended = false;
	let start = 0;
	while (start < text.length) {
		const end = text.indexOf("\n", start);
		const line = text.slice(start, end).trim();
		start = end + 1;
		if (!line) continue;
		let raw: unknown;
		try { raw = JSON.parse(line); } catch { return { kind: "unavailable", reason: "malformed" }; }
		const parsed = recordSchema.safeParse(raw);
		if (!parsed.success) return { kind: "unavailable", reason: "malformed" };
		appended = appended || (found && isConversationInput(parsed.data));
		found = found || parsed.data.uuid === leafUuid;
	}
	if (!found) return { kind: "changed", reason: "leaf-missing" };
	return appended ? { kind: "changed", reason: "conversation-appended" } : { kind: "unchanged" };
}
