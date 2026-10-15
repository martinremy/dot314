import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
	BashArgumentsSchema, CommandArgumentsSchema, FileEvidenceSchema, NestedCompletionSchema, PatchArgumentsSchema,
	type FileAction, type FileEvidence, type FileCallParser,
	type ParsedFileActions, type FileTrackingHost, type ResultEnvelope, type NestedCompletion,
} from "./files-touched-contract.ts";

type TraceBatch = { cellId: string; traces: unknown[]; dropped: number; terminal: boolean };
type ToolResultMessage = Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "toolResult" }>;
type NestedToolCalls = NonNullable<ToolResultMessage["nestedCalls"]>;
type FileMessage = { role: string; toolCallId?: string; details?: unknown; nestedCalls?: NestedToolCalls };
type NestedFileAction = { action: FileAction; message: FileMessage };
type CellState = {
	id: string;
	seen: Map<string, string>;
	completed: Set<string>;
	evidence: FileEvidence;
	terminal: boolean;
};

const FILE_TOOLS = new Set(["read", "write", "edit", "rp", "rp_exec", "bash", "exec_command", "apply_patch"]);
const PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
const REGISTRATION_CHANNEL = "dot314.files-touched.nested-recorder/v1";
const RegistrationSchema = Type.Object({ registered: Type.Boolean() });
const ProtocolSchema = Type.Object({ protocol: Type.Literal(PREFLIGHT_PROTOCOL) });
const BrokerSchema = Type.Object({
	...ProtocolSchema.properties,
	registerCompletion: Type.Function([Type.Function([Type.Unknown()], Type.Void())], Type.Function([], Type.Void())),
});
const ToolResultSchema = Type.Object({
	content: Type.Optional(Type.Unknown()), details: Type.Optional(Type.Unknown()), isError: Type.Optional(Type.Boolean()),
});
const TraceIdentitySchema = Type.Object({ id: Type.String(), name: Type.String() });
const TraceSchema = Type.Union([
	Type.Object({ ...TraceIdentitySchema.properties, input: Type.Optional(Type.Unknown()), status: Type.Literal("done"), result: ToolResultSchema }),
	Type.Object({ ...TraceIdentitySchema.properties, input: Type.Optional(Type.Unknown()), status: Type.Literal("error"), result: Type.Optional(ToolResultSchema) }),
]);
type Trace = Static<typeof TraceSchema>;
const BatchSchema = Type.Object({
	cellId: Type.String(), traces: Type.Optional(Type.Array(Type.Unknown())),
	droppedTraceCount: Type.Optional(Type.Number()), status: Type.Optional(Type.String()),
});
const MetadataSchema = Type.Object({ filesTouched: Type.Optional(Type.Unknown()), codeMode: Type.Optional(Type.Boolean()) });
const ErrorDetailsSchema = Type.Union([
	Type.Object({ isError: Type.Literal(true) }), Type.Object({ error: Type.String({ minLength: 1 }) }),
]);
const SuccessDetailsSchema = Type.Union([
	Type.Object({ diff: Type.String({ minLength: 1 }) }), Type.Object({ editNoop: Type.Literal(true) }),
]);
const BlockedDetailsSchema = Type.Object({ blocked: Type.Literal(true) });
const StringSchema = Type.String();
const UnknownArraySchema = Type.Array(Type.Unknown());
const TraceTruncatedDetailsSchema = Type.Object({ trace_truncated: Type.Literal(true) });
const ApplyPatchDetailsPathSchema = Type.Object({ result: Type.Object({
	changedFiles: Type.Optional(Type.Array(StringSchema)),
	createdFiles: Type.Optional(Type.Array(StringSchema)),
	deletedFiles: Type.Optional(Type.Array(StringSchema)),
	movedFiles: Type.Optional(Type.Array(StringSchema)),
}) });
const RpExecInputSchema = Type.Object({ cmd: StringSchema });
const TextBlockSchema = Type.Object({ text: Type.String() });
const WaitInputSchema = Type.Object({ cell_id: Type.String() });
const TRUNCATION_MARKER = /\[(?:value truncated|value limit|values omitted|depth limit|Trace output truncated|circular|unavailable object)\]|"trace_truncated":true/;

function containsBoundedTraceMarker(value: string): boolean {
	return (value.includes("[") || value.includes("trace_truncated")) && TRUNCATION_MARKER.test(value);
}

