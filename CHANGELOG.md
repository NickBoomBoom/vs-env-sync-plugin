# Changelog

## 0.2.3

- Fixed rebase failures and prevented local data loss when the remote starts tracking previously untracked or ignored env files.

## 0.2.2

- Added per-device three-way sync baselines so remote additions from other devices are never mistaken for local deletions.
- Added persistent conflict-skip behavior, safe local/remote deletion handling, and recovery for interrupted commits and pushes.
- Added full project identities, collision-safe hashed storage, resumable legacy migration, and path containment checks.
- Scoped config commits to the current project branch and preserved unrelated staged changes and local branch commits.
- Added cross-process locking for shared config clones and safe retry of unpushed commits.
- Added worktree HEAD tracking, content-based watcher suppression, and coalesced session refreshes.
- Added `envSync.syncIgnoreDirectories`, streaming file scans, and credential redaction in logs and errors.
- Avoided `FETCH_HEAD` races by rebasing explicitly onto the configured remote branch.

## 0.2.1

- Fixed stack overflow when scanning projects with very large file trees.
- Preserved uncommitted config-repository changes during checkout and rebase with autostash.

## 0.2.0

- Added branch-specific env storage and legacy shared-data inheritance.
- Added current-branch discovery and detached HEAD safeguards.

## 0.1.2

- Added status bar sync feedback with compact icon-only states.
- Added clearer Git error classification for auth, network, push rejection, and conflict cases.
- Added `envSync.gitProjectIgnoreDirectories` for recursive Git project discovery.
- Added notification level control and richer project-specific sync prompts.
- Added Chinese documentation in `README.cn.md`.

## 0.1.1

- Added recursive Git project discovery inside a workspace folder.
- Added `envSync.gitProjectSearchDepth` to control Git project search depth.
- Synced env matching against project-relative paths for nested repositories.

## 0.1.0

- Initial Marketplace release.
- Added automatic config repository initialization and validation.
- Added workspace-open sync from a dedicated env repository.
- Added automatic upload, commit, and push for matched env file changes.
- Added support for multiple path regex matchers with legacy single-regex fallback.
- Added build, test, and VSIX packaging workflow.
