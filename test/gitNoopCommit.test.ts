import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager, ReadyConfigRepo } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { GitCli, GitCommandError, GitRunOptions } from "../src/core/git";
import { compilePathRegexes } from "../src/core/pathRegex";
import { SyncStateStore } from "../src/core/syncStateStore";
import { branchDirectoryName } from "../src/core/storagePaths";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

const envFile = ".env.local";
const initialLf = "VALUE=1\n";
const initialCrlf = "VALUE=1\r\n";
const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");

function readableBranchFile(branch: string, ...relativePaths: string[]): string {
  return path.join("projects", "github.com", "team", "app", "branches", branchDirectoryName(branch), ...relativePaths);
}

class TestLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class TestPrompts implements SyncPrompts {
  async chooseLocalOnly(): Promise<"upload" | "skip"> { return "upload"; }
  async chooseConflict(): Promise<"pull" | "upload" | "skip"> { return "upload"; }
}

/** Command-line config wins over both machine config and GIT_CONFIG_* test overrides. */
class ControlledGit extends GitCli {
  readonly calls: string[][] = [];
  failCommand: "commit" | "push" | undefined;

  async run(args: string[], options: GitRunOptions = {}): Promise<string> {
    this.calls.push([...args]);
    if (args[0] === this.failCommand) {
      throw new GitCommandError(`controlled ${this.failCommand} failure`, "injected Git failure", "", 1);
    }
    return super.run([
      "-c", "core.autocrlf=true",
      "-c", "core.longpaths=true",
      "-c", "init.defaultBranch=main",
      ...args
    ], options);
  }
}

/** Observe the real manager result, without simulating false or replacing Git's staged-diff check. */
class RecordingConfigRepoManager extends ConfigRepoManager {
  readonly commitResults: boolean[] = [];

  async commitProjectChanges(repo: ReadyConfigRepo, projectStorePath: string, message: string): Promise<boolean> {
    const result = await super.commitProjectChanges(repo, projectStorePath, message);
    this.commitResults.push(result);
    return result;
  }
}

function createContext(workspacePath: string): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "workspace",
    branch: "main",
    project: { host: "github.com", owner: "team", repo: "app", path: "team/app", slug: "github.com/team/app" },
    pathRegexSources: ["^\\.env[^/]*$"],
    pathRegexes: compilePathRegexes(["^\\.env[^/]*$"]),
    ignoredProjectRoots: [],
    ignoredDirectoryNames: []
  };
}

async function createFixture(root: string) {
  const git = new ControlledGit();
  const run = (cwd: string, ...args: string[]) => git.run(args, { cwd });
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await fs.mkdir(origin, { recursive: true });
  await run(origin, "init", "--bare");
  await git.run(["clone", origin, seed]);
  await run(seed, "config", "user.email", "test@example.com");
  await run(seed, "config", "user.name", "No-op Regression Test");
  const relativeEnvPath = readableBranchFile("main", envFile);
  await fs.mkdir(path.dirname(path.join(seed, relativeEnvPath)), { recursive: true });
  await fs.writeFile(path.join(seed, relativeEnvPath), initialLf);
  // Seed the migration marker so an incidental metadata commit cannot hide the no-op.
  const metadata = { version: 2, layout: "readable-v2", project: { host: "github.com", path: "team/app" }, branch: "main" };
  await fs.writeFile(path.join(seed, readableBranchFile("main", "env-sync-branch.json")), `${JSON.stringify(metadata)}\n`);
  await run(seed, "add", "--all");
  await run(seed, "commit", "-m", "seed existing branch store");
  await run(seed, "push", "--set-upstream", "origin", "main");

  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, envFile), initialLf);
  const context = createContext(workspace);
  const settings = { repoUrl: origin, branch: "main" };
  const logger = new TestLogger();
  const manager = new RecordingConfigRepoManager(path.join(root, "storage"), git, logger);
  const ready = await manager.ensureReady(settings);
  await run(ready.repoPath, "config", "user.email", "test@example.com");
  await run(ready.repoPath, "config", "user.name", "No-op Regression Test");
  assert.equal(await fs.readFile(path.join(ready.repoPath, relativeEnvPath), "utf8"), initialCrlf,
    "the config clone must actually check out CRLF bytes, not just set a config flag");

  await fs.writeFile(path.join(ready.repoPath, "previously-stashed.txt"), "KEEP=1\n");
  await run(ready.repoPath, "stash", "push", "--include-untracked", "-m", "preserve existing stash");
  const state = new SyncStateStore(path.join(root, "state"));
  const initialBaseline = new Map([[envFile, hashContent(initialCrlf)]]);
  await state.write(settings, context, initialBaseline);
  const engine = new EnvSyncEngine(manager, new TestPrompts(), logger, state);
  const headBefore = await run(ready.repoPath, "rev-parse", "HEAD");
  const stashBefore = await run(ready.repoPath, "rev-parse", "refs/stash");
  const countBefore = await run(ready.repoPath, "rev-list", "--count", "HEAD");
  const originHeadBefore = await run(origin, "rev-parse", "refs/heads/main");
  git.calls.length = 0;
  return {
    git, run, origin, workspace, context, settings, manager, ready, state, engine,
    relativeEnvPath, initialBaseline, headBefore, stashBefore, countBefore, originHeadBefore
  };
}

