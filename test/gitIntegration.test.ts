import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { GitCli } from "../src/core/git";
import { compilePathRegexes } from "../src/core/pathRegex";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

class TestLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class TestPrompts implements SyncPrompts {
  async chooseLocalOnly(): Promise<"upload" | "skip"> {
    return "upload";
  }

  async chooseConflict(): Promise<"pull" | "upload" | "skip"> {
    return "pull";
  }
}

async function git(gitCli: GitCli, cwd: string, ...args: string[]): Promise<string> {
  return gitCli.run(args, { cwd });
}

async function createBareRepo(basePath: string, name: string, gitCli: GitCli): Promise<string> {
  const repoPath = path.join(basePath, name);
  await fs.mkdir(repoPath, { recursive: true });
  await git(gitCli, repoPath, "init", "--bare");
  return repoPath;
}

async function cloneRepo(basePath: string, remotePath: string, name: string, gitCli: GitCli): Promise<string> {
  const repoPath = path.join(basePath, name);
  await gitCli.run(["clone", remotePath, repoPath]);
  await git(gitCli, repoPath, "config", "user.email", "test@example.com");
  await git(gitCli, repoPath, "config", "user.name", "Test User");
  return repoPath;
}

async function createInitialCommit(repoPath: string, gitCli: GitCli, filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, filePath)), { recursive: true });
  await fs.writeFile(path.join(repoPath, filePath), content);
  await git(gitCli, repoPath, "add", "-A");
  await git(gitCli, repoPath, "commit", "-m", "initial");
  await git(gitCli, repoPath, "branch", "-M", "main");
  await git(gitCli, repoPath, "push", "-u", "origin", "main");
}

function createContext(workspacePath: string): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "workspace",
    project: {
      host: "github.com",
      owner: "team",
      repo: "app",
      slug: "github.com/team/app"
    },
    pathRegexSources: ["^\\.env[^/]*$"],
    pathRegexes: compilePathRegexes(["^\\.env[^/]*$"])
  };
}

describe("git integration", () => {
  it("clones, pulls and pushes env changes through the config repo manager", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-git-"));
    const gitCli = new GitCli();
    const bareConfigRepo = await createBareRepo(root, "config.git", gitCli);
    const seedClone = await cloneRepo(root, bareConfigRepo, "config-seed", gitCli);
    await createInitialCommit(
      seedClone,
      gitCli,
      path.join("projects", "github.com", "team", "app", ".env.local"),
      "REMOTE=1\n"
    );

    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });

    const manager = new ConfigRepoManager(path.join(root, "storage"), gitCli, new TestLogger());
    const engine = new EnvSyncEngine(manager, new TestPrompts(), new TestLogger());
    const settings = {
      repoUrl: bareConfigRepo,
      branch: "main"
    };

    const openResult = await engine.syncOnWorkspaceOpen(settings, createContext(workspacePath));
    assert.deepEqual(openResult, {
      uploadedPaths: [],
      pulledPaths: [".env.local"],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(workspacePath, ".env.local"), "utf8"), "REMOTE=1\n");

    await fs.writeFile(path.join(workspacePath, ".env.local"), "REMOTE=2\n");
    const pushResult = await engine.syncLocalChanges(settings, createContext(workspacePath));
    assert.deepEqual(pushResult, {
      pushedPaths: [".env.local"],
      deletedPaths: [],
      committed: true
    });

    const verifyClone = await cloneRepo(root, bareConfigRepo, "config-verify", gitCli);
    await git(gitCli, verifyClone, "checkout", "main");
    assert.equal(
      await fs.readFile(path.join(verifyClone, "projects", "github.com", "team", "app", ".env.local"), "utf8"),
      "REMOTE=2\n"
    );
  });
});
