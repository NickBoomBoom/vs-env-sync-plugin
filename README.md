# Env Sync

Env Sync automatically synchronizes matched environment files for each Git project with a dedicated repository.

Use it when you want a single private repo to back up, share, and restore `.env`-style files per project without manually copying them around.

## Features

- Configure one existing private Git repository as the env config repository
- Recursively discover Git projects inside the current workspace folder
- Detect each discovered Git project's `origin` and current branch, and map them to a branch-specific folder
- Pull matched env files when a workspace opens
- Commit and push matched env file changes after local edits
- Prompt instead of silently overwriting when local and remote contents differ
- Match files with multiple Git-project-relative path regexes
- Show current sync state in the VS Code status bar
- Skip configured directory names while recursively searching for Git projects
- Classify common Git failures like auth, network, push rejection, and rebase conflicts

## How It Works

Env Sync scans the current workspace folder for Git projects up to a configurable depth and reads each discovered project's `remote.origin.url` and current branch. Project identities preserve the full group path, such as `gitlab.com/group/subgroup/app`, so nested GitLab groups cannot collide.

Starting with **0.3.0**, ordinary project and branch names are readable again. For `github.com/NickBoomBoom/electron-ai-switch` on business branch `v3`, the exact directory is:

```text
projects/github.com/NickBoomBoom/electron-ai-switch/branches/v3
```

This directory is on the **config repository's Git branch**, normally `main`. The business branch is a directory; the extension does not create a config-repository Git branch named `v3`.

Full nested group paths are preserved. Safe lowercase branch names such as `main` and `v3` remain unchanged; `/` becomes `%2F`, a literal `%` becomes `%25`, and other special characters use UTF-8 percent encoding. Uppercase branch names such as `Feature`, Windows-reserved names, and long names keep a readable prefix followed by `~` and a 16-hex-character hash. GitHub project names retain the original `origin` casing; potentially case-sensitive hosts protect mixed-case project components with a readable prefix and hash suffix. Extremely long/deep project paths use a `~project-<readable-prefix>~<hash>` fallback. The identity marker records the real project and branch. See [Storage layout and migration design](docs/STORAGE.md) for precise rules and examples.

### Upgrade from 0.2.2–0.2.7

Those historical releases used pure-hash directories:

```text
projects/<host>/<project-path-hash>/branches/<branch-name-hash>/
```

**Old directories are preserved, not deleted.** A complete hash branch snapshot is preferred and copied as a whole; missing files are not supplemented from an older shared directory because their absence may represent a deletion. A version-1 marker in an existing readable directory does not bypass this hash-source check. Different contents at the same path or target-only files require a separate modal choice before migration: adopt the source snapshot, retain the readable target without merging, or cancel this sync without advancing its baseline. When adopting a conflicting source, the old target is archived inside `.env-sync-archive` before its active files are replaced; the old source remains unchanged. Archives contain env secrets, are committed with that branch directory, and are excluded from active scanning.

Migration uses a resumable `env-sync-migration.json` journal and writes the final version-2 / `readable-v2` identity marker last. A changed source during retry, an identity mismatch, or a redirected/symlink path stops migration. Ambiguous older nested-group owner/repo layouts require source confirmation. Only an equivalent complete hash snapshot can retain the existing baseline; retaining a target different from the hash snapshot, or adopting an older/incomplete legacy source, uses `baselineGeneration` isolation. State is saved only after successful commit/push handling. The design document explains conflict selection, recovery, and baseline rules.

After installing 0.3.0 and reloading VS Code, open the desired project, switch to the desired business branch, and run **Env Sync：立即重新同步**. This migrates the current branches of projects discovered in the open workspace; it does **not** bulk-migrate every unopened project or every unselected branch. Review any migration prompt before proceeding, then browse the readable path on the config repository's `main` branch (or your configured branch).

Upgrade **all clients** sharing the config repository. Once a branch has a completed readable-v2 marker, the readable directory is authoritative: old source changes only produce a warning and are never automatically merged or mirrored back. Old directories remain for reference, not as a second source of truth; completed migration does not re-import them or revive deleted files. Projects in detached HEAD state are skipped because no business branch name is available.

## Sync Behavior

On workspace open:

- Search for Git projects under the current workspace folder and resolve their current branches
- Resolve the current branch again before every sync, prepare its readable store, and safely resume migration of hash/legacy snapshots when needed
- Keep a per-device baseline of successfully synchronized files and compare local, remote, and baseline state
- Remote-only additions or edits are pulled; remote-only deletions remove the local file
- Local-only additions or edits are uploaded; a remote file is deleted only when the baseline proves it was deleted locally
- Divergent changes prompt `拉取远端文件`, `上传本地文件`, or `跳过`
- Skipping keeps the old baseline, so saving another file cannot silently overwrite the skipped conflict

On local file change:

- Matched create, change, and delete events are debounced for 3 seconds
- Commits are limited to the current project branch directory and pushed automatically
- Rejected pushes are retried with fetch/rebase, and existing unpushed commits are retried by later syncs
- Multiple VS Code windows serialize access to the same config clone with a cross-process lock
- Real worktree HEAD files are watched, and extension writes are distinguished from user edits by content hash

## Status Bar And Errors

Env Sync adds a status bar item:

- `$(check)`: idle
- `$(sync~spin)`: a workspace-open or push sync is running
- `$(error)`: the last sync failed

Click the status bar item to open the `Env Sync` output channel.

Common Git failures are classified into clearer messages, including:

- repository access denied
- network access failed
- push rejected by the remote
- rebase or merge conflict
- Git executable unavailable

## Diagnose And Repair Commands

Available from 0.2.5. Open the Command Palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS) and search for `Env Sync`:

| Command ID | Command Palette title | Purpose |
| --- | --- | --- |
| `envSync.diagnoseConfigRepo` | Env Sync：诊断配置仓库 | Show the managed cache path, branch, working tree status, stashes and rebase state in the output channel. Does not access the network, clone, or modify the repository. |
| `envSync.repairConfigRepo` | Env Sync：修复未完成的 rebase | Repair only the extension's cached config repository, not business project repositories. After confirmation, create a full backup before aborting an unfinished rebase. Make no changes if no rebase is present. |
| `envSync.syncNow` | Env Sync：立即重新同步 | Rerun workspace sync. This can pull, commit and push env files; it is not read-only. |
| `envSync.showOutput` | Env Sync：显示输出 | View diagnostics, errors and backup paths. |
| `envSync.openConfigRepo` | Env Sync：打开配置仓库目录 | Reveal the managed cache on the extension-host machine for manual inspection; does not open or change business project repositories. |

Repair workflow and safety boundaries:

1. Inspect the extension-owned config cache. If no unfinished rebase exists, leave the repository unchanged.
2. Explain the effects in a confirmation dialog. Cancellation does not create a backup or abort the rebase.
3. Make a complete backup under `repair-backups` in the same extension `globalStorage`, including `.git` and ignored/untracked env files. If backup fails, do not abort. Backups may contain env secrets: keep them secure.
4. Only after a successful backup, run `git rebase --abort`; never delete the rebase state directory. Do not automatically pop stashes, force-push, or reset. Aborting discards the current rebase and its conflict-resolution progress.
5. If abort fails, retain the backup and inspect the output channel for the error and backup path. Do not delete the rebase directory manually.
6. After success, let the user choose “立即重新同步” rather than silently starting sync. Actual content conflicts can recur and still require manual resolution; retained stashes are not restored automatically.

For an existing `rebase-merge` directory, diagnose first, confirm backup and repair, review retained stashes, then choose whether to retry sync.

If 0.2.5 reports “配置仓库未能提交本轮 env 变更” even though diagnostics show no rebase and a clean working tree, upgrade to 0.2.6 and retry sync; another rebase repair is not needed. Git normalization (such as `core.autocrlf=true`) can leave no staged differences after an env write: this is a successful no-op, not a failed commit. Real Git failures still stop sync without advancing the baseline. Upgrading does not restore or remove existing stashes.

## Requirements

- VS Code 1.112.0 or newer
- `git` installed on the machine running the extension host
- A private Git repository already created for env sync data
- Working Git authentication, such as SSH keys or a credential helper
- `git config user.name` and `git config user.email` configured for commits

## Settings

### `envSync.configRepoUrl`

The private Git repository used to store synchronized env files.

Example:

```text
git@github.com:your-org/env-config.git
```

### `envSync.configRepoBranch`

The branch used in the config repository.

Default:

```text
main
```

### `envSync.pathRegexes`

An array of JavaScript regex strings matched against Git-project-relative POSIX paths. A file is synchronized when any regex matches.

Default:

```json
[
  "^\\.env[^/]*$"
]
```

That default matches only root-level files starting with `.env`, such as:

- `.env`
- `.env.local`
- `.env.production.local`

It does not match nested files like `config/.env.local`.

### `envSync.gitProjectSearchDepth`

Controls how many directory levels below the workspace root are searched for Git projects.

Default:

```json
2
```

Examples:

- `0`: only check the workspace root itself
- `1`: check the workspace root and its direct child directories
- `2`: check the workspace root, children, and grandchildren

If you open a parent folder that contains multiple sibling repositories, this setting controls how deep Env Sync looks for them.

### `envSync.gitProjectIgnoreDirectories`

Directory names skipped while recursively searching for Git projects under the workspace root.

Default:

```json
[
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store"
]
```

This setting only affects Git project discovery. It is useful when you open a large parent folder and want Env Sync to ignore generated output or package-store directories.

### `envSync.syncIgnoreDirectories`

Directory names skipped while scanning local projects and the config repository for env files. The default matches the project-discovery ignore list:

```json
[
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store"
]
```

