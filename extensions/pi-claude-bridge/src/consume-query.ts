// Background SDK-stream consumer + the failure/metadata capture that rides it.
// Extracted from index.ts (pure move): consumeQuery iterates one SDK query's
// generator and pushes events into the query's captured Pi stream.

import { type Model } from "@earendil-works/pi-ai";
import { type query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	classifyClaudeFailure,
	rateLimitResetFromInfo,
	rateLimitResetMs,
	rateLimitTypeFromInfo,
	safeRouterCall,
	type ClaudeAccountFailureKind,
	type ClaudeAccountRoute,
	type ClaudeAccountRouterV1,
} from "./account-router.ts";
import { endStreamForFailure, ensureTurnStarted, noteChildExecutedToolResults, processAssistantMessage, processStreamEvent, queryBlocks, updateTurnResponseModel } from "./assistant-stream.ts";
import { appendIntegrityEntry, getExtensionApi, notifyRateLimitWarning, safeNotify } from "./bridge-state.ts";
import { type Config } from "./config.ts";
import { debug, diagDump } from "./debug.ts";
import { noteAnomaly } from "./agent-notice.ts";
import { modelDisplayName } from "./models.ts";
import { type QueryContext } from "./query-state.ts";
import { RATE_LIMIT_AUTO_RESUME_EVENT, RATE_LIMIT_TOKEN, formatAllowedRateLimitWarning, formatResetTimestamp, isUsageLimitMessage, uniqueNonEmptyLines, type RejectedClaudeLimit } from "./rate-limit.ts";
import { abortSdkQuery, sdkQueryAbandoned } from "./query-teardown.ts";
import { activeStreamIdleWatchdogs } from "./stream-idle-watchdog.ts";
import { logClaudeCodeVersion } from "./versions.ts";

const ABANDONED: unique symbol = Symbol("sdk-query-abandoned");

const assistantCheckpointSchema = z.object({
	session_id: z.string().min(1),
	uuid: z.string().min(1),
	parent_tool_use_id: z.null(),
	message: z.object({ model: z.string().refine(model => model !== "<synthetic>") }),
});

/** Silence an `api_retry` notice announces: the backoff before the retry,
 *  plus the retry's own wait for response headers after a no-response
 *  failure. Claude Code is legitimately quiet for that long. */
function announcedQuietMs(message: { type: string; subtype?: unknown; retry_delay_ms?: unknown; no_response?: { retry_wait_ms?: unknown } }): number {
	if (message.type !== "system" || message.subtype !== "api_retry") return 0;
	return (Number(message.retry_delay_ms) || 0) + (Number(message.no_response?.retry_wait_ms) || 0);
}

export function emitRateLimitEvent(payload: Record<string, unknown>): void {
	try {
		getExtensionApi()?.events?.emit?.(RATE_LIMIT_AUTO_RESUME_EVENT, payload);
	} catch {
		// Cross-extension broker is best-effort only.
	}
}

// The fastMode setting silently no-ops when Claude Code declines fast mode.
// Surface the typed fast_mode_disabled_reason (SDK 0.3.219+) once per distinct
// reason so an enabled-but-inert setting explains itself instead of looking
// broken. Module-level dedup: the same reason repeats on every init message.
let lastFastModeDisabledNoticeReason: string | null = null;

const FAST_MODE_DISABLED_REASON_TEXT: Record<string, string> = {
	disabled_by_env: "disabled by an environment variable",
	extra_usage_disabled: "extra usage is disabled for this account",
	free: "not available on the free plan",
	model_not_allowed: "not available for this model",
	network_error: "the eligibility check hit a network error",
	not_first_party: "not available for this account type",
	preference: "disabled by a Claude Code preference",
	sdk_opt_in_required: "the SDK opt-in is missing",
	unknown: "unavailable for an unknown reason",
};

