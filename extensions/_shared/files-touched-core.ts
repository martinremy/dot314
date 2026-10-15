import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { collectNestedFileActions as collectNested, registerNestedFileTracking } from "./files-touched-nested.ts";
import {
	PatchArgumentsSchema, CommandArgumentsSchema, BashArgumentsSchema, OperationCallSchema,
	type FileAction, type IncomingFileCall, type FileCallResult, type FileCallParser, type ParsedFileActions, type FileTrackingHost,
} from "./files-touched-contract.ts";

export type FileTouchOperation = "read" | "write" | "edit" | "move" | "delete";

export interface FilesTouchedEntry {
	path: string;
	displayPath: string;
	operations: Set<FileTouchOperation>;
	lastTimestamp: number;
}

type FileMove = {
	from: string;
	to: string;
};

export type CodexFileTrackingAction = FileAction;

type TrackedToolCall =
	| { kind: "patch"; input: string }
	| { kind: "invalid-patch" }
	| { kind: "operations"; result: ParsedFileActions };

type TrackedTouchRecord = {
	path: string;
	operation: FileTouchOperation;
	timestamp: number;
};

type ParsedRootPrefixedPath = {
	root: string;
	relativePath: string;
};

type RootInfo = {
	absolutePath: string;
	name: string;
};

function uniqStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}

		seen.add(trimmed);
		out.push(trimmed);
	}

	return out;
}

function normalizePathSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

function normalizeSegments(value: string, preserveLeadingParents = true): string {
	const normalized = normalizePathSeparators(value);
	const segments: string[] = [];

	for (const segment of normalized.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}

		if (segment === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") {
				segments.pop();
				continue;
			}
			if (!preserveLeadingParents) {
				continue;
			}
		}

		segments.push(segment);
	}

	return segments.join("/");
}

function normalizeRelativePath(value: string): string {
	return normalizeSegments(value.trim());
}

function normalizeAbsolutePath(value: string): string {
	const normalized = normalizePathSeparators(value.trim());
	const windowsMatch = normalized.match(/^([A-Za-z]:)(?:\/(.*))?$/);
	if (windowsMatch) {
		const drive = windowsMatch[1].toUpperCase();
		const segments = normalizeSegments(windowsMatch[2], false);
		return segments ? `${drive}/${segments}` : `${drive}/`;
	}

	const segments = normalizeSegments(normalized, false);
	return segments ? `/${segments}` : "/";
}

function isAbsolutePath(value: string): boolean {
	const normalized = normalizePathSeparators(value.trim());
	return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

/** Expands a leading `~` or `~/` to the home directory, as the shell and Pi's file tools do */
function expandHomeDirectory(value: string): string {
	return value === "~" || value.startsWith("~/") ? `${os.homedir()}${value.slice(1)}` : value;
}

function resolvePathFromBase(pathValue: string, basePath: string | null | undefined): string {
	if (isAbsolutePath(pathValue)) {
		return normalizeAbsolutePath(pathValue);
	}

	const relativePath = normalizeRelativePath(pathValue);
	if (!basePath) {
		return relativePath;
	}
	if (!relativePath) {
		return isAbsolutePath(basePath) ? normalizeAbsolutePath(basePath) : normalizeRelativePath(basePath);
	}

	return isAbsolutePath(basePath)
		? normalizeAbsolutePath(`${normalizeAbsolutePath(basePath)}/${relativePath}`)
		: normalizeRelativePath(`${normalizeRelativePath(basePath)}/${relativePath}`);
}

function stripReadSliceSuffix(value: string): string {
	return value.replace(/:(\d+)-(\d+)$/, "");
}

function firstDefinedString(...values: Array<unknown>): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	return null;
}

function parseRootPrefixedPath(value: string): ParsedRootPrefixedPath | null {
	const normalized = normalizePathSeparators(value.trim());
	if (!normalized || isAbsolutePath(normalized)) {
		return null;
	}

	const match = normalized.match(/^([^/:]+):(.*)$/);
	if (!match) {
		return null;
	}

	const relativePath = normalizeRelativePath(match[2]);
	if (!relativePath) {
		return null;
	}

	return {
		root: match[1],
		relativePath,
	};
}

function splitPathSegments(value: string): string[] {
	return normalizePathSeparators(value).split("/").filter(Boolean);
}

function deriveRootFromAbsoluteAndRelative(absPath: string, relativePath: string): string | null {
	const absSegments = splitPathSegments(normalizeAbsolutePath(absPath));
	const relSegments = splitPathSegments(normalizeRelativePath(relativePath));
	if (relSegments.length === 0 || absSegments.length <= relSegments.length) {
		return null;
	}

	for (let index = 1; index <= relSegments.length; index += 1) {
		if (absSegments[absSegments.length - index] !== relSegments[relSegments.length - index]) {
			return null;
		}
	}

	const rootSegments = absSegments.slice(0, absSegments.length - relSegments.length);
	const rootPath = rootSegments.join("/");
	return /^[A-Za-z]:$/.test(rootPath) ? `${rootPath}/` : /^[A-Za-z]:\//.test(rootPath) ? rootPath : `/${rootPath}`;
}

function inferRootMappings(paths: string[]): Map<string, string> {
	const absolutePaths = uniqStrings(
		paths
			.filter((value) => isAbsolutePath(value))
			.map((value) => normalizeAbsolutePath(value)),
	);
	const rootRefs = paths
		.map((value) => parseRootPrefixedPath(value))
		.filter((value): value is ParsedRootPrefixedPath => Boolean(value));
	const scoresByRoot = new Map<string, Map<string, number>>();

	for (const ref of rootRefs) {
		const rootScores = scoresByRoot.get(ref.root) ?? new Map<string, number>();
		for (const absolutePath of absolutePaths) {
			const candidateRoot = deriveRootFromAbsoluteAndRelative(absolutePath, ref.relativePath);
			if (!candidateRoot) {
				continue;
			}

			const bonus = path.basename(candidateRoot) === ref.root ? 2 : 1;
			rootScores.set(candidateRoot, (rootScores.get(candidateRoot) ?? 0) + bonus);
		}

		scoresByRoot.set(ref.root, rootScores);
	}

	const out = new Map<string, string>();
	for (const [root, scores] of scoresByRoot) {
		const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
		if (ranked.length === 0) {
			continue;
		}

		if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
			continue;
		}

		out.set(root, ranked[0][0]);
	}

	return out;
}