describe("real Git no-op commits under core.autocrlf=true", function () {
  this.timeout(120_000);
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "env-noop-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("accepts an LF write with no staged diff and advances the baseline without a commit", async () => {
    const fixture = await createFixture(root);
    const result = await fixture.engine.syncLocalChanges(fixture.settings, fixture.context);

    assert.deepEqual(result, {
      pushedPaths: [envFile], deletedPaths: [], pulledPaths: [], deletedLocalPaths: [], skippedPaths: [], committed: false
    });
    assert.deepEqual(fixture.manager.commitResults, [false], "false is a real Git no-op, not a commit failure");
    assert.equal(await fs.readFile(path.join(fixture.ready.repoPath, fixture.relativeEnvPath), "utf8"), initialLf,
      "the engine must have written LF over the CRLF checkout");
    assert.equal(await fixture.run(fixture.ready.repoPath, "diff", "--cached", "--quiet"), "");
    assert.ok(!fixture.git.calls.some(args => args[0] === "commit" || args[0] === "push"));
    assert.equal(await fixture.run(fixture.ready.repoPath, "rev-parse", "HEAD"), fixture.headBefore);
    assert.equal(await fixture.run(fixture.ready.repoPath, "rev-list", "--count", "HEAD"), fixture.countBefore);
    assert.equal(await fixture.run(fixture.origin, "rev-parse", "refs/heads/main"), fixture.originHeadBefore);
    assert.equal(await fixture.run(fixture.ready.repoPath, "rev-parse", "refs/stash"), fixture.stashBefore);
    assert.deepEqual(await fixture.state.read(fixture.settings, fixture.context), new Map([[envFile, hashContent(initialLf)]]));
    assert.notEqual(hashContent(initialLf), fixture.initialBaseline.get(envFile), "baseline advancement must be observable");
  });

  for (const command of ["commit", "push"] as const) {
    it(`does not advance the baseline when a real-content change fails during ${command}`, async () => {
      const fixture = await createFixture(root);
      await fs.writeFile(path.join(fixture.workspace, envFile), "VALUE=2\n");
      fixture.git.failCommand = command;

      await assert.rejects(fixture.engine.syncLocalChanges(fixture.settings, fixture.context), (error: unknown) => {
        assert.ok(error instanceof GitCommandError);
        assert.match(error.message, new RegExp(`controlled ${command} failure`));
        return true;
      });
      fixture.git.failCommand = undefined;
      assert.ok(fixture.git.calls.some(args => args[0] === command), "the intended real commit/push path must be reached");
      assert.deepEqual(await fixture.state.read(fixture.settings, fixture.context), fixture.initialBaseline);
      assert.equal(await fixture.run(fixture.origin, "rev-parse", "refs/heads/main"), fixture.originHeadBefore);
      assert.equal(await fixture.run(fixture.ready.repoPath, "rev-parse", "refs/stash"), fixture.stashBefore);
      if (command === "commit") {
        assert.equal(await fixture.run(fixture.ready.repoPath, "rev-parse", "HEAD"), fixture.headBefore);
        assert.match(await fixture.run(fixture.ready.repoPath, "diff", "--cached", "--name-only"), /\.env\.local/);
      } else {
        assert.notEqual(await fixture.run(fixture.ready.repoPath, "rev-parse", "HEAD"), fixture.headBefore);
        const gitEnvPath = fixture.relativeEnvPath.split(path.sep).join("/");
        assert.equal(await fixture.run(fixture.ready.repoPath, "show", `HEAD:${gitEnvPath}`), "VALUE=2");
      }
    });
  }
});
