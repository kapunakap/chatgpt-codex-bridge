# Managed Worktrees

Local Codex creates one managed detached Git worktree for each new `codex` thread by default. `codex-reply` reuses that workspace. Set `worktree: false` only when a task explicitly needs the selected checkout.

## Starting state

- The source folder must be inside a Git working tree with a committed `HEAD`.
- The managed worktree starts from that exact commit in detached-HEAD state.
- Staged, unstaged, and untracked source-checkout changes are not copied.
- A selected repository subdirectory maps to the same relative directory in the worktree.
- Non-Git and unborn repositories run directly and expose the fallback reason in job status.

If the repository contains `.worktreeinclude`, ignored regular files matching its Git-ignore-style patterns are copied without overwriting tracked files. An ignored `AGENTS.override.md` is copied automatically. Source symlinks are skipped. These files remain subject to the normal Local Codex credential-file denies.

## Paths and permissions

`LOCAL_CODEX_WORKTREE_ROOT` defaults to:

```text
~/Library/Application Support/local-codex-worktrees
```

The directory is mode `0700`. Job status reports both `sourceCwd` and execution `cwd`. The worktree files are the write boundary. Git worktrees share repository metadata, so the validated Git common directory is also writable for Git objects, refs, indexes, and commits. The bridge control-state directory remains explicitly denied.

Worktree creation uses argument arrays rather than a shell and disables checkout hooks. It does not fetch, pull, install dependencies, or run setup commands. Repository checkout filters remain part of the trusted selected repository's Git configuration.

## Retention and snapshots

`LOCAL_CODEX_WORKTREE_RETENTION` defaults to `15` globally. Active and queued worktrees are protected. When another inactive worktree must be removed, Local Codex first creates:

- a private snapshot commit containing tracked changes and non-ignored untracked files;
- a verified portable Git bundle;
- a private overlay for declared `.worktreeinclude` files;
- a checksummed manifest.

Snapshots live under the mode-`0700` Local Codex control directory and bundle files are mode `0600`. Snapshot bundles are not automatically deleted. If any snapshot or verification step fails, the worktree is retained.

`codex-reply` and monitor `o open` restore pruned worktrees automatically. If the original repository still exists, restoration attaches another detached worktree to it. If it is missing, Local Codex rebuilds an isolated repository from the private bundle. Git-visible work and declared setup overlays are preserved; ignored files not listed in `.worktreeinclude` are disposable environment data and are not snapshotted.

Existing pre-v3.4 threads migrate as direct workspaces and are never moved automatically.