function optionalStringTruncated(value: string | undefined): boolean {
	return value !== undefined && containsBoundedTraceMarker(value);
}

function requiredInputTruncated(trace: Trace): boolean {
	const input = trace.input;
	if (trace.name === "apply_patch") {
		return (Check(StringSchema, input) && containsBoundedTraceMarker(input))
			|| (Check(PatchArgumentsSchema, input) && containsBoundedTraceMarker(input.input));
	}
	if (trace.name === "exec_command" && Check(CommandArgumentsSchema, input)) {
		return containsBoundedTraceMarker(input.cmd) || optionalStringTruncated(input.workdir);
	}
	if (trace.name === "bash" && Check(BashArgumentsSchema, input)) return containsBoundedTraceMarker(input.command);
	return trace.name === "rp_exec" && Check(RpExecInputSchema, input) && containsBoundedTraceMarker(input.cmd);
}

function actionPathTruncated(action: FileAction): boolean {
	return action.kind === "move"
		? containsBoundedTraceMarker(action.from) || containsBoundedTraceMarker(action.to)
		: containsBoundedTraceMarker(action.path);
}

function removeTruncatedActionPaths(actions: FileAction[]): ParsedFileActions {
	const kept = actions.filter((action) => !actionPathTruncated(action));
	return { actions: kept, incomplete: kept.length !== actions.length };
}

function applyPatchDetailsTruncated(trace: Trace): boolean {
	const details = trace.result?.details;
	if (Check(ApplyPatchDetailsPathSchema, details)) {
		return [
			...(details.result.changedFiles ?? []), ...(details.result.createdFiles ?? []),
			...(details.result.deletedFiles ?? []), ...(details.result.movedFiles ?? []),
		].some(containsBoundedTraceMarker);
	}
	return Check(TraceTruncatedDetailsSchema, details) || (Check(StringSchema, details) && containsBoundedTraceMarker(details));
}

function readCompletionResult(call: NestedCompletion): Static<typeof ToolResultSchema> {
	if (Check(ToolResultSchema, call.result)) return call.result;
	if (Check(StringSchema, call.result)) return { content: call.result };
	if (call.result === undefined) return {};
	throw new Error("Invalid PCC tool result");
}

function readBatch(result: ResultEnvelope): TraceBatch | undefined {
	const details = result.details;
	if (!Check(BatchSchema, details) || (details.traces === undefined && details.droppedTraceCount === undefined)) return undefined;
	return {
		cellId: details.cellId,
		traces: details.traces ?? [],
		dropped: details.droppedTraceCount ?? 0,
		terminal: details.status === "result" || details.status === "terminated",
	};
}

