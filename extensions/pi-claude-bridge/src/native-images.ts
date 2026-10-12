import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { debug } from "./debug.ts";

const SOURCE_PREFIX = "[Image: source: ";
const imageSchema = z.object({ type: z.literal("image"), source: z.object({ type: z.literal("base64"), data: z.string(), media_type: z.string() }) });
const textSchema = z.object({ type: z.literal("text"), text: z.string() });
type ResultContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; data: string; media_type: string } };
/** Normalizes text and base64-image results into blocks, rejecting other content shapes. */
export const nativeResultContentSchema = z.union([z.string(), z.array(z.union([textSchema, imageSchema]))]).transform((content): ResultContentBlock[] => {
	if (!Array.isArray(content)) return [{ type: "text", text: content }];
	return content.map(block => block.type === "text" ? { type: "text", text: block.text } : { type: "image", source: { type: "base64", data: block.source.data, media_type: block.source.media_type } });
});
const IMAGE_MIME_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]);

/** Original bytes verified against Pi; data is base64 and filename is relative to the source session's tool-results directory. */
export interface SavedOriginalImage {
	readonly filename: string;
	readonly data: string;
}

interface VerifiedImageContent {
	content: ResultContentBlock[];
	originals: SavedOriginalImage[];
}

function savedFilesDir(transcript: string): string {
	return join(transcript.replace(/\.jsonl$/, ""), "tool-results");
}

function imageFilename(note: ResultContentBlock): string | undefined {
	if (note.type !== "text" || !note.text.startsWith(SOURCE_PREFIX) || !note.text.endsWith("]")) return undefined;
	return basename(note.text.slice(SOURCE_PREFIX.length, -1).split(", original ")[0]);
}

function savedImage(filename: string, transcript: string): Buffer | undefined {
	try {
		const project = realpathSync(dirname(transcript));
		const session = realpathSync(dirname(savedFilesDir(transcript)));
		const directory = realpathSync(savedFilesDir(transcript));
		if (dirname(session) !== project || dirname(directory) !== session) return undefined;
		const path = realpathSync(join(directory, filename));
		if (dirname(path) !== directory) return undefined;
		return readFileSync(path);
	} catch {
		debug("native image: original evidence is unavailable", JSON.stringify({ filename }));
		return undefined;
	}
}

/** Normalizes SDK previews for comparison and returns originals used as evidence; literal result text remains unchanged. */
export function verifiedStoredImages(blocks: ResultContentBlock[], wanted: ResultContentBlock[], transcript: string, metadata: "sdk" | "literal"): VerifiedImageContent {
	const restored: ResultContentBlock[] = [];
	const originals: SavedOriginalImage[] = [];
	let position = 0;
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		const expectedBlock = wanted[position];
		const suppliedBlock = isDeepStrictEqual(block, expectedBlock);
		if (metadata === "sdk" && index > 0 && blocks[index - 1].type === "image" && imageFilename(block) !== undefined && !suppliedBlock) {
			continue;
		}
		position++;
		const note = blocks[index + 1];
		const filename = Boolean(note) ? imageFilename(note) : undefined;
		if (metadata === "sdk" && block.type === "image" && Boolean(expectedBlock) && expectedBlock.type === "image" && (block.source.data !== expectedBlock.source.data || block.source.media_type !== expectedBlock.source.media_type) && filename !== undefined && IMAGE_MIME_TYPES.get(extname(filename)) === expectedBlock.source.media_type) {
			const saved = savedImage(filename, transcript);
			if (Boolean(saved) && saved.toString("base64") === expectedBlock.source.data) {
				restored.push(expectedBlock);
				originals.push({ filename, data: expectedBlock.source.data });
				continue;
			}
		}
		restored.push(block);
	}
	return { content: restored, originals };
}

/** Copies originals verified for the selected prefix; changed evidence and copy failures throw before the old session is removed. */
export function carrySavedImages(images: readonly SavedOriginalImage[], from: string, to: string): void {
	const copied = new Map<string, string>();
	for (const { filename, data } of images) {
		const previous = copied.get(filename);
		if (previous !== undefined) {
			if (previous !== data) throw new Error(`native image: conflicting originals for ${filename}`);
			continue;
		}
		const saved = savedImage(filename, from);
		if (!Boolean(saved) || saved.toString("base64") !== data) throw new Error(`native image: original changed after verification: ${filename}`);
		const target = join(savedFilesDir(to), filename);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, saved, { flag: "wx" });
		copied.set(filename, data);
	}
}