function getCurrentRootInfo(cwd: string | null | undefined): RootInfo | null {
	if (!cwd || !isAbsolutePath(cwd)) {
		return null;
	}

	const absolutePath = normalizeAbsolutePath(cwd);
	return {
		absolutePath,
		name: path.basename(absolutePath),
	};
}

function buildRootMappings(paths: string[], cwd: string | null | undefined): Map<string, string> {
	const mappings = inferRootMappings(paths);
	const currentRoot = getCurrentRootInfo(cwd);
	if (currentRoot) {
		mappings.set(currentRoot.name, currentRoot.absolutePath);
	}
	return mappings;
}

function isWithinPath(filePath: string, rootPath: string): boolean {
	return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function findRootForAbsolutePath(
	absolutePath: string,
	rootMappings: Map<string, string>,
): { root: string; relativePath: string } | null {
	const normalizedAbsolutePath = normalizeAbsolutePath(absolutePath);
	let bestMatch: { root: string; relativePath: string; rootPathLength: number } | null = null;

	for (const [root, rootPath] of rootMappings) {
		if (!isWithinPath(normalizedAbsolutePath, rootPath) || normalizedAbsolutePath === rootPath) {
			continue;
		}

		const relativePath = normalizedAbsolutePath.slice(rootPath.length + 1);
		if (!relativePath) {
			continue;
		}

		if (!bestMatch || rootPath.length > bestMatch.rootPathLength) {
			bestMatch = { root, relativePath, rootPathLength: rootPath.length };
		}
	}

	return bestMatch ? { root: bestMatch.root, relativePath: bestMatch.relativePath } : null;
}

function normalizeTrackedPath(
	pathValue: string,
	rootMappings: Map<string, string>,
	cwd: string | null | undefined,
): string {
	const strippedPath = stripReadSliceSuffix(pathValue.trim());
	if (!strippedPath) {
		return "";
	}

	const rootPrefixed = parseRootPrefixedPath(strippedPath);
	if (rootPrefixed) {
		return `${rootPrefixed.root}:${rootPrefixed.relativePath}`;
	}

	if (isAbsolutePath(strippedPath)) {
		const rooted = findRootForAbsolutePath(strippedPath, rootMappings);
		return rooted ? `${rooted.root}:${rooted.relativePath}` : normalizeAbsolutePath(strippedPath);
	}

	const currentRoot = getCurrentRootInfo(cwd);
	let relativePath = strippedPath;
	if (currentRoot && (relativePath === currentRoot.name || relativePath.startsWith(`${currentRoot.name}/`))) {
		relativePath = relativePath === currentRoot.name ? "" : relativePath.slice(currentRoot.name.length + 1);
	}

	const normalizedRelativePath = normalizeRelativePath(relativePath);
	if (!normalizedRelativePath) {
		return currentRoot?.absolutePath ?? "";
	}

	const rootedRelative = [...rootMappings.keys()]
		.sort((left, right) => right.length - left.length)
		.find((root) => normalizedRelativePath.startsWith(`${root}/`));
	if (rootedRelative) {
		return `${rootedRelative}:${normalizedRelativePath.slice(rootedRelative.length + 1)}`;
	}

	return currentRoot ? `${currentRoot.name}:${normalizedRelativePath}` : normalizedRelativePath;
}

function resolveCanonicalPath(
	canonicalPath: string,
	rootMappings: Map<string, string>,
	cwd: string | null | undefined,
): string {
	if (!canonicalPath) {
		return canonicalPath;
	}

	if (isAbsolutePath(canonicalPath)) {
		return normalizeAbsolutePath(canonicalPath);
	}

	const rootPrefixed = parseRootPrefixedPath(canonicalPath);
	if (rootPrefixed) {
		const currentRoot = getCurrentRootInfo(cwd);
		const rootPath = rootMappings.get(rootPrefixed.root)
			?? (currentRoot?.name === rootPrefixed.root ? currentRoot.absolutePath : null);
		if (!rootPath) {
			return canonicalPath;
		}

		return `${rootPath}/${rootPrefixed.relativePath}`;
	}

	const normalizedRelativePath = normalizeRelativePath(canonicalPath);
	if (!normalizedRelativePath) {
		return getCurrentRootInfo(cwd)?.absolutePath ?? canonicalPath;
	}

	const currentRoot = getCurrentRootInfo(cwd);
	return currentRoot ? `${currentRoot.absolutePath}/${normalizedRelativePath}` : normalizedRelativePath;
}

function fallbackDisplayPath(canonicalPath: string): string {
	const rootPrefixed = parseRootPrefixedPath(canonicalPath);
	if (!rootPrefixed) {
		return canonicalPath;
	}

	return `${rootPrefixed.root}/${rootPrefixed.relativePath}`;
}

function findRepoRootForDisplay(absolutePath: string, currentRoot: string | null): string | null {
	const normalizedAbsolutePath = normalizeAbsolutePath(absolutePath);
	if (currentRoot && isWithinPath(normalizedAbsolutePath, currentRoot)) {
		return currentRoot;
	}

	let candidate = normalizedAbsolutePath;
	try {
		const stats = fs.existsSync(candidate) ? fs.statSync(candidate) : null;
		if (stats?.isFile()) {
			candidate = normalizeAbsolutePath(path.dirname(candidate));
		}
	} catch {
		// fall through with the original path-derived candidate
	}

	for (;;) {
		if (fs.existsSync(path.join(candidate, ".git"))) {
			return candidate;
		}

		const parent = normalizeAbsolutePath(path.dirname(candidate));
		if (parent === candidate) {
			return null;
		}
		candidate = parent;
	}
}

function displayPathForTrackedPath(
	canonicalPath: string,
	resolvedPath: string,
	cwd: string | null | undefined,
): string {
	if (!resolvedPath || !isAbsolutePath(resolvedPath)) {
		return fallbackDisplayPath(canonicalPath);
	}

	const currentRoot = getCurrentRootInfo(cwd);
	if (currentRoot && isWithinPath(resolvedPath, currentRoot.absolutePath)) {
		return resolvedPath.slice(currentRoot.absolutePath.length + 1);
	}

	const repoRoot = findRepoRootForDisplay(resolvedPath, currentRoot?.absolutePath ?? null);
	if (!repoRoot || !isWithinPath(resolvedPath, repoRoot)) {
		return fallbackDisplayPath(canonicalPath);
	}

	const relativePath = resolvedPath.slice(repoRoot.length + 1);
	return relativePath ? `${path.basename(repoRoot)}/${relativePath}` : path.basename(repoRoot);
}

function resolveMoveRedirect(pathValue: string, redirects: Map<string, string>): string {
	let current = pathValue;
	const seen = new Set<string>();

	while (redirects.has(current) && !seen.has(current)) {
		seen.add(current);
		current = redirects.get(current) ?? current;
	}

	return current;
}

function extractJsonObject(text: string, prefix: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(prefix)) {
		return null;
	}

	const jsonText = trimmed.slice(prefix.length).trim();
	if (!jsonText.startsWith("{")) {
		return null;
	}

	try {
		const parsed = JSON.parse(jsonText);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function extractCliNamedArg(cmd: string, key: string): string | null {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("_", "[-_]");
	const match = cmd.match(new RegExp(`(?:^|\\s)(?:${escapedKey}=|--${escapedKey}(?:=|\\s+))(?:\"([^\"]+)\"|'([^']+)'|(\\S+))`));
	return firstDefinedString(...(match?.slice(1) ?? []));
}

function commandStartsWith(cmd: string, name: string): boolean {
	const trimmed = cmd.trim();
	return trimmed === name || trimmed.startsWith(`${name} `);
}

function extractReadPathFromCliCommand(cmd: string): string | null {
	if (commandStartsWith(cmd, "read_file")) {
		const target = extractCliNamedArg(cmd, "path");
		return target === null ? null : stripReadSliceSuffix(target);
	}

	const simpleReadMatch = cmd.match(/^(?:read|cat)\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))/);
	if (simpleReadMatch) {
		return stripReadSliceSuffix(firstDefinedString(...simpleReadMatch.slice(1)) ?? "");
	}

	return null;
}

function tokenizeShellCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	// The shell expands ~ only when it starts a word unquoted
	let unquotedTilde = false;

	const flush = () => {
		if (current) {
			tokens.push(unquotedTilde ? expandHomeDirectory(current) : current);
			current = "";
		}
		unquotedTilde = false;
	};

	for (let index = 0; index < cmd.length; index += 1) {
		const char = cmd[index];
		const next = cmd[index + 1] ?? "";

		if (escaped) {
			// A backslash-newline is a line continuation and adds nothing to the word
			if (char !== "\n") current += char;
			escaped = false;
			continue;
		}

		if (quote) {
			if (char === "\\" && quote === '"' && /["\\$`\n]/.test(next)) {
				escaped = true;
				continue;
			}

			if (char === quote) {
				quote = null;
				continue;
			}

			current += char;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			flush();
			continue;
		}

		unquotedTilde ||= char === "~" && !current;
		current += char;
	}

	flush();
	return tokens;
}

function splitCommandSources(cmd: string): string[] {
	const commands: string[] = [];
	let start = 0;
	// True between words, the only place where # starts a comment
	let atWordStart = true;
	// The ) that closes a $(...) ends the substitution, not the word that contains it
	const substitutionCloses = new Set<number>();
	for (let index = 0; index < cmd.length; index++) {
		const opaqueEnd = skipShellQuoting(cmd, index) ?? skipShellArithmetic(cmd, index);
		if (opaqueEnd !== undefined) {
			index = opaqueEnd - 1;
			atWordStart = false;
			continue;
		}
		const char = cmd[index];
		if (char === "#" && atWordStart) {
			commands.push(cmd.slice(start, index));
			const lineEnd = cmd.indexOf("\n", index);
			index = lineEnd === -1 ? cmd.length : lineEnd;
			start = index + 1;
			continue;
		}
		if (cmd.startsWith("$(", index)) substitutionCloses.add(findParenGroupEnd(cmd, index + 1) - 1);
		atWordStart = SHELL_WORD_BOUNDARY.test(char) && !substitutionCloses.has(index);
		// Redirection operators containing & or | (>&, <&, >|, &>, &>>) stay inside the current command
		if ((char === ">" || char === "<") && (cmd[index + 1] === "&" || (char === ">" && cmd[index + 1] === "|"))) { index++; continue; }
		if (char === "&" && cmd[index + 1] === ">") continue;
		if (!";|&\r\n".includes(char)) continue;
		commands.push(cmd.slice(start, index));
		start = index + 1;
	}
	commands.push(cmd.slice(start));
	return commands.map((command) => command.trim()).filter(Boolean);
}

function splitShellCommands(cmd: string): string[][] {
	return splitCommandSources(cmd).map(tokenizeShellCommand);
}

function stripShellCommandWrappers(tokens: string[]): string[] {
	let current = [...tokens];

	while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(current[0])) {
		current = current.slice(1);
	}

	for (const wrapper of ["command", "env", "noglob", "sudo"]) {
		if (current[0] !== wrapper) {
			continue;
		}

		current = current.slice(1);
		while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(current[0])) {
			current = current.slice(1);
		}
	}

	return current;
}

function extractShellOperands(tokens: string[]): string[] {
	const operands: string[] = [];
	let allowFlags = true;

	for (const token of tokens) {
		if (allowFlags && token === "--") {
			allowFlags = false;
			continue;
		}

		if (allowFlags && token.startsWith("-")) {
			continue;
		}

		operands.push(token);
	}

	return operands;
}

function extractHeadTailReadOperands(tokens: string[]): string[] {
	const operands: string[] = [];
	let allowFlags = true;
	let skipNextOptionValue = false;

	for (const token of tokens) {
		if (skipNextOptionValue) {
			skipNextOptionValue = false;
			continue;
		}

		if (allowFlags && token === "--") {
			allowFlags = false;
			continue;
		}

		if (allowFlags && (token === "-n" || token === "-c" || token === "--lines" || token === "--bytes")) {
			skipNextOptionValue = true;
			continue;
		}

		if (
			allowFlags
			&& (token.startsWith("-") || /^[+]\d+[bcflkm]?$/.test(token))
		) {
			continue;
		}

		operands.push(token);
	}

	return operands;
}

function isIgnoredRedirectTarget(value: string): boolean {
	return value === "/dev/null" || value === "/dev/stderr" || value === "/dev/stdout";
}