function traceOutcome(trace: Trace): "success" | "error" | "unknown" {
	if (trace.status === "error" || trace.result.isError === true) return "error";
	const details = trace.result.details;
	if (Check(ErrorDetailsSchema, details)) return "error";
	if (trace.name === "rp_exec" && Check(BlockedDetailsSchema, details)) return "error";
	if (trace.name !== "rp") return "success";
	if (Check(SuccessDetailsSchema, details)) return "success";
	if (Check(TraceTruncatedDetailsSchema, details) || (Check(StringSchema, details) && containsBoundedTraceMarker(details))) return "unknown";
	// Saved RepoPrompt traces may lack the returned error flag, so count only results whose content still shows success.
	const content = trace.result.content;
	if (!Check(UnknownArraySchema, content)) return "unknown";
	const text = content.flatMap((item) => Check(TextBlockSchema, item) ? [item.text] : []).join("\n").trim();
	return /^(?:## (?:File Read|File Actions|Apply Edits) ✅|✅\s*Applied\b|⚠ No changes applied)/.test(text)
		? "success" : "unknown";
}

function parseTrace(trace: Trace, cwd: string | null | undefined, parse: FileCallParser): FileEvidence {
	const input = trace.input;
	const inputTruncated = requiredInputTruncated(trace);
	const args = trace.name === "apply_patch" && Check(StringSchema, input) ? { input } : input;
	const outcome = traceOutcome(trace);
	const parsed = inputTruncated
		? { actions: [], incomplete: true } : parse({
		toolName: trace.name,
		toolArguments: args,
		toolResult: { content: trace.result?.content, details: trace.result?.details, isError: outcome === "error" },
		cwd,
	});
	const filtered = removeTruncatedActionPaths(parsed.actions);
	const uncertainEffects = outcome === "unknown" && filtered.actions.length > 0;
	const actions = uncertainEffects && trace.name !== "apply_patch" ? [] : filtered.actions;
	const incomplete = parsed.incomplete || filtered.incomplete || uncertainEffects
		|| (trace.name === "apply_patch" && applyPatchDetailsTruncated(trace));
	return { version: 1, calls: [{ toolCallId: trace.id, actions }], incomplete };
}

/** Pi keeps each nested call's name, arguments, and status, never its result. */
function readPiNestedCallEvidence(record: NestedToolCalls | undefined, cwd: string | null | undefined, parse: FileCallParser): FileEvidence | undefined {
	if (!record) return undefined;
	const evidence: FileEvidence = { version: 1, calls: [], incomplete: !record.complete };
	for (const call of record.calls) {
		if (!FILE_TOOLS.has(call.name) || call.status === "error") continue;
		// apply_patch effects come only from result details, which this record never keeps.
		if (call.status === "unfinished" || call.name === "apply_patch") {
			evidence.incomplete = true;
			continue;
		}
		const parsed = parse({
			toolName: call.name, toolArguments: call.arguments, cwd,
			toolResult: { content: undefined, details: undefined, isError: false },
		});
		evidence.calls.push({ toolCallId: call.id, actions: parsed.actions });
		evidence.incomplete ||= parsed.incomplete;
	}
	return evidence;
}

function readMessageEvidence(message: FileMessage, cwd: string | null | undefined, parse: FileCallParser): FileEvidence | undefined {
	const details = message.details;
	if (!Check(MetadataSchema, details)) return readPiNestedCallEvidence(message.nestedCalls, cwd, parse);
	if (Object.hasOwn(details, "filesTouched")) {
		return Check(FileEvidenceSchema, details.filesTouched) ? details.filesTouched : { version: 1, calls: [], incomplete: true };
	}
	const batch = readBatch({ details });
	if (!batch || details.codeMode !== true) return readPiNestedCallEvidence(message.nestedCalls, cwd, parse);
	const evidence: FileEvidence = { version: 1, calls: [], incomplete: batch.dropped > 0 };
	for (const trace of batch.traces) {
		if (!Check(TraceSchema, trace) || !FILE_TOOLS.has(trace.name)) continue;
		const parsed = parseTrace(trace, cwd, parse);
		evidence.calls.push(...parsed.calls);
		evidence.incomplete ||= parsed.incomplete;
	}
	return evidence;
}

/** Reads saved file records, pi-codex-conversion traces, or Pi's nested call records, deduplicated by nested call ID in message order. */
export function collectNestedFileActions(messages: readonly FileMessage[], cwd: string | null | undefined, parse: FileCallParser): NestedFileAction[] {
	const seen = new Set<string>();
	const actions: NestedFileAction[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const evidence = readMessageEvidence(message, cwd, parse);
		if (!evidence) continue;
		for (const call of evidence.calls) {
			if (seen.has(call.toolCallId)) continue;
			seen.add(call.toolCallId);
			for (const action of call.actions) actions.push({ action, message });
		}
	}
	return actions;
}

/** Records PCC completion events; traces supply cell ownership, never live arguments or outcomes. */
export function registerNestedFileTracking(pi: FileTrackingHost, parse: FileCallParser): void {
	const registration = { registered: false };
	pi.events.emit(REGISTRATION_CHANNEL, registration);
	if (registration.registered) return;
	// Registration uses the shared event bus because Pi gives each extension a separate events facade.
	const stopRegistration = pi.events.on(REGISTRATION_CHANNEL, (value) => {
		if (Check(RegistrationSchema, value) && value.registered === false) value.registered = true;
	});
	const pending = new Map<string, ParsedFileActions>();
	const owners = new Map<string, CellState>();
	const cells = new Map<string, CellState>();
	const outerCells = new Map<string, string>();
	let warned = false;
	let unsubscribe: (() => void) | undefined;
	let broker: Static<typeof BrokerSchema> | undefined;
	const record = (cell: CellState, id: string, parsed: ParsedFileActions): void => {
		if (cell.completed.has(id)) return;
		cell.completed.add(id);
		cell.evidence.calls.push({ toolCallId: id, actions: parsed.actions });
		cell.evidence.incomplete ||= parsed.incomplete;
	};
	const stopAvailable = pi.events.on(`${PREFLIGHT_PROTOCOL}/available`, (value) => {
		if (!Check(ProtocolSchema, value) || value === broker) return;
		if (!Check(BrokerSchema, value)) throw new Error("Files-touched nested tracking requires PCC 3.0.30 or newer");
		unsubscribe?.();
		broker = value;
		unsubscribe = value.registerCompletion((call) => {
			if (!Check(NestedCompletionSchema, call)) throw new Error("Invalid PCC completion event");
			if (!FILE_TOOLS.has(call.toolName)) return;
			const args = call.toolName === "apply_patch" && Check(StringSchema, call.input) ? { input: call.input } : call.input;
			const result = readCompletionResult(call);
			const details = result.details;
			const isError = call.status === "error" || result.isError === true || Check(ErrorDetailsSchema, details);
			const parsed = parse({
				toolName: call.toolName, toolArguments: args, cwd: call.cwd,
				toolResult: { content: result.content, details, isError },
			});
			const cell = owners.get(call.toolCallId);
			if (cell) record(cell, call.toolCallId, parsed);
			else pending.set(call.toolCallId, parsed);
		});
	});
	const observe = (id: string, result: ResultEnvelope): CellState | undefined => {
		const batch = readBatch(result);
		if (!batch) {
			const cellId = outerCells.get(id);
			return cellId === undefined ? undefined : cells.get(cellId);
		}
		const cell = cells.get(batch.cellId) ?? {
			id: batch.cellId, seen: new Map<string, string>(), completed: new Set<string>(),
			evidence: { version: 1, calls: [], incomplete: false }, terminal: false,
		} satisfies CellState;
		cells.set(batch.cellId, cell);
		outerCells.set(id, batch.cellId);
		const evidence = cell.evidence;
		for (const value of batch.traces) {
			if (!Check(TraceIdentitySchema, value)) { evidence.incomplete = true; continue; }
			cell.seen.set(value.id, value.name);
			if (FILE_TOOLS.has(value.name)) {
				owners.set(value.id, cell);
				const parsed = pending.get(value.id);
				if (parsed) record(cell, value.id, parsed);
				pending.delete(value.id);
			}
		}
		cell.terminal = batch.terminal;
		if (batch.terminal) evidence.incomplete ||= cell.seen.size < batch.dropped + batch.traces.length;
		return cell;
	};
	const finishCell = (cell: CellState): void => {
		for (const [traceId, toolName] of cell.seen) {
			cell.evidence.incomplete ||= FILE_TOOLS.has(toolName) && !cell.completed.has(traceId);
			pending.delete(traceId);
			owners.delete(traceId);
		}
		cells.delete(cell.id);
		for (const [id, cellId] of outerCells) if (cellId === cell.id) outerCells.delete(id);
	};
	pi.on("tool_execution_update", (event) => {
		if (event.toolName === "exec" || event.toolName === "wait") observe(event.toolCallId, event.partialResult);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "exec" && event.toolName !== "wait") return;
		if (event.toolName === "wait" && Check(WaitInputSchema, event.input) && cells.has(event.input.cell_id)) {
			outerCells.set(event.toolCallId, event.input.cell_id);
		}
		const cell = observe(event.toolCallId, event);
		if (!cell) return;
		if (event.isError || cell.terminal) finishCell(cell);
		const evidence = cell.evidence;
		cell.evidence = { version: 1, calls: [], incomplete: false };
		outerCells.delete(event.toolCallId);
		if (evidence.incomplete && ctx.hasUI && !warned) {
			warned = true;
			ctx.ui.notify("Files-touched coverage is partial; known operations remain available.", "warning");
		}
		const details = Object.assign({}, event.details, { filesTouched: evidence });
		return { details };
	});
	const clear = () => { pending.clear(); owners.clear(); cells.clear(); outerCells.clear(); };
	pi.on("session_start", () => { clear(); warned = false; });
	pi.on("session_tree", clear);
	pi.on("session_shutdown", () => {
		clear();
		unsubscribe?.();
		stopAvailable();
		stopRegistration();
	});
	pi.events.emit(`${PREFLIGHT_PROTOCOL}/request`, { protocol: PREFLIGHT_PROTOCOL });
}
