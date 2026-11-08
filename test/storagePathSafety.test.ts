import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigRepoManager } from "../src/core/configRepoManager";
import { EnvSyncEngine } from "../src/core/envSyncEngine";
import { branchStorePath, BRANCH_METADATA_FILE, createBranchMetadata } from "../src/core/storagePaths";
import { SyncStateStore } from "../src/core/syncStateStore";
import { WorkspaceSyncContext } from "../src/core/types";

const logger = { info() {}, warn() {}, error() {} };
const prompts = { async chooseLocalOnly() { return "upload" as const; }, async chooseConflict() { return "upload" as const; } };

describe("active readable storage path safety", function () {
  this.timeout(15000);
  for (const scenario of ["remote-link", "remote-link-with-baseline", "local-link"] as const) {
    it(`refuses ${scenario} without touching external bytes or updating state`, async function () {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-active-link-"));
      try {
        const repoPath = path.join(root, "config");
        const workspacePath = path.join(root, "workspace");
        let external = path.join(root, "outside.env");
        await fs.mkdir(workspacePath);
        await fs.writeFile(external, "SAMPLE=outside\n");
        const context: WorkspaceSyncContext = {
          workspacePath, workspaceName: "app", branch: "v3",
          project: { host: "github.com", owner: "team", repo: "app", path: "team/app", slug: "github.com/team/app" },
          pathRegexSources: ["^\\.env[^/]*$", "^linked/\\.env$"],
          pathRegexes: [/^\.env[^/]*$/, /^linked\/\.env$/], ignoredProjectRoots: [], ignoredDirectoryNames: []
        };
        const remoteRoot = branchStorePath(repoPath, context);
        await fs.mkdir(remoteRoot, { recursive: true });
        await fs.writeFile(path.join(remoteRoot, BRANCH_METADATA_FILE), JSON.stringify(createBranchMetadata(context)));
        const linkBase = scenario === "local-link" ? workspacePath : remoteRoot;
        let relativeEnv = ".env";
        let symlinkRoot = path.join(linkBase, relativeEnv);
        try { await fs.symlink(external, symlinkRoot, "file"); }
        catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          // Windows often denies file symlinks but permits directory junctions. Exercise
          // the same ancestor-escape protection instead of silently skipping the test.
          const outsideDirectory = path.join(root, "outside-directory");
          await fs.mkdir(outsideDirectory);
          external = path.join(outsideDirectory, ".env");
          await fs.writeFile(external, "SAMPLE=outside\n");
          relativeEnv = path.join("linked", ".env");
          symlinkRoot = path.join(linkBase, "linked");
          try { await fs.symlink(outsideDirectory, symlinkRoot, "junction"); }
          catch (junctionError) {
            if (["EPERM", "EACCES", "ENOTSUP"].includes((junctionError as NodeJS.ErrnoException).code ?? "")) this.skip();
            throw junctionError;
          }
        }
        const ordinaryFile = path.join(scenario === "local-link" ? remoteRoot : workspacePath, relativeEnv);
        await fs.mkdir(path.dirname(ordinaryFile), { recursive: true });
        await fs.writeFile(ordinaryFile, scenario === "local-link" ? "SAMPLE=remote\n" : "SAMPLE=local\n");
        let commits = 0;
        const manager = {
          async runExclusive(_settings: unknown, task: () => Promise<unknown>) { return task(); },
          async ensureReady() { return { repoPath, branch: "main" }; },
          async refresh() {},
          async commitProjectChanges() { commits += 1; return true; }
        } as unknown as ConfigRepoManager;
        const state = new SyncStateStore(path.join(root, "state"));
        const settings = { repoUrl: "https://example.com/config.git", branch: "main" };
        const relativeName = relativeEnv.split(path.sep).join("/");
        const baseline = scenario === "remote-link-with-baseline"
          ? new Map([[relativeName, createHash("sha256").update("SAMPLE=local\n").digest("hex")]]) : new Map<string, string>();
        await state.write(settings, context, baseline);
        const engine = new EnvSyncEngine(manager, prompts, logger, state);
        await assert.rejects(engine.syncOnWorkspaceOpen(settings, context), /符号链接|重定向/);
        assert.equal(await fs.readFile(external, "utf8"), "SAMPLE=outside\n");
        assert.equal(commits, 0);
        assert.deepEqual(await state.read(settings, context), baseline);
        assert.ok((await fs.lstat(symlinkRoot)).isSymbolicLink());
        assert.equal(await fs.readFile(ordinaryFile, "utf8"), scenario === "local-link" ? "SAMPLE=remote\n" : "SAMPLE=local\n");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