function isLiteralShellPathOperand(value: string): boolean {
	return !/[`$]/.test(value) && !value.startsWith("<(") && !value.startsWith(">(");
}

function pushShellTouch(
	actions: FileAction[],
	pathValue: string,
	operation: Exclude<FileTouchOperation, "move">,
): void {
	if (isLiteralShellPathOperand(pathValue)) {
		actions.push({ kind: "touch", path: pathValue, operation });
	}
}

function pushShellMove(actions: FileAction[], from: string, to: string): void {
	if (isLiteralShellPathOperand(from) && isLiteralShellPathOperand(to)) {
		actions.push({ kind: "move", from, to });
	}
}

// Longest first, so a shorter operator never matches the start of a longer one
const SHELL_REDIRECTION_OPERATORS = ["&>>", "<<<", "<<-", "<<~", "&>", ">>", ">&", ">|", "<<", "<&", "<>", ">", "<"] as const;
type ShellRedirectionOperator = typeof SHELL_REDIRECTION_OPERATORS[number];
const OUTPUT_FILE_REDIRECTIONS: ReadonlySet<ShellRedirectionOperator> = new Set(["&>>", "&>", ">>", ">|", ">"]);

// Unquoted characters that end a shell word
const SHELL_WORD_BOUNDARY = /[\s()<>;&|]/;

/** Returns the index just past a backslash escape or quoted string starting at `index`, or undefined when none starts there */
function skipShellQuoting(source: string, index: number): number | undefined {
	const char = source[index];
	if (char === "\\") return Math.min(index + 2, source.length);
	if (char !== "'" && char !== '"') return undefined;
	for (let end = index + 1; end < source.length; end++) {
		if (char === '"' && source[end] === "\\") {
			end++;
			continue;
		}
		// A command substitution inside double quotes has its own quoting, so its quotes do not end the string
		if (char === '"' && source.startsWith("$(", end)) {
			end = findParenGroupEnd(source, end + 1) - 1;
			continue;
		}
		if (source[end] === char) return end + 1;
	}
	return source.length;
}

function readShellRedirectionOperator(source: string, offset: number): ShellRedirectionOperator | undefined {
	const operator = SHELL_REDIRECTION_OPERATORS.find((candidate) => source.startsWith(candidate, offset));
	// <( and >( start process substitutions, not redirections
	if ((operator === ">" || operator === "<") && source[offset + 1] === "(") return undefined;
	// zsh reads >>(cmd) as > followed by the process substitution >(cmd)
	if (operator === ">>" && source[offset + 2] === "(") return ">";
	return operator;
}

const PROCESS_SUBSTITUTION_START = /^[<>]\(/;

function findShellWordEnd(source: string, start: number): number {
	let index = start;
	while (index < source.length && !SHELL_WORD_BOUNDARY.test(source[index])) {
		// $(...) and $((...)) belong to the word even though they contain parentheses and spaces
		index = skipShellQuoting(source, index) ?? (source.startsWith("$(", index) ? findParenGroupEnd(source, index + 1) : index + 1);
	}
	return index;
}

/**
 * Returns the index just past the parenthesis that closes the one at `openIndex`, or the source length when it is unclosed.
 * Quoted and escaped parentheses are text, not nesting.
 */
function findParenGroupEnd(source: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < source.length; index++) {
		const quotedEnd = skipShellQuoting(source, index);
		if (quotedEnd !== undefined) {
			index = quotedEnd - 1;
			continue;
		}
		if (source[index] === "(") depth++;
		else if (source[index] === ")" && --depth === 0) return index + 1;
	}
	return source.length;
}

/**
 * Returns the index just past an arithmetic expansion $((...)) starting at `index`, or an arithmetic command ((...))
 * starting a word there, otherwise undefined. Their | & < > are operators, not separators or redirections.
 */
function skipShellArithmetic(source: string, index: number): number | undefined {
	if (source.startsWith("$((", index)) return findParenGroupEnd(source, index + 1);
	const startsWord = index === 0 || SHELL_WORD_BOUNDARY.test(source[index - 1]);
	return startsWord && source.startsWith("((", index) ? findParenGroupEnd(source, index) : undefined;
}

/** A redirection target word: where it ends, and the file writes it records */
type ShellRedirectionTarget = { end: number; actions: FileAction[] };

/** Reads the target word of the redirection operator that ends at `operatorEnd` */
function readShellRedirectionTarget(source: string, operator: ShellRedirectionOperator, operatorEnd: number): ShellRedirectionTarget {
	let targetStart = operatorEnd;
	while (source[targetStart] === " " || source[targetStart] === "\t") targetStart++;
	// A process substitution such as >(cat) starts the target word even though it begins with a redirection character
	if (PROCESS_SUBSTITUTION_START.test(source.slice(targetStart, targetStart + 2))) {
		const substitutionEnd = findParenGroupEnd(source, targetStart + 1);
		// The substituted command's own literal output redirections still write files
		const innerCommand = source.slice(targetStart + 2, substitutionEnd).replace(/\)$/, "");
		return { end: findShellWordEnd(source, substitutionEnd), actions: parseShellRedirections(innerCommand).actions };
	}
	const end = findShellWordEnd(source, targetStart);
	const target = tokenizeShellCommand(source.slice(targetStart, end)).at(0);
	const actions: FileAction[] = [];
	if (target !== undefined && OUTPUT_FILE_REDIRECTIONS.has(operator) && !isIgnoredRedirectTarget(target)) {
		pushShellTouch(actions, target, "write");
	}
	return { end, actions };
}

/** One command segment with its redirections removed, and the file writes those redirections record */
type ParsedShellRedirections = { commandSource: string; actions: FileAction[] };

/**
 * Removes every redirection (operator, adjacent descriptor prefix, and target word) from one raw command segment,
 * returning the remaining command text and a write action for each literal output-file target.
 * Works on raw text so quoted or escaped operator characters stay literal.
 */
function parseShellRedirections(source: string): ParsedShellRedirections {
	const actions: FileAction[] = [];
	const retained: string[] = [];
	let keptFrom = 0;
	let wordStart = 0;
	let index = 0;

	while (index < source.length) {
		const opaqueEnd = skipShellQuoting(source, index) ?? skipShellArithmetic(source, index);
		if (opaqueEnd !== undefined) {
			index = opaqueEnd;
			continue;
		}

		const operator = readShellRedirectionOperator(source, index);
		if (operator) {
			// A descriptor prefix is the whole unquoted word touching the operator, as in 2>err.log
			const start = operator[0] !== "&" && /^\d+$/.test(source.slice(wordStart, index)) ? wordStart : index;
			const target = readShellRedirectionTarget(source, operator, index + operator.length);
			actions.push(...target.actions);
			// A space keeps the words on either side of the removed redirection apart
			retained.push(source.slice(keptFrom, start), " ");
			keptFrom = target.end;
			index = target.end;
			wordStart = index;
			continue;
		}

		index++;
		if (SHELL_WORD_BOUNDARY.test(source[index - 1])) wordStart = index;
	}

	retained.push(source.slice(keptFrom));
	return { commandSource: retained.join(""), actions };
}

function looksLikeSedExpression(value: string): boolean {
	return /^[sy]?\/.+\//.test(value) || /^\d+[,\d]*[acdipqs]?$/.test(value);
}

function stripHeredocBodies(cmd: string): string {
	const lines = cmd.split("\n");
	const result: string[] = [];
	let terminator: string | null = null;
	let justClosedHeredoc = false;

	for (const line of lines) {
		if (terminator !== null) {
			if (line.trim() === terminator) {
				terminator = null;
				justClosedHeredoc = true;
			}
			continue;
		}

		const match = line.match(/<<-?\s*(?:['"]([\w]+)['"]|([\w]+))/);
		if (match) {
			terminator = match.at(1) ?? match.at(2) ?? null;
		}

		if (justClosedHeredoc) {
			result.push("; " + line);
			justClosedHeredoc = false;
		} else {
			result.push(line);
		}
	}

	return result.join("\n");
}

type ParsedShellCommand = { command: string[]; actions: FileAction[] };

function handleGitShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "git") return false;
	if (command[1] === "mv") {
		const operands = extractShellOperands(command.slice(2));
		if (operands.length === 2) pushShellMove(actions, operands[0], operands[1]);
	}
	if (command[1] === "rm") {
		for (const operand of extractShellOperands(command.slice(2))) pushShellTouch(actions, operand, "delete");
	}
	return true;
}

function handleMoveShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "mv") return false;
	const operands = extractShellOperands(command.slice(1));
	if (operands.length === 2) pushShellMove(actions, operands[0], operands[1]);
	return true;
}

function handleDeleteShellCommand(command: string[], actions: FileAction[]): boolean {
	if (!["rm", "trash", "trash-put", "unlink"].includes(command[0])) return false;
	for (const operand of extractShellOperands(command.slice(1))) pushShellTouch(actions, operand, "delete");
	return true;
}

function handleSedShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "sed") return false;
	if (command.some((token) => /^-[a-z]*i/.test(token))) {
		const hasExplicitExpr = command.some((token) => token === "-e" || token === "-f");
		const operands = extractShellOperands(command.slice(1));
		const fileOperands = hasExplicitExpr ? operands : operands.slice(1);
		for (const operand of fileOperands) if (!looksLikeSedExpression(operand)) pushShellTouch(actions, operand, "edit");
	}
	return true;
}

function handleCopyShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "cp" && command[0] !== "rsync") return false;
	const operands = extractShellOperands(command.slice(1));
	if (operands.length >= 2) pushShellTouch(actions, operands[operands.length - 1], "write");
	return true;
}

function handleMultiWriteShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "tee" && command[0] !== "touch") return false;
	for (const operand of extractShellOperands(command.slice(1))) pushShellTouch(actions, operand, "write");
	return true;
}

function handlePatchShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] !== "patch") return false;
	const operands = extractShellOperands(command.slice(1));
	if (operands.length >= 1) pushShellTouch(actions, operands[0], "edit");
	return true;
}

function handleDownloadShellCommand(command: string[], actions: FileAction[]): boolean {
	const flag = command[0] === "curl" ? ["-o", "--output"] : command[0] === "wget" ? ["-O", "--output-document"] : [];
	if (flag.length === 0) return false;
	for (let index = 1; index < command.length - 1; index++) {
		if (command[index] === flag[0] || command[index] === flag[1]) {
			pushShellTouch(actions, command[index + 1], "write");
			break;
		}
	}
	return true;
}

function handleReadShellCommand(command: string[], actions: FileAction[]): boolean {
	if (command[0] === "cat") {
		for (const operand of extractShellOperands(command.slice(1))) pushShellTouch(actions, operand, "read");
		return true;
	}
	if (command[0] !== "head" && command[0] !== "tail") return false;
	for (const operand of extractHeadTailReadOperands(command.slice(1))) pushShellTouch(actions, operand, "read");
	return true;
}

const SHELL_COMMAND_HANDLERS = [
	handleGitShellCommand, handleMoveShellCommand, handleDeleteShellCommand, handleSedShellCommand,
	handleCopyShellCommand, handleMultiWriteShellCommand, handlePatchShellCommand, handleDownloadShellCommand,
	handleReadShellCommand,
];

function parseShellCommand(source: string): ParsedShellCommand {
	const { commandSource, actions } = parseShellRedirections(source);
	const command = stripShellCommandWrappers(tokenizeShellCommand(commandSource));
	for (const handle of SHELL_COMMAND_HANDLERS) if (handle(command, actions)) break;
	return { command, actions };
}

type ApplyPatchCandidate =
	| { kind: "add" | "update" | "delete"; path: string }
	| { kind: "move"; from: string; to: string };

type ApplyPatchResult = {
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	movedFiles: string[];
};

function resolveCodexWorkdir(cwd: string | null | undefined, workdir: string | undefined): string {
	return workdir ? resolvePathFromBase(workdir, cwd) : (cwd ?? "");
}

function rebaseShellActions(actions: FileAction[], workdir: string): FileAction[] {
	const rebased: FileAction[] = [];

	for (const action of actions) {
		if (action.kind === "move") {
			rebased.push({
				kind: "move",
				from: resolvePathFromBase(action.from, workdir),
				to: resolvePathFromBase(action.to, workdir),
			});
			continue;
		}

		rebased.push({
			kind: "touch",
			path: resolvePathFromBase(action.path, workdir),
			operation: action.operation,
		});
	}

	return rebased;
}

function normalizeApplyPatchResultPath(pathValue: string, cwd: string | null | undefined): string {
	const trimmed = pathValue.trim();
	if (!trimmed) {
		return "";
	}
	if (!isAbsolutePath(trimmed) && !normalizeRelativePath(trimmed)) {
		return "";
	}
	return resolvePathFromBase(trimmed, cwd);
}

function normalizeApplyPatchHeaderPath(pathValue: string, cwd: string | null | undefined): string {
	const trimmed = pathValue.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	const unquoted = withoutAt.replace(/^['"]|['"]$/g, "");
	return normalizeApplyPatchResultPath(unquoted, cwd);
}

function parseApplyPatchCandidates(input: string, cwd: string | null | undefined): ApplyPatchCandidate[] {
	const lines = input.trim().split(/\r?\n/);
	// Mirror apply_patch's canonical envelope before trusting structural headers
	if (lines.length < 2 || !lines[0].startsWith("*** Begin Patch") || lines.at(-1) !== "*** End Patch") {
		return [];
	}

	const candidates: ApplyPatchCandidate[] = [];
	for (let index = 1; index < lines.length - 1; index += 1) {
		const line = lines[index];

		if (line.startsWith("*** Add File: ")) {
			const pathValue = normalizeApplyPatchHeaderPath(line.slice("*** Add File: ".length), cwd);
			if (pathValue) candidates.push({ kind: "add", path: pathValue });
			continue;
		}

		if (line.startsWith("*** Delete File: ")) {
			const pathValue = normalizeApplyPatchHeaderPath(line.slice("*** Delete File: ".length), cwd);
			if (pathValue) candidates.push({ kind: "delete", path: pathValue });
			continue;
		}

		if (!line.startsWith("*** Update File: ")) {
			continue;
		}

		const from = normalizeApplyPatchHeaderPath(line.slice("*** Update File: ".length), cwd);
		const moveLine = lines[index + 1] ?? "";
		if (moveLine.startsWith("*** Move to: ")) {
			const to = normalizeApplyPatchHeaderPath(moveLine.slice("*** Move to: ".length), cwd);
			if (from && to) candidates.push({ kind: "move", from, to });
			index += 1;
			continue;
		}

		if (from) candidates.push({ kind: "update", path: from });
	}

	return candidates;
}

function parseApplyPatchResult(details: unknown): ApplyPatchResult | null {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return null;
	}

	const detailObject = details as Record<string, unknown>;
	if (detailObject.status !== "success" && detailObject.status !== "partial_failure") {
		return null;
	}

	if (!detailObject.result || typeof detailObject.result !== "object" || Array.isArray(detailObject.result)) {
		return null;
	}

	const result = detailObject.result as Record<string, unknown>;
	const keys = ["changedFiles", "createdFiles", "deletedFiles", "movedFiles"] as const;
	for (const key of keys) {
		const values = result[key];
		if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
			return null;
		}
	}

	return {
		changedFiles: result.changedFiles as string[],
		createdFiles: result.createdFiles as string[],
		deletedFiles: result.deletedFiles as string[],
		movedFiles: result.movedFiles as string[],
	};
}

function normalizedPathSet(values: string[], cwd: string | null | undefined): Set<string> {
	return new Set(values.map((value) => normalizeApplyPatchResultPath(value, cwd)).filter(Boolean));
}

function normalizedMoveSet(values: string[], cwd: string | null | undefined): Set<string> {
	const moves = new Set<string>();

	for (const value of values) {
		const parts = value.split(" -> ");
		if (parts.length !== 2) {
			continue;
		}

		const from = normalizeApplyPatchResultPath(parts[0], cwd);
		const to = normalizeApplyPatchResultPath(parts[1], cwd);
		if (from && to) moves.add(JSON.stringify([from, to]));
	}

	return moves;
}

function completedApplyPatchActions(
	input: string,
	details: unknown,
	cwd: string | null | undefined,
): FileAction[] {
	const result = parseApplyPatchResult(details);
	if (!result) {
		return [];
	}

	const changed = normalizedPathSet(result.changedFiles, cwd);
	const created = normalizedPathSet(result.createdFiles, cwd);
	const deleted = normalizedPathSet(result.deletedFiles, cwd);
	const moved = normalizedMoveSet(result.movedFiles, cwd);
	const actions: FileAction[] = [];

	for (const candidate of parseApplyPatchCandidates(input, cwd)) {
		if (candidate.kind === "move") {
			if (moved.has(JSON.stringify([candidate.from, candidate.to]))) {
				actions.push(candidate);
			}
			continue;
		}

		if (candidate.kind === "add") {
			if (created.has(candidate.path)) {
				actions.push({ kind: "touch", path: candidate.path, operation: "create" });
			} else if (changed.has(candidate.path)) {
				actions.push({ kind: "touch", path: candidate.path, operation: "write" });
			}
			continue;
		}

		if (candidate.kind === "update" && changed.has(candidate.path)) {
			actions.push({ kind: "touch", path: candidate.path, operation: "edit" });
		}
		if (candidate.kind === "delete" && deleted.has(candidate.path)) {
			actions.push({ kind: "touch", path: candidate.path, operation: "delete" });
		}
	}

	return actions;
}

export function parseCompletedCodexFileActions(args: {
	toolName: string;
	toolArguments: Record<string, unknown>;
	toolResult: { details?: unknown; isError?: boolean };
	cwd?: string | null;
}): CodexFileTrackingAction[] {
	if (args.toolName !== "exec_command" && args.toolName !== "apply_patch") return [];
	return parseCompletedFileActions({
		...args,
		cwd: args.cwd,
		toolResult: { content: undefined, details: args.toolResult.details, isError: args.toolResult.isError === true },
	}).actions;
}

/**
 * The directory that relative paths in a shell command resolve against: the tool's own directory, a literal directory
 * reached by `cd`, or unknown after a `cd` whose target cannot be read literally.
 */
type ShellDirectory = { kind: "tool" } | { kind: "known"; path: string } | { kind: "unknown" };

/** Applies one `cd` (its arguments after the command name) to the current directory */
function changeShellDirectory(args: string[], current: ShellDirectory, workdir: string | undefined): ShellDirectory {
	const target = args.filter((arg) => arg !== "--" && !/^-[LPe@]+$/.test(arg)).at(0);
	if (target === undefined || target === "-" || !isLiteralShellPathOperand(target) || current.kind === "unknown") {
		return { kind: "unknown" };
	}
	const base = current.kind === "known" ? current.path : workdir;
	return { kind: "known", path: resolvePathFromBase(target, base) };
}

/** Resolves one command's actions in `directory`; after an unreadable `cd`, relative paths are dropped as missing evidence */
function resolveShellActions(actions: FileAction[], directory: ShellDirectory, workdir: string | undefined): ParsedFileActions {
	if (directory.kind === "known") return { actions: rebaseShellActions(actions, directory.path), incomplete: false };
	if (directory.kind === "tool") return { actions: workdir === undefined ? actions : rebaseShellActions(actions, workdir), incomplete: false };
	const absolute = actions.filter((action) => (action.kind === "move" ? [action.from, action.to] : [action.path]).every(isAbsolutePath));
	return { actions: absolute, incomplete: absolute.length < actions.length };
}

function parseShellFileActions(cmd: string, workdir?: string): ParsedFileActions {
	const result: ParsedFileActions = { actions: [], incomplete: false };
	let directory: ShellDirectory = { kind: "tool" };
	for (const source of splitCommandSources(stripHeredocBodies(cmd))) {
		const parsedCommand = parseShellCommand(source);
		const resolved = resolveShellActions(parsedCommand.actions, directory, workdir);
		result.actions.push(...resolved.actions);
		result.incomplete ||= resolved.incomplete;
		const command = parsedCommand.command;
		if (command[0] === "cd") directory = changeShellDirectory(command.slice(1), directory, workdir);
		if (!command[0] || !["rp-cli", "rpce-cli"].includes(path.basename(command[0]))) continue;
		const parsed = parseRepoPromptCliActions(command.slice(1));
		result.incomplete ||= parsed.incomplete;
		for (const action of parsed.actions) {
			const paths = action.kind === "move" ? [action.from, action.to] : [action.path];
			if (paths.every((value) => isLiteralShellPathOperand(value) && isAbsolutePath(value))) {
				result.actions.push(action);
			} else {
				result.incomplete = true;
			}
		}
	}
	return result;
}

function parseRepoPromptCliActions(tokens: string[]): ParsedFileActions {
	const option = (short: string, long: string): string | undefined => {
		for (let index = 0; index < tokens.length; index++) {
			if (tokens[index] === short || tokens[index] === long) return tokens[index + 1];
			if (tokens[index].startsWith(`${long}=`)) return tokens[index].slice(long.length + 1);
		}
		return undefined;
	};
	const call = option("-c", "--call");
	const json = option("-j", "--json");
	if (call) {
		if (!["read_file", "apply_edits", "file_actions"].includes(call)) return { actions: [], incomplete: false };
		if (json === undefined) return { actions: [], incomplete: true };
		let args: unknown;
		try {
			args = JSON.parse(json);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			return { actions: [], incomplete: true };
		}
		const actions = getTrackedToolActions({ toolName: "rp", toolArguments: { call, args } });
		return { actions, incomplete: actions.length === 0 };
	}
	const command = option("-e", "--exec");
	return { actions: command ? splitCommandSources(command).flatMap(parseRpExecActions) : [], incomplete: false };
}

function parseRpExecActions(cmd: string): FileAction[] {
	const normalized = cmd.trim();
	if (!normalized) {
		return [];
	}

	const actions: FileAction[] = [];

	const readFileArgs = extractJsonObject(normalized, "call read_file");
	if (readFileArgs && typeof readFileArgs.path === "string") {
		actions.push({ kind: "touch", path: stripReadSliceSuffix(readFileArgs.path), operation: "read" });
	}

	const applyEditsArgs = extractJsonObject(normalized, "call apply_edits");
	if (applyEditsArgs && typeof applyEditsArgs.path === "string") {
		actions.push({ kind: "touch", path: applyEditsArgs.path, operation: "edit" });
	}

	const fileActionsArgs = extractJsonObject(normalized, "call file_actions");
	if (fileActionsArgs) {
		const action = typeof fileActionsArgs.action === "string" ? fileActionsArgs.action : "";
		const targetPath = typeof fileActionsArgs.path === "string" ? fileActionsArgs.path : null;
		const newPath = typeof fileActionsArgs.new_path === "string" ? fileActionsArgs.new_path : null;
		if (action === "create" && targetPath) {
			actions.push({ kind: "touch", path: targetPath, operation: "create" });
		}
		if (action === "delete" && targetPath) {
			actions.push({ kind: "touch", path: targetPath, operation: "delete" });
		}
		if (action === "move" && targetPath && newPath) {
			actions.push({ kind: "move", from: targetPath, to: newPath });
		}
	}

	if (commandStartsWith(normalized, "apply_edits")) {
		const targetPath = extractCliNamedArg(normalized, "path");
		if (targetPath) {
			actions.push({ kind: "touch", path: targetPath, operation: "edit" });
		}
	}

	if (commandStartsWith(normalized, "file_actions")) {
		const action = extractCliNamedArg(normalized, "action");
		const targetPath = extractCliNamedArg(normalized, "path");
		const newPath = extractCliNamedArg(normalized, "new_path");
		if (action === "create" && targetPath) {
			actions.push({ kind: "touch", path: targetPath, operation: "create" });
		}
		if (action === "delete" && targetPath) {
			actions.push({ kind: "touch", path: targetPath, operation: "delete" });
		}
		if (action === "move" && targetPath && newPath) {
			actions.push({ kind: "move", from: targetPath, to: newPath });
		}
	}

	for (const command of splitShellCommands(normalized)) {
		if (command[0] !== "file") {
			continue;
		}

		if (command[1] === "delete") {
			for (const operand of extractShellOperands(command.slice(2))) {
				actions.push({ kind: "touch", path: operand, operation: "delete" });
			}
			continue;
		}

		if (command[1] === "move") {
			const operands = extractShellOperands(command.slice(2));
			if (operands.length === 2) {
				actions.push({ kind: "move", from: operands[0], to: operands[1] });
			}
		}
	}

	const readPath = extractReadPathFromCliCommand(normalized);
	if (readPath) {
		actions.push({ kind: "touch", path: readPath, operation: "read" });
	}

	return actions;
}

function getTrackedToolActions(call: IncomingFileCall): FileAction[] {
	if (!Check(OperationCallSchema, call)) return [];
	if (call.toolName === "rp_exec") return parseRpExecActions(call.toolArguments.cmd);
	if (call.toolName !== "rp") {
		return [{ kind: "touch", path: expandHomeDirectory(call.toolArguments.path), operation: call.toolName }];
	}
	const rp = call.toolArguments;
	if (rp.call !== "file_actions") {
		return [{ kind: "touch", path: rp.args.path, operation: rp.call === "read_file" ? "read" : "edit" }];
	}
	if (rp.args.action === "move") return [{ kind: "move", from: rp.args.path, to: rp.args.new_path }];
	return [{ kind: "touch", path: rp.args.path, operation: rp.args.action }];
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((block) => {
			if (!block || typeof block !== "object") {
				return "";
			}

			return typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

function getToolCallId(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	return firstDefinedString(
		(value as { id?: unknown }).id,
		(value as { toolCallId?: unknown }).toolCallId,
		(value as { tool_call_id?: unknown }).tool_call_id,
		(value as { tool_use_id?: unknown }).tool_use_id,
	);
}

function parseTrackedToolCall(call: IncomingFileCall, cwd: string | null | undefined): TrackedToolCall {
	if (call.toolName === "apply_patch") {
		return Check(PatchArgumentsSchema, call.toolArguments)
			? { kind: "patch", input: call.toolArguments.input } : { kind: "invalid-patch" };
	}
	let result: ParsedFileActions = { actions: [], incomplete: false };
	if (call.toolName === "exec_command") {
		result = Check(CommandArgumentsSchema, call.toolArguments)
			? parseShellFileActions(call.toolArguments.cmd, resolveCodexWorkdir(cwd, call.toolArguments.workdir))
			: { actions: [], incomplete: true };
	} else if (call.toolName === "bash" && Check(BashArgumentsSchema, call.toolArguments)) {
		result = parseShellFileActions(call.toolArguments.command);
	} else {
		result.actions = getTrackedToolActions(call);
	}
	return { kind: "operations", result };
}

function completeTrackedToolCall(call: TrackedToolCall, toolResult: FileCallResult, cwd: string | null | undefined): ParsedFileActions {
	if (call.kind === "invalid-patch") return { actions: [], incomplete: true };
	if (call.kind === "patch") return { actions: completedApplyPatchActions(call.input, toolResult.details, cwd), incomplete: false };
	if (toolResult.isError) return { actions: [], incomplete: false };
	const result = call.result;
	const noOp = /applied:\s*0|no changes applied|nothing to (?:do|change)/i.test(extractTextFromContent(toolResult.content));
	if (noOp) return { ...result, actions: result.actions.filter((action) => !(action.kind === "touch" && action.operation === "edit")) };
	return result;
}

/** Resolves completed tool evidence to file operations; failed calls contribute only file changes reported by `apply_patch`. */
export const parseCompletedFileActions: FileCallParser = (call) => completeTrackedToolCall(
	parseTrackedToolCall(call, call.cwd), call.toolResult, call.cwd,
);

/** Collects nested file operations in message order using the same parser as direct calls. */
export function collectNestedFileActions(messages: Parameters<typeof collectNested>[0], cwd?: string | null) {
	return collectNested(messages, cwd, parseCompletedFileActions);
}

/** Enables live pi-codex-conversion attribution; repeated registration shares one recorder per event bus. */
export function registerFilesTouchedTracking(pi: FileTrackingHost): void {
	registerNestedFileTracking(pi, parseCompletedFileActions);
}

export function collectFilesTouched(
	entries: SessionEntry[],
	cwd?: string | null,
): FilesTouchedEntry[] {
	const toolCalls = new Map<string, TrackedToolCall>();

	for (const entry of entries) {
		if (entry.type !== "message") {
			continue;
		}

		const msg = entry.message;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
			continue;
		}

		for (const block of msg.content) {
			if (typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") {
				continue;
			}

			const toolCallId = getToolCallId(block);
			const toolName = typeof (block as { name?: unknown }).name === "string"
				? (block as { name: string }).name
				: "";
			const args = (block as { arguments?: unknown }).arguments;
			if (!toolCallId || !toolName) {
				continue;
			}

			toolCalls.set(toolCallId, parseTrackedToolCall({ toolName, toolArguments: args }, cwd));
		}
	}

	const touches: TrackedTouchRecord[] = [];
	const moves: FileMove[] = [];
	const nested = collectNested(entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []), cwd, parseCompletedFileActions);
	const nestedByMessage = new Map<object, typeof nested>();
	for (const item of nested) {
		const items = nestedByMessage.get(item.message) ?? [];
		items.push(item);
		nestedByMessage.set(item.message, items);
	}

	for (const entry of entries) {
		if (entry.type !== "message") {
			continue;
		}

		const msg = entry.message;
		if (msg.role !== "toolResult") {
			continue;
		}
		const actions = (nestedByMessage.get(msg) ?? []).map((item) => item.action);

		const toolCallId = firstDefinedString(
			msg.toolCallId,
			(msg as { tool_call_id?: unknown }).tool_call_id,
			(msg as { tool_use_id?: unknown }).tool_use_id,
		);
		const trackedCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
		if (trackedCall) {
			const parsed = completeTrackedToolCall(trackedCall, { content: msg.content, details: msg.details, isError: msg.isError }, cwd);
			actions.push(...parsed.actions);
		}

		for (const action of actions) {
			if (action.kind === "move") {
				moves.push({ from: action.from, to: action.to });
				touches.push({
					path: action.to,
					operation: "move",
					timestamp: msg.timestamp,
				});
				continue;
			}

			touches.push({
				path: action.path,
				operation: action.operation === "create" ? "write" : action.operation,
				timestamp: msg.timestamp,
			});
		}
	}

	const rootMappings = buildRootMappings(
		[
			...touches.map((touch) => touch.path),
			...moves.flatMap((move) => [move.from, move.to]),
		],
		cwd,
	);
	const redirects = new Map<string, string>();
	for (const move of moves) {
		const fromPath = normalizeTrackedPath(move.from, rootMappings, cwd);
		const toPath = normalizeTrackedPath(move.to, rootMappings, cwd);
		if (fromPath && toPath && fromPath !== toPath) {
			redirects.set(fromPath, toPath);
		}
	}

	const merged = new Map<string, { operations: Set<FileTouchOperation>; lastTimestamp: number }>();
	for (const touch of touches) {
		const normalizedPath = normalizeTrackedPath(touch.path, rootMappings, cwd);
		const canonicalPath = resolveMoveRedirect(normalizedPath, redirects);
		if (!canonicalPath) {
			continue;
		}

		const existing = merged.get(canonicalPath);
		if (existing) {
			existing.operations.add(touch.operation);
			if (touch.timestamp > existing.lastTimestamp) {
				existing.lastTimestamp = touch.timestamp;
			}
			continue;
		}

		merged.set(canonicalPath, {
			operations: new Set([touch.operation]),
			lastTimestamp: touch.timestamp,
		});
	}

	const prepared = [...merged.entries()]
		.map(([canonicalPath, value]) => {
			const resolvedPath = resolveCanonicalPath(canonicalPath, rootMappings, cwd);
			return {
				canonicalPath,
				path: resolvedPath,
				displayPath: displayPathForTrackedPath(canonicalPath, resolvedPath, cwd),
				operations: value.operations,
				lastTimestamp: value.lastTimestamp,
			};
		})
		.sort((left, right) => right.lastTimestamp - left.lastTimestamp);

	const displayCounts = new Map<string, number>();
	for (const file of prepared) {
		displayCounts.set(file.displayPath, (displayCounts.get(file.displayPath) ?? 0) + 1);
	}

	return prepared.map((file) => ({
		path: file.path,
		displayPath: (displayCounts.get(file.displayPath) ?? 0) > 1 ? file.path : file.displayPath,
		operations: file.operations,
		lastTimestamp: file.lastTimestamp,
	}));
}