function noteFastModeDisabledReason(message: unknown, bridgeConfig: Config): void {
	if (bridgeConfig.provider?.fastMode !== true) return;
	const reason = (message as { fast_mode_disabled_reason?: unknown }).fast_mode_disabled_reason;
	// "pending" means the CLI is still deciding — not a verdict worth announcing.
	if (typeof reason !== "string" || reason === "pending") return;
	if (reason === lastFastModeDisabledNoticeReason) return;
	lastFastModeDisabledNoticeReason = reason;
	const text = FAST_MODE_DISABLED_REASON_TEXT[reason] ?? `unavailable (${reason})`;
	safeNotify(`Pi Claude: fast mode is enabled in settings but Claude Code declined it — ${text}.`, "warning");
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
export interface ClaudeAttemptFailure {
	kind?: ClaudeAccountFailureKind | "usage-credits";
	message: string;
	rateLimitInfo?: Record<string, unknown>;
}

export interface ConsumeQueryResult {
	capturedSessionId?: string;
	failure?: ClaudeAttemptFailure;
}

/** Claude Code reports a tool_result only once a call is over, so a forwarded
 *  call it reports can no longer be invoked late: retire it, which lets a
 *  served-tool redefinition it was postponing apply (served-tools.ts). Covers
 *  calls that finished without a tools/call carrying Claude Code's tool_use id. */
function settleReportedToolCalls(message: unknown, queryCtx: QueryContext): void {
	const content = (message as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return;
	const ids: string[] = [];
	for (const block of content) {
		const id = block?.type === "tool_result" ? block.tool_use_id : undefined;
		if (typeof id === "string" && queryCtx.forwardedToolCallIds.has(id) && !queryCtx.settledInvocationIds.has(id)) ids.push(id);
	}
	if (ids.length > 0) {
		debug(`consumeQuery: Claude Code finished forwarded call(s) ${ids.join(",")}`);
		queryCtx.settleInvocations(ids);
	}
}

/** Claude Code reports a call's tool_result only after the call is answered,
 *  and the bridge removes a handler from pendingToolCalls before answering it.
 *  A reported id still pending therefore means Claude Code answered the call
 *  itself (a CC-side limit gave up on it) while Pi is still running the tool.
 *  Pi's result can no longer reach Claude, so say so now instead of losing it
 *  silently when it arrives. The bridge's server config keeps CC's known
 *  limits from firing (served-tools.ts, query-options.ts); this is the net. */
function noteAbandonedToolCalls(message: unknown, queryCtx: QueryContext): void {
	const content = (message as { message?: { content?: unknown } }).message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const id = block?.type === "tool_result" ? block.tool_use_id : undefined;
		if (typeof id !== "string" || queryCtx.abandonedToolCalls.has(id)) continue;
		const pending = queryCtx.pendingToolCalls.get(id);
		if (!pending) continue;
		const raw = block.content;
		// Logged on purpose: the call is still pending, so Pi never answered it
		// and Claude Code wrote this tool_result itself. The text is its give-up
		// reason (a timeout or cancel message), not a tool payload.
		const text = typeof raw === "string"
			? raw
			: Array.isArray(raw) ? raw.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join(" ") : "";
		const reason = text.trim().slice(0, 200) || "no reason given";
		queryCtx.abandonedToolCalls.set(id, { toolName: pending.toolName, reason });
		debug(`consumeQuery: Claude Code gave up on ${pending.toolName} [${id}] while Pi is still running it: ${reason}`);
		diagDump("tool_call_abandoned_by_claude_code", { id, toolName: pending.toolName, reason });
		noteAnomaly("tool_call_abandoned_by_claude_code");
		appendIntegrityEntry("tool_call_abandoned_by_claude_code", { id, toolName: pending.toolName });
		safeNotify(`Claude bridge: Claude Code stopped waiting for ${pending.toolName} while Pi is still running it (${reason}). Claude will not see that call's result.`, "warning");
	}
}

export async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	// The CAPTURED context of the query being consumed, never the live ctx():
	// a quarantine (abort, stream-idle timeout) can hand the lane to a new
	// context while this iterator is suspended, and reading live state then
	// would consult the WRONG query — a recovered success could retain its
	// failure and surface an error, or a child session id could stamp the next
	// query's context.
	queryCtx: QueryContext,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	bridgeConfig: Config,
	wasAborted: () => boolean,
	noticeAccountKey: string,
	account?: ClaudeAccountRoute,
	router?: ClaudeAccountRouterV1,
	// Mirror of the held failure for the caller's .catch: the SDK iterator can
	// THROW after the failure-signal message (a rejected rate_limit_event is the
	// known case), and the rejection loses this function's return value. Without
	// the mirror the catch re-classifies from the thrown error, misses
	// rateLimitInfo, and double-counts the router cooldown.
	attemptFailureBox?: { failure?: ClaudeAttemptFailure },
): Promise<ConsumeQueryResult> {
	queryCtx.transcriptCheckpoint = null;
	queryCtx.rejectedClaudeLimit = null;
	let capturedSessionId: string | undefined;
	let failure: ClaudeAttemptFailure | undefined;
	let accountProbe: Promise<void> | undefined;
	const holdFailure = (next: ClaudeAttemptFailure | undefined): void => {
		failure = next;
		if (attemptFailureBox) attemptFailureBox.failure = next;
	};

	// Not `for await`: after an abort or idle timeout the iterator may never
	// settle (a wedged child can survive close()), so every wait is raced
	// against the query's abandonment and teardown proceeds regardless.
	const iterator = sdkQuery[Symbol.asyncIterator]();
	const abandoned = sdkQueryAbandoned(sdkQuery).then((): typeof ABANDONED => ABANDONED);
	for (;;) {
		const next = await Promise.race([iterator.next(), abandoned]);
		if (next === ABANDONED) {
			debug("consumeQuery: SDK iterator did not settle after abort; abandoning it");
			break;
		}
		if (next.done) break;
		const message = next.value as SDKMessage;
		queryCtx.timing?.phase("firstSdkMessage");
		if (wasAborted()) {
			await Promise.race([iterator.return?.(undefined), abandoned]);
			break;
		}
		activeStreamIdleWatchdogs.get(queryCtx)?.noteChunk(announcedQuietMs(message));
		if (account) {
			// Thunk, not a value: this runs once per SDK message — including one
			// stream_event per streamed token — and debug() only evaluates function
			// args after its DEBUG early return.
			debug("consumeQuery: managed message", () => JSON.stringify({
				type: message.type,
				subtype: (message as any).subtype,
				error: (message as any).error,
				eventType: (message as any).event?.type,
				deltaType: (message as any).event?.delta?.type,
				contentType: (message as any).event?.content_block?.type,
			}));
		}
		if (!queryCtx.turnOutput) continue;
		// Only RENDERING needs a live Pi stream. Failure metadata and
		// child-executed tool results must be captured even when a tool-use turn
		// boundary has nulled the stream — skipping them there dropped terminal
		// failure classification and audited late connector results "unobserved".
		const streamLive = Boolean(queryCtx.currentPiStream);

		switch (message.type) {
			case "stream_event":
				queryCtx.apiResponded = true;
				queryCtx.timing?.phase("firstStreamEvent");
				if (!streamLive) break;
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant": {
				// Claude Code emits a synthetic assistant text block carrying friendly
				// rate/auth error copy before the SDK throws. It is not model output:
				// forwarding it would commit the stream, which makes safe pre-output
				// account failover impossible and stops a host's model fallback, and
				// the error that follows repeats the same text. So every attempt holds
				// it as failure metadata (with or without a live stream).
				const sdkError = (message as any).error;
				if (sdkError) {
					// The notice is the error the user sees when no throw follows; the
					// error token only classifies it.
					const content = (message as any).message?.content;
					const notice = (Array.isArray(content) ? content : []).flatMap((block: any) => block?.type === "text" && block.text ? [block.text] : []).join("\n").trim();
					if (!failure) holdFailure({ kind: classifyClaudeFailure(sdkError), message: notice || String(sdkError) });
					break;
				}
				const checkpoint = assistantCheckpointSchema.safeParse(message);
				if (checkpoint.success) queryCtx.transcriptCheckpoint = { sessionId: checkpoint.data.session_id, uuid: checkpoint.data.uuid };
				if (message.message.model !== "<synthetic>") queryCtx.apiResponded = true;
				if (!streamLive && !queryCtx.turnSawToolCall) break;
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			}
			case "result":
				queryCtx.timing?.phase("sdkResult");
				if (message.subtype === "success" && message.is_error !== true) queryCtx.rejectedClaudeLimit = null;
				// A failure signal followed by a result whose visible output already
				// committed (e.g. the SDK's fallback-model reroute recovering after a
				// rejected rate limit) means the query ultimately SUCCEEDED: the
				// failure was informational and must neither surface an error after
				// the answer nor skip session persistence.
				// A legacy attempt never commits (no RetryEventBuffer), so there the
				// visible output is its rendered blocks, and only a result that is not
				// itself the error (is_error) recovered.
				const legacyRecovered = !account && !(message as any).is_error && queryBlocks(queryCtx).length > 0;
				if (failure && message.subtype === "success" && (queryCtx.committedOutput || legacyRecovered)) {
					debug(`consumeQuery: clearing informational ${failure.kind ?? "unclassified"} failure — query recovered with committed output`);
					holdFailure(undefined);
				}
				// The SDK can label the synthetic friendly error carrier as a
				// successful result immediately before its iterator throws. Once an
				// attempt holds a terminal failure signal, that text is still
				// error metadata, not assistant output. A legacy attempt still reads
				// a non-success result below: its copy is the fuller error.
				if (failure && (message.subtype === "success" || account)) break;
				if (!queryCtx.turnSawStreamEvent && message.subtype === "success") {
					if (!streamLive) break;
					const text = message.result || "";
					// The no-stream-events assistant fallback may have already rendered
					// this exact text in this query (it does not set
					// turnSawStreamEvent) — re-pushing it here is the other half of the
					// duplicated-output bug. An earlier deferred-replay query's reply
					// may legitimately be repeated.
					if (queryBlocks(queryCtx).some((b: any) => b.type === "text" && b.text === text)) {
						debug("consumeQuery: result text already rendered by assistant fallback; skipping duplicate");
						break;
					}
					ensureTurnStarted(queryCtx);
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				} else if (message.subtype !== "success") {
					const errorLines = Array.isArray((message as any).errors) ? uniqueNonEmptyLines((message as any).errors) : [];
					const errors = errorLines.length > 0 ? errorLines.join("\n") : String((message as any).result || message.subtype || "Claude Code request failed");
					const usageLimit = isUsageLimitMessage(message);
					const kind = usageLimit ? "rate-limit" : classifyClaudeFailure(errors);
					if (!failure || !failure.rateLimitInfo) {
						holdFailure({ kind, message: errors });
					}
					// Managed attempts keep terminal error copy buffered as metadata so
					// a pre-output failure can move to another subscription profile.
					if (account) break;
					if (usageLimit) {
						// isUsageLimitMessage matches the CLI's own usage-limit copy (SDK
						// USAGE_LIMIT_ERROR_PREFIXES). Surface it immediately, exactly as
						// before, and suppress the SDK's raw follow-up throw.
						queryCtx.handledTerminalError = true;
						endStreamForFailure(queryCtx, { errorMessage: errors });
					}
					// Other non-success subtypes (error_max_turns,
					// error_during_execution) surface at completion via the held
					// failure. These turns require an explicit error event instead of
					// silent completion. Session persistence and deferred replay still run.
				}
				break;
			case "system":
				if ((message as any).subtype === "init") {
					queryCtx.timing?.phase("init");
					logClaudeCodeVersion((message as any).claude_code_version);
				}
				if (!streamLive) break;
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
					// Also on this message's query context, so the connector-call audit
					// trail can name the child session that executed a call — including
					// from the teardown flush, which runs outside this function's scope.
					queryCtx.childSessionId = capturedSessionId;
					noteFastModeDisabledReason(message, bridgeConfig);
					if (account && router && !accountProbe) {
						accountProbe = Promise.allSettled([
							sdkQuery.accountInfo().then((info) => router.recordIdentity(account.profileId, {
								email: info.email,
								organization: info.organization,
								subscriptionType: info.subscriptionType,
							})),
							sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
								.then((usage) => router.recordUsage(account.profileId, usage)),
						]).then((results) => {
							const labels = ["recordIdentity", "recordUsage"];
							results.forEach((result, i) => {
								if (result.status === "rejected") debug(`consumeQuery: account probe ${labels[i]} rejected:`, result.reason);
							});
						});
					}
				} else if ((message as any).subtype === "model_refusal_fallback") {
					const originalModel = (message as any).original_model;
					const fallbackModel = (message as any).fallback_model;
					updateTurnResponseModel(fallbackModel, queryCtx);
					debug("consumeQuery: model_refusal_fallback", JSON.stringify({ originalModel, fallbackModel }));
					// Announce every reroute: Claude Code picks the target per refusal
					// category (Opus 5.5 can land on Opus 5 or Opus 4.8), not only the
					// fallback model the bridge configures.
					if (typeof fallbackModel === "string" && typeof originalModel === "string" && fallbackModel !== originalModel) {
						safeNotify(
							`Pi Claude switched ${modelDisplayName(originalModel)} to ${modelDisplayName(fallbackModel)} after Claude Code safety fallback.`,
							"info",
						);
					}
				}
				break;
			case "user":
				// Mostly the SDK echoing the prompt back — nothing to render. The one
				// thing worth reading is a child-executed tool's real result, which
				// arrives here and nowhere else — including AFTER a tool-use turn
				// boundary nulled the stream (noteChildExecutedToolResults is
				// side-effect-free on the Pi stream).
				noteChildExecutedToolResults(message, queryCtx);
				noteAbandonedToolCalls(message, queryCtx);
				settleReportedToolCalls(message, queryCtx);
				break;
			case "rate_limit_event": {
				const info = message.rate_limit_info;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				// Billing policy applies even while Pi has the tool turn and no stream is live.
				const allowUsageCredits = Boolean(bridgeConfig.provider) && bridgeConfig.provider.allowUsageCredits === true;
				if (info.isUsingOverage === true && !allowUsageCredits) {
					holdFailure({
						kind: "usage-credits",
						message: "Claude bridge billing: stopped because Claude Code reported usage credits instead of plan limits. Set provider.allowUsageCredits to true in your user claude-bridge.json to allow this. The current request may already have been charged; disable usage credits in your Claude account settings to prevent charges.",
					});
					debug("consumeQuery: usage credits blocked by user billing policy");
					abortSdkQuery(sdkQuery);
					return { capturedSessionId, failure };
				}
				const limitType = z.string().trim().min(1).safeParse(rateLimitTypeFromInfo(info));
				const resetAtMs = rateLimitResetMs(info);
				const limit: RejectedClaudeLimit = {
					limitType: limitType.success ? limitType.data : null,
					resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
				};
				if (!Boolean(account) && info.status === "rejected") queryCtx.rejectedClaudeLimit = limit;
				if (!streamLive) break;
				if (info?.status === "rejected") {
					const rateLimitType = rateLimitTypeFromInfo(info);
					const resetAt = rateLimitResetFromInfo(info);
					const resetAtMs = rateLimitResetMs(info);
					const reason = `${rateLimitType ?? "unknown"} rate limit`;
					if (account && router) {
						// Rotation may still recover this request, so hold the rejection
						// as failure metadata and teach the router the reset time now.
						// Surfacing (event + toast) happens once in surfaceFailure — only
						// if the attempt is not replayed on another profile.
						holdFailure({ kind: "rate-limit", message: reason, rateLimitInfo: info });
						safeRouterCall("recordRateLimit", () => router.recordRateLimit(account.profileId, info, model.id));
					} else {
						// A rejection is informational until the SDK finishes: it may recover.
						const resetsAt = formatResetTimestamp(resetAtMs ?? resetAt);
						emitRateLimitEvent({
							model: model.id,
							provider: model.provider,
							rateLimitType,
							reason,
							resetAt,
							...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
							source: "claude-bridge",
							status: "rejected",
						});
						notifyRateLimitWarning(noticeAccountKey, { ...limit, status: "rejected" }, `${RATE_LIMIT_TOKEN} Claude ${reason} hit; resets ${resetsAt}`);
					}
				} else if (info?.status === "allowed_warning") {
					const warning = formatAllowedRateLimitWarning(info);
					if (warning) notifyRateLimitWarning(noticeAccountKey, { ...limit, status: "allowed_warning" }, warning);
					else debug("consumeQuery: suppressed low/ambiguous allowed_warning rate_limit_event", JSON.stringify(info).slice(0, 300));
				}
				break;
			}
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	if (accountProbe) {
		await Promise.race([
			accountProbe,
			new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
		]);
	}
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}, failure=${failure?.kind ?? "none"}`);
	return { capturedSessionId, failure };
}
