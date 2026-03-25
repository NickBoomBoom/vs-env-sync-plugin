# Env Sync

Env Sync automatically synchronizes matched environment files for each Git project with a dedicated repository.

Use it when you want a single private repo to back up, share, and restore `.env`-style files per project without manually copying them around.

## Features

- Configure one existing private Git repository as the env config repository
- Detect the current project's Git `origin` and map it to a fixed folder in the config repository
- Pull matched env files when a workspace opens
- Commit and push matched env file changes after local edits
- Prompt instead of silently overwriting when local and remote contents differ
- Match files with multiple workspace-relative path regexes

## How It Works

Env Sync reads the current workspace folder's `remote.origin.url` and normalizes it to:

```text
github.com/<owner>/<repo>
```

Examples:

- `git@github.com:team/app.git`
- `https://github.com/team/app.git`
- `ssh://git@github.com/team/app.git`

All map to:

```text
github.com/team/app
```

Inside the config repository, files are stored at:

```text
projects/<host>/<owner>/<repo>/
```

For example:

```text
projects/github.com/team/app/.env.local
projects/github.com/team/app/config/.env.dev
```

## Sync Behavior

On workspace open:

- Remote exists, local missing: pull remote file into the workspace
- Local exists, remote missing: prompt `Upload local` or `Skip`
- Both exist and are identical: do nothing
- Both exist and differ: prompt `Pull remote`, `Upload local`, or `Skip`

On local file change:

- Matched file create or change events are debounced for 3 seconds
- Changes are mirrored into the config repository
- The config repository is committed and pushed automatically
- Deletes are mirrored to the config repository too

All sync jobs run through a single serial queue so multiple workspaces do not race on the same config repository clone.

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

An array of JavaScript regex strings matched against workspace-relative POSIX paths. A file is synchronized when any regex matches.

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

### `Env Sync: Initialize Config Repo`

Prompts for:

- Config Repo URL
- Config Repo Branch

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

- First upload prompt
- Automatic push after save
- Delete propagation
- Pull on reopen or reload

## Limitations

- Only file-system workspaces are supported
- Untrusted workspaces are not supported
- Virtual workspaces are not supported
- The extension does not create the GitHub repository for you
- The extension does not encrypt secrets before commit
- Project mapping is fixed to `origin -> projects/<host>/<owner>/<repo>/`

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