Use this setting to reduce traversal and memory usage in large projects. Nested Git project roots and internal Env Sync metadata are always excluded.

### `envSync.notificationLevel`

Controls how much Env Sync reports through VS Code notifications.

Default:

```json
"summary"
```

Available values:

- `errors`: only show error notifications
- `summary`: show successful sync summaries when files were actually pulled, uploaded, updated, or deleted
- `all`: also show no-op checks, such as when a project was scanned and nothing needed to change

Examples:

Sync only root `.env*` files:

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$"
  ]
}
```

Sync root `.env*` files and `config/.env*` files:

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^config/\\.env[^/]*$"
  ],
  "envSync.gitProjectIgnoreDirectories": [
    "node_modules",
    "dist",
    "coverage"
  ]
}
```

Sync only `.env` and `.env.local`:

```json
{
  "envSync.pathRegexes": [
    "^\\.env$",
    "^\\.env\\.local$"
  ]
}
```

Sync root `.env*` files and one specific secret file:

```json
{
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^secrets/\\.runtime\\.env$"
  ]
}
```

### `envSync.pathRegex`

Deprecated single-regex fallback. New setups should use `envSync.pathRegexes`.

## Command

### `Env Sync：初始化配置仓库`

Prompts for:

- 配置仓库 URL
- 配置仓库分支

The extension validates the repository with `git ls-remote` before saving the configuration.

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Launch the extension in VS Code:

- Open this repository in VS Code
- Press `F5`
- Select `Run Env Sync Extension`

The project already includes `.vscode/launch.json` for extension debugging.

## Packaging

Build a VSIX locally:

```bash
npm run package:vsix
```

This uses the locally installed `@vscode/vsce` binary to create a `.vsix` package from the built extension.

## Publishing To The Marketplace

Before publishing:

1. Create or confirm your Marketplace publisher ID
2. Make sure the `publisher` field in `package.json` matches that exact publisher ID
3. Create an Azure DevOps Personal Access Token with Marketplace `Manage` scope
4. Log in with `vsce`
5. Publish

Typical commands:

```bash
npx @vscode/vsce login <publisher-id>
npm run deploy
```

If you prefer manual upload:

```bash
npm run package:vsix
```

Then upload the generated `.vsix` in the Marketplace publisher management page.

## GitHub Actions Release Flow

This repository includes a release workflow at `.github/workflows/publish.yml`.

Behavior:

- Pull requests to `main`: run install and test only
- Pushes to `main`: run install and test only
- Pushes of tags matching `v*`: run validation, package the extension, upload the VSIX artifact, and publish to the Visual Studio Marketplace
- Manual dispatch: optionally publish the current `main` branch

### Required GitHub secret

Create this repository secret:

- `VSCE_PAT`: your Azure DevOps Marketplace Personal Access Token with `Marketplace > Manage` scope

### Recommended release process

1. Update `package.json` version and `CHANGELOG.md`
2. Commit to `main`
3. Create a matching Git tag, for example `v0.1.0`
4. Push the branch and tag

Example:

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

The workflow validates that the Git tag version matches `package.json` before publishing.

### Manual publish

You can also run the workflow manually from GitHub Actions by enabling the `publish` input. Manual publish is restricted to the `main` branch in the workflow.

## Manual Test Flow

Create a local bare repo to simulate the config repository:

```bash
mkdir -p /tmp/env-sync-demo
cd /tmp/env-sync-demo
git init --bare config.git

git clone /tmp/env-sync-demo/config.git config-seed
cd config-seed
git config user.name tester
git config user.email tester@example.com
echo "# seed" > README.md
git add README.md
git commit -m init
git branch -M main
git push -u origin main
```

Create a test project:

```bash
cd /tmp/env-sync-demo
mkdir app
cd app
git init
git config user.name tester
git config user.email tester@example.com
git remote add origin git@github.com:team/app.git
echo "A=1" > .env.local
mkdir -p config
echo "B=2" > config/.env.dev
```

Example settings:

```json
{
  "envSync.configRepoUrl": "/tmp/env-sync-demo/config.git",
  "envSync.configRepoBranch": "main",
  "envSync.pathRegexes": [
    "^\\.env[^/]*$",
    "^config/\\.env[^/]*$"
  ]
}
```

Open the test project in the extension host, initialize the config repo, and validate:

- First `上传本地文件` prompt
- Automatic push after save
- Delete propagation
- Pull on reopen or reload

## Limitations

- Only file-system workspaces are supported
- Untrusted workspaces are not supported
- Virtual workspaces are not supported
- The extension does not create the GitHub repository for you
- The extension does not encrypt secrets before commit
- Storage uses the readable-v2 naming and collision-protection rules described in [the storage design](docs/STORAGE.md); arbitrary custom layouts are not supported
- Preserved hash/legacy directories are historical snapshots after migration, not a bidirectional mirror; upgrade all clients before relying on readable-v2 data

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
