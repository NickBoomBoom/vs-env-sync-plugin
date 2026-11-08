import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { GitCli, GitRunOptions } from "../src/core/git";
import { branchStorePath, hashedBranchStorePath, BRANCH_METADATA_FILE } from "../src/core/storagePaths";
import { SyncStateStore } from "../src/core/syncStateStore";
import { WorkspaceSyncContext } from "../src/core/types";

class MigrationGit extends GitCli {
  run(args: string[], options: GitRunOptions = {}): Promise<string> {
    return super.run(["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "init.defaultBranch=main", ...args], options);
  }
}

describe("real Git readable storage cutover", function () {
  this.timeout(180000);
  it("publishes v3 under the original readable path while retaining hash history and later deletions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-readable-git-"));
    try {
      const git = new MigrationGit();
      const run = (cwd: string, ...args: string[]) => git.run(args, { cwd });
      const origin = path.join(root, "origin.git");
      const seed = path.join(root, "seed");
      const workspacePath = path.join(root, "workspace");
      await fs.mkdir(origin);
      await fs.mkdir(workspacePath);
      await run(origin, "init", "--bare");
      await git.run(["clone", origin, seed]);
      await run(seed, "config", "user.email", "test@example.com");
      await run(seed, "config", "user.name", "Readable Migration Test");
      const context: WorkspaceSyncContext = {
        workspacePath, workspaceName: "electron-ai-switch", branch: "v3",
        project: { host: "github.com", owner: "NickBoomBoom", repo: "electron-ai-switch", path: "NickBoomBoom/electron-ai-switch", slug: "github.com/NickBoomBoom/electron-ai-switch" },
        pathRegexSources: ["^\\.env[^/]*$"], pathRegexes: [/^\.env[^/]*$/], ignoredProjectRoots: [], ignoredDirectoryNames: []
      };
      const oldRoot = hashedBranchStorePath(seed, context);
      await fs.mkdir(oldRoot, { recursive: true });
      const names = [".env", ".env.example", ".env.prod", ".env.test"];
      for (const name of names) await fs.writeFile(path.join(oldRoot, name), `SAMPLE=${name}\n`);
      await fs.writeFile(path.join(oldRoot, BRANCH_METADATA_FILE), "{\"version\":1}\n");
      await run(seed, "add", "-f", "-A");
      await run(seed, "commit", "-m", "seed old hashed v3 snapshot");
      await run(seed, "push", "-u", "origin", "main");
      const settings = { repoUrl: origin, branch: "main" };
      const logger = { info() {}, warn() {}, error() {} };
      const manager = new ConfigRepoManager(path.join(root, "storage"), git, logger);
      const ready = await manager.ensureReady(settings);
      await run(ready.repoPath, "config", "user.email", "test@example.com");
      await run(ready.repoPath, "config", "user.name", "Readable Migration Test");
      const prompts = { async chooseLocalOnly() { return "upload" as const; }, async chooseConflict() { return "upload" as const; } };
      const state = new SyncStateStore(path.join(root, "state"));
      const engine = new EnvSyncEngine(manager, prompts, logger, state);
      const result = await engine.syncOnWorkspaceOpen(settings, context);
      assert.deepEqual([...result.pulledPaths].sort(), [...names].sort());
      const readable = path.posix.join("projects", "github.com", "NickBoomBoom", "electron-ai-switch", "branches", "v3");
      assert.equal(path.relative(ready.repoPath, branchStorePath(ready.repoPath, context)).split(path.sep).join("/"), readable);
      const oldRelative = path.relative(seed, oldRoot).split(path.sep).join("/");
      for (const name of names) {
        assert.equal(await run(origin, "show", `main:${readable}/${name}`), `SAMPLE=${name}`);
        assert.equal(await run(origin, "show", `main:${oldRelative}/${name}`), `SAMPLE=${name}`);
        assert.equal(await fs.readFile(path.join(workspacePath, name), "utf8"), `SAMPLE=${name}\n`);
      }
      const metadata = JSON.parse(await run(origin, "show", `main:${readable}/${BRANCH_METADATA_FILE}`));
      assert.equal(metadata.version, 2);
      assert.equal(metadata.project.path, "NickBoomBoom/electron-ai-switch");
      assert.equal(metadata.branch, "v3");
      const head = await run(origin, "rev-parse", "refs/heads/main");
      await engine.syncOnWorkspaceOpen(settings, context);
      assert.equal(await run(origin, "rev-parse", "refs/heads/main"), head, "equivalent subsequent sync must be a no-op");
      await fs.unlink(path.join(workspacePath, ".env.test"));
      await engine.syncLocalChanges(settings, context);
      const activeTree = await run(origin, "ls-tree", "--name-only", "main", "--", `${readable}/.env.test`);
      assert.equal(activeTree, "");
      await engine.syncOnWorkspaceOpen(settings, context);
      await assert.rejects(fs.access(path.join(workspacePath, ".env.test")));
      assert.equal(await run(origin, "show", `main:${oldRelative}/.env.test`), "SAMPLE=.env.test");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
