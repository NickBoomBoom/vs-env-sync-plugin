# Changelog

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
