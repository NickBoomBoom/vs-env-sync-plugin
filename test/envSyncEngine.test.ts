import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { compilePathRegexes } from "../src/core/pathRegex";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

class InMemoryLogger implements Logger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(`info:${message}`);
  }

  warn(message: string): void {
    this.messages.push(`warn:${message}`);
  }

  error(message: string): void {
    this.messages.push(`error:${message}`);
  }
}

class StaticPrompts implements SyncPrompts {
  constructor(
    private readonly localOnlyDecision: "upload" | "skip" = "upload",
    private readonly conflictDecision: "pull" | "upload" | "skip" = "pull"
  ) {}

  async chooseLocalOnly(): Promise<"upload" | "skip"> {
    return this.localOnlyDecision;
  }

  async chooseConflict(): Promise<"pull" | "upload" | "skip"> {
    return this.conflictDecision;
  }
}

function createContext(workspacePath: string): WorkspaceSyncContext {
  return {
    workspacePath,
    workspaceName: "app",
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

describe("EnvSyncEngine", () => {
  it("pulls missing remote files on workspace open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-open-"));
    const workspacePath = path.join(root, "workspace");
    const storagePath = path.join(root, "storage");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(remoteStorePath, ".env.local"), "REMOTE=1\n");

    const logger = new InMemoryLogger();
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        return false;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), logger);
    const result = await engine.syncOnWorkspaceOpen(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      createContext(workspacePath)
    );

    assert.deepEqual(result, {
      uploadedPaths: [],
      pulledPaths: [".env.local"],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(workspacePath, ".env.local"), "utf8"), "REMOTE=1\n");
  });

  it("uploads local files on workspace open when remote is missing and prompt allows upload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-upload-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env.local"), "LOCAL=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts("upload"), new InMemoryLogger());
    const result = await engine.syncOnWorkspaceOpen(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      createContext(workspacePath)
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      uploadedPaths: [".env.local"],
      pulledPaths: [],
      skippedPaths: []
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env.local"), "utf8"), "LOCAL=1\n");
  });

  it("pushes updates and deletions on local change sync", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-push-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app");

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, ".env"), "LOCAL=2\n");
    await fs.writeFile(path.join(remoteStorePath, ".env"), "REMOTE=1\n");
    await fs.writeFile(path.join(remoteStorePath, ".env.old"), "OLD=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), new InMemoryLogger());
    const result = await engine.syncLocalChanges(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      createContext(workspacePath)
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      pushedPaths: [".env"],
      deletedPaths: [".env.old"],
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, ".env"), "utf8"), "LOCAL=2\n");
    await assert.rejects(fs.access(path.join(remoteStorePath, ".env.old")));
  });

  it("matches files when any configured regex applies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-multi-"));
    const workspacePath = path.join(root, "workspace");
    const remoteGitRoot = path.join(root, "remote");
    const remoteStorePath = path.join(remoteGitRoot, "projects", "github.com", "team", "app");

    await fs.mkdir(path.join(workspacePath, "config"), { recursive: true });
    await fs.mkdir(remoteStorePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "config", ".env.dev"), "CONFIG=1\n");

    let committed = false;
    const configRepoManager = {
      async verifyRemote(): Promise<void> {},
      async ensureReady() {
        return {
          repoPath: remoteGitRoot,
          branch: "main"
        };
      },
      async refresh(): Promise<void> {},
      async commitProjectChanges(): Promise<boolean> {
        committed = true;
        return true;
      }
    } as unknown as ConfigRepoManager;

    const engine = new EnvSyncEngine(configRepoManager, new StaticPrompts(), new InMemoryLogger());
    const result = await engine.syncLocalChanges(
      {
        repoUrl: "git@github.com:team/env-config.git",
        branch: "main"
      },
      {
        ...createContext(workspacePath),
        pathRegexSources: ["^\\.env[^/]*$", "^config/\\.env[^/]*$"],
        pathRegexes: compilePathRegexes(["^\\.env[^/]*$", "^config/\\.env[^/]*$"])
      }
    );

    assert.equal(committed, true);
    assert.deepEqual(result, {
      pushedPaths: ["config/.env.dev"],
      deletedPaths: [],
      committed: true
    });
    assert.equal(await fs.readFile(path.join(remoteStorePath, "config", ".env.dev"), "utf8"), "CONFIG=1\n");
  });
});
