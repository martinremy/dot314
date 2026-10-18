---
name: context-smip
description: Collect and verify filesystem context with smip, then deliver its packet to Pi subagents
disable-model-invocation: true
---

# Smip context and delegation

The coordinator gathers context with smip and delegates reasoning to the existing Pi roles. Read `/Users/ww/smip/docs/context-protocol.md` completely. Use filesystem, shell and Git tools; do not call RepoPrompt or open its app. This protocol collects evidence and delivers it, not a review or implementation by itself.

## Establish the inputs

Confirm the task, absolute source roots/worktrees, Git state, required plan/documents, and review comparisons. Ask when a comparison is ambiguous. Capture changed, untracked and deleted paths appropriate to that comparison. Retain the original user requirements and approved boundary.

Use `/Users/ww/smip/dist/cli/main.js` with Node. The configured host file is `/Users/ww/.config/smip/config.json`; use the operator's explicit path or `SMIP_CONFIG_PATH` when one is supplied. Pass the chosen absolute path with `--config`. If configuration, authentication, the native executable or search is unavailable, report the exact setup blocker. Do not change Pi settings, install packages, invent credentials, or substitute another context provider.

Create a unique run directory under the primary repository's `prompt-exports/` directory with an existing output directory. Exclude this run's transient files from source discovery and review scope. Keep durable plans/reports in the repository's normal locations.

Read `contextBudgetUnits` from the operator-provided host configuration without exposing other configuration values. Set `request.budgetUnits` to that value; a smaller budget requires the user's instruction. Missing budget configuration blocks context assembly. Build from the task, sources and user budget; recipient selection and capacity checks belong to delivery.

## Collect the packet

Finalize the complete assignment before discovery. Put it in `request.task`, with complete constraints in `request.constraints`. Include exact comparisons, required documents, prior findings and the required deliverable. The assignment must be self-contained for a recipient with no session context.

Read the current schemas in `/Users/ww/smip/src/contracts/inventory.ts`, `/Users/ww/smip/src/contracts/context.ts` and `/Users/ww/smip/src/contracts/patches.ts` before creating a build request. Save a JSON file with `workspace`, `requestId` and `request`:

- `workspace` declares named absolute roots, explicit exclusions and the existing absolute output directory.
- `request` declares purpose, task, constraints, enhancementMode, initialSelection, duplicateUserInstructionsAtTop, copyPreset, storedPrompts, requiredSources, documents, patches, budgetUnits, discoveryHints and a unique outputName. For review, include the complete scoped comparison as a localPatch. Complete required plans belong in requiredSources or documents. Pin a source representation only when the user or assignment requires that representation; do not force every changed file to full merely to control a comparison. Discovery may choose full files or appropriate implementation slices for changed code, and codemaps for supporting structure. Deleted paths need their complete patches/prior text rather than a current-file read.
- Use a fresh requestId. Root names are aliases for this request, not RP windows or tabs. Preserve required patch/source coverage; known starting points do not limit discovery to those files.

Use `initialSelection: { "codemapMode": "automatic", "sources": [] }` for an empty starting selection. Put mutable starting files or slices there; only `requiredSources` pins representations. Set `duplicateUserInstructionsAtTop` to false for the source default, or true when the assignment requests a second complete prompt block before the context sections.

Set `copyPreset` explicitly to `standard`, `plan` or `codeReview`. Standard and Plan omit optional scout-selected patch bodies; Review includes nonblank selected patches. Selected MAP artifacts remain ordinary content, and caller-required `patches` remain complete in every preset. Supply `storedPrompts: []` unless the caller selected saved role blocks; otherwise provide their complete UUID, title and content catalog. The preset selects matching roles from that catalog. Do not invent role bodies or add a personal reviewer prompt. Leave `clarification` absent for this noninteractive CLI workflow.

Run the CLI and save its terminal receipt and stderr to separate files under the run directory:

```text
node /Users/ww/smip/dist/cli/main.js build --request <absolute-build.json> --config <absolute-host.json>
```

Inspect the terminal receipt, compact coverage metadata and `handoff.md`, not the entire context.md. Only a ready result with settled local work authorizes packet verification. Failed, cancelled or blocked results stop dispatch. A waiting observer does not establish job cancellation. Never switch to RP silently after failure.

Verify the saved bundle with `verify --bundle <absolute-bundle-directory> --mode integrity`. Before reusing it as unchanged-source context, use `--mode current --config <absolute-host.json>`. Verify the requested comparison, mandatory files/documents, deleted paths and material context gaps against the manifest and Git inventory. Byte integrity is not proof that discovery found sufficient context. A conflict with the original assignment blocks dispatch.

Inspect `manifest.unavailableRoots`, `manifest.unavailableFiles` and the matching handoff metadata. These records identify unavailable roots, unreadable optional full/sliced files and pending optional manual codemaps omitted from the packet. Publication stops if required source content is unavailable; a pending required map keeps it blocked. An omitted body needed by the assignment blocks dispatch. Authorized Git evidence may include a deleted file's patch even when its ordinary body is omitted. Current verification rechecks I/O failures. For `codemapPending`, it checks the captured source and artifact key as historical readiness evidence. Create a new context to include recovered bodies.

## Deliver and retain evidence

Before dispatch, establish net recipient capacity for every primary and authorized fallback, accounting for system instructions, output, existing conversation, tools and processed attachment/dispatch overhead. Check the finished packet against those limits. Missing capacity evidence or insufficient capacity blocks delivery, not context assembly. Retain the packet and report the blocker; changing the assembly budget requires a user decision and a new build.

Pass only the verified absolute `context.md` path through `subagent.inputFiles`. It includes selected material, fixed constraints and the resulting literal prompt in the final `user_instructions`. `enhancementMode` selects Rewrite, Augment or Preserve; inspect the resulting prompt before delivery. Do not pass it through the RP-specific prepare-advisor-input utility, rewrite it in place, attach coordinator receipts as additional tasks, or replace source with summaries.

Use the short dispatch task required by the calling workflow. Keep the packet and dispatch text unchanged for a delivery retry or an authorized model fallback. For a different assignment or changed source/scope, make a new packet rather than sending an earlier planning/review task. A missing evidence gap may require another focused collection; entering another workflow does not itself require rediscovery.

Follow the existing Pi role definitions and the calling workflow's primary/fallback policy. Children receive no inherited conversation. Tool-free recipients need attached evidence, not instructions to read local paths. Record the session paths returned by delegation. Completion is asynchronous; do independent work or wait for notification without polling the session logs. Confirm complete delivery and a complete response separately from smip readiness.

For full answer export, retain `/Users/ww/dot314/agent/skills/context/scripts/export-response.mjs`. That utility exports Pi responses and is independent of RP packet preparation. Require a complete deliverable rather than accepting a completion notice, summary or path from a tool-free reviewer.

Record roots, revisions, comparisons, packet/manifest/receipt paths, recipients, outcomes and known gaps in a coordinator handoff. Keep live artifacts through the completion audit. Remove only this run's superseded scratch files with trash. Do not stage packets, transient reports or investigation notes unless requested; stage intended implementation and required documentation under the repository's rules.
