# Files Touched for Pi (`pi-files-touched`)

`pi-files-touched` tracks file activity across the current Pi session branch and registers `/files-touched`, a picker for recorded reads, writes, edits, moves, and deletions. The list is sorted newest-first and has colored `R`/`W`/`E`/`M`/`D` operation badges and normalized paths.

Evolved from [`pi-mono/.pi/extensions/files.ts`](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/files.ts) by Mario Zechner (MIT).  See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Install

```bash
pi install npm:pi-files-touched
```

## What it tracks

`pi-files-touched` walks the current branch of the Pi session tree and collects file activity from:

- **Pi native tools**: `read`, `write`, `edit` tool calls matched with their tool results
- **RepoPrompt tools**: `rp` and `rp_exec` tool calls: `read_file`, `apply_edits`, `file_actions` (create/move/delete), `git mv`, `git rm`
- **Bash commands**: `sed -i` (edit), `cp`/`rsync` (write destination), `tee`/`touch` (write), `patch` (edit), `curl -o`/`wget -O` (write), `cat`/`head`/`tail` (read), shell output redirections to files (`>`, `>>`, `>|`, and file-descriptor forms such as `2>`, `2>>`, and `&>`), `mv` (move), `rm`/`trash` (delete), heredoc body filtering. Relative paths resolve against the directory set by an earlier literal `cd` in the same command; after a `cd` to a computed directory such as `cd "$DIR"`, relative paths are skipped and reported as incomplete
- **Codex filesystem tools when present in the session**: `exec_command` uses the same high-confidence literal shell coverage relative to its effective working directory; `apply_patch` records completed adds, updates, deletes, and moves, including the completed portion of a partial patch
- **Nested Code and Notebook tools**: `@howaboua/pi-codex-conversion` calls through `exec` and `wait`, including nested Pi tools, `apply_patch`, `exec_command`, `rp`, and `rp_exec`
- **RepoPrompt CLIs through shell tools**: `rp-cli` and `rpce-cli`, using inline JSON with `-c`/`--call` and `-j`/`--json`, or commands with `-e`/`--exec`

Live nested tracking requires pi-codex-conversion 3.0.30 or newer. With that version, the extension records completed nested calls, including calls completed through `wait`, and distinguishes failed calls from successful ones. It saves compact file-operation records in the session and deduplicates repeated `wait` snapshots. Older sessions use their saved traces.

Tracking is best effort. Successful calls are recorded; failed calls are skipped unless `apply_patch` reports completed partial changes. Missing or truncated evidence produces per-call diagnostics and at most one visible warning per session load. The picker still lists confirmed operations. Shell tracking covers literal commands and paths, not arbitrary scripts, JSON loaded from files or stdin, or direct Deno filesystem operations.

Use absolute paths in `rp-cli` and `rpce-cli` shell commands. Relative and root-qualified CLI paths belong to the targeted RepoPrompt workspace, so unresolved paths are skipped and reported as incomplete. Nested `rp` calls retain the same path normalization as direct `rp` calls.

For saved traces that predate live completion tracking, RepoPrompt calls are recorded only when the trace still shows a successful result. Ambiguous outcomes are reported as incomplete rather than recorded as successful edits. Aborting an outer `exec` or `wait` retains confirmed operations and reports unfinished calls as incomplete.

Supported path spellings are normalized and coalesced so the same file appears once regardless of how different tools referred to it. File moves are tracked and earlier references are carried forward to the final path.

## Shared core for other extensions

The tracking engine lives in `extensions/_shared/files-touched-core.ts` and `extensions/_shared/files-touched-nested.ts`. TypeBox schemas in `extensions/_shared/files-touched-contract.ts` validate tool arguments and saved file records. Copy all three files when using the shared collector in another extension.

Other extensions can use the collector across any segment of the session tree. Call `registerFilesTouchedTracking(pi)` during extension initialization to capture live nested calls. Extensions that register the collector share one recorder when loaded together.

```typescript
import { collectFilesTouched, type FilesTouchedEntry, type FileTouchOperation } from "./_shared/files-touched-core.ts";

// Walk the current branch
const files = collectFilesTouched(ctx.sessionManager.getBranch(), ctx.cwd);

// Or pass any subset of session entries (e.g., the entries being compacted)
const spanFiles = collectFilesTouched(entriesToSummarize, ctx.cwd);
```

This is useful for extensions that generate compaction summaries, handoff documents, branch summaries, or anywhere else benefiting from a grounded file manifest instead of relying on LLM inference-mediated recall.

## `/files-touched`

Opens an interactive picker listing all files on the current branch.  You can select a file to open it in VS Code (supports Windows `cmd` launch hardening).

```
 ┌──────────────────────────────────────────────────┐
  Select file to open
  ▸ RW src/header.txt
    RE src/utils.ts
    E  src/config.ts
    W  src/synced.ts
    W  data/downloaded.json
    W  src/redirected.ts
    W  src/brand-new.ts
    W  src/copy.ts
  ↑↓ navigate • ←→ page • enter open • esc close
 └──────────────────────────────────────────────────┘
```

## License

MIT
