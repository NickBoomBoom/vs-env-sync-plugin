import { createHash } from "node:crypto";
import path from "node:path";

import { ConfigRepoManager, ReadyConfigRepo } from "./configRepoManager";
import { pathExists, readMatchingFiles, removeFileIfExists, writeFileEnsuringDir, pruneEmptyDirectories } from "./fileStore";
import { assertPathInside, branchMetadataPath, branchStorePath } from "./storagePaths";
import { SyncStateStore } from "./syncStateStore";
import { decideThreeWay, ThreeWayTrigger } from "./threeWaySync";
import {
  ConfigRepoSettings,
  LocalWriteObserver,
  Logger,
  OpenSyncResult,
  PushSyncResult,
  SyncPrompts,
  WorkspaceSyncContext
} from "./types";

interface InternalSyncResult extends PushSyncResult {
  uploadedPaths: string[];
}

function legacyProjectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  const target = path.join(repoPath, "projects", context.project.host, context.project.owner, context.project.repo);
  assertPathInside(repoPath, target);
  return target;
}

function legacyBranchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(legacyProjectStorePath(repoPath, context), "branches", encodeURIComponent(context.branch));
}

async function prepareBranchStore(
  repo: ReadyConfigRepo,
  context: WorkspaceSyncContext
): Promise<{ remoteRoot: string; inherited: boolean }> {
  const remoteRoot = branchStorePath(repo.repoPath, context);
  const metadataPath = branchMetadataPath(repo.repoPath, context);
  if (await pathExists(metadataPath)) {
    return { remoteRoot, inherited: false };
  }

  const legacyRoot = legacyProjectStorePath(repo.repoPath, context);
  const sources = [
    { root: legacyBranchStorePath(repo.repoPath, context), ignoredRoots: context.ignoredProjectRoots },
    { root: legacyRoot, ignoredRoots: [...context.ignoredProjectRoots, "branches"] }
  ];
  for (const source of sources) {
    const legacyFiles = await readMatchingFiles(source.root, context.pathRegexes, source.ignoredRoots, context.ignoredDirectoryNames);
    for (const [relativePath, content] of legacyFiles) {
      const targetPath = path.join(remoteRoot, relativePath);
      assertPathInside(remoteRoot, targetPath);
      if (!(await pathExists(targetPath))) {
        await writeFileEnsuringDir(targetPath, content);
      }
    }
  }

  await writeFileEnsuringDir(metadataPath, Buffer.from("{\"version\":1}\n"));
  return { remoteRoot, inherited: true };
}

function commitMessage(context: WorkspaceSyncContext): string {
  return `chore: sync env for ${context.project.slug}`;
}

function contentHash(content: Buffer | undefined): string | undefined {
  return content ? createHash("sha256").update(content).digest("hex") : undefined;
}

function updateBaseline(baseline: Map<string, string>, relativePath: string, hash: string | undefined): void {
  if (hash) {
    baseline.set(relativePath, hash);
  } else {
    baseline.delete(relativePath);
  }
}

export class EnvSyncEngine {
  constructor(
    private readonly configRepoManager: ConfigRepoManager,
    private readonly prompts: SyncPrompts,
    private readonly logger: Logger,
    private readonly stateStore?: SyncStateStore
  ) {}

  async verifyConfigRepo(settings: ConfigRepoSettings): Promise<void> {
    await this.configRepoManager.verifyRemote(settings);
  }

  async syncOnWorkspaceOpen(
    settings: ConfigRepoSettings,
    context: WorkspaceSyncContext,
    observer?: LocalWriteObserver
  ): Promise<OpenSyncResult> {
    return this.configRepoManager.runExclusive(settings, async () => {
      const repo = await this.configRepoManager.ensureReady(settings);
      await this.configRepoManager.refresh(repo);
      const result = await this.runSync(repo, settings, context, "open", observer);
      return {
        uploadedPaths: result.uploadedPaths,
        pulledPaths: result.pulledPaths,
        skippedPaths: result.skippedPaths
      };
    });
  }

  async syncLocalChanges(
    settings: ConfigRepoSettings,
    context: WorkspaceSyncContext,
    observer?: LocalWriteObserver
  ): Promise<PushSyncResult> {
    return this.configRepoManager.runExclusive(settings, async () => {
      const repo = await this.configRepoManager.ensureReady(settings);
      await this.configRepoManager.refresh(repo);
      const result = await this.runSync(repo, settings, context, "change", observer);
      return {
        pushedPaths: result.pushedPaths,
        deletedPaths: result.deletedPaths,
        pulledPaths: result.pulledPaths,
        deletedLocalPaths: result.deletedLocalPaths,
        skippedPaths: result.skippedPaths,
        committed: result.committed
      };
    });
  }

  private async runSync(
    repo: ReadyConfigRepo,
    settings: ConfigRepoSettings,
    context: WorkspaceSyncContext,
    trigger: ThreeWayTrigger,
    observer?: LocalWriteObserver
  ): Promise<InternalSyncResult> {
    const { remoteRoot, inherited } = await prepareBranchStore(repo, context);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes, context.ignoredProjectRoots, context.ignoredDirectoryNames);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes, context.ignoredProjectRoots, context.ignoredDirectoryNames);
    const baseline = this.stateStore ? await this.stateStore.read(settings, context) : new Map<string, string>();
    const nextBaseline = new Map(baseline);
    const allPaths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys(), ...baseline.keys()]);
    const result: InternalSyncResult = {
      uploadedPaths: [],
      pulledPaths: [],
      skippedPaths: [],
      pushedPaths: [],
      deletedPaths: [],
      deletedLocalPaths: [],
      committed: false
    };

    for (const relativePath of [...allPaths].sort()) {
      const localContent = localFiles.get(relativePath);
      const remoteContent = remoteFiles.get(relativePath);
      const localHash = contentHash(localContent);
      const remoteHash = contentHash(remoteContent);
      const hasBaseline = baseline.has(relativePath);
      const decision = decideThreeWay(
        baseline.get(relativePath),
        localHash,
        remoteHash,
        hasBaseline,
        trigger
      );
      const localTargetPath = path.join(context.workspacePath, relativePath);
      const remoteTargetPath = path.join(remoteRoot, relativePath);
      assertPathInside(context.workspacePath, localTargetPath);
      assertPathInside(remoteRoot, remoteTargetPath);

      if (decision === "none") {
        updateBaseline(nextBaseline, relativePath, localHash);
        continue;
      }

      if (decision === "pull" && remoteContent) {
        observer?.expectWrite(localTargetPath, remoteContent);
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, remoteHash);
        continue;
      }

      if (decision === "delete-local") {
        observer?.expectDelete(localTargetPath);
        await removeFileIfExists(localTargetPath);
        await pruneEmptyDirectories(context.workspacePath, localTargetPath);
        result.deletedLocalPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      if (decision === "push" && localContent) {
        await writeFileEnsuringDir(remoteTargetPath, localContent);
        if (trigger === "open") {
          result.uploadedPaths.push(relativePath);
        } else {
          result.pushedPaths.push(relativePath);
        }
        updateBaseline(nextBaseline, relativePath, localHash);
        continue;
      }

      if (decision === "delete-remote") {
        await removeFileIfExists(remoteTargetPath);
        await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
        result.deletedPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      const localOnly = !hasBaseline && localContent !== undefined && remoteContent === undefined;
      const choice = localOnly
        ? await this.prompts.chooseLocalOnly(context, relativePath)
        : await this.prompts.chooseConflict(context, relativePath);
      if (choice === "skip") {
        result.skippedPaths.push(relativePath);
        continue;
      }

      if (choice === "pull" && remoteContent) {
        observer?.expectWrite(localTargetPath, remoteContent);
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, remoteHash);
        continue;
      }

      if (choice === "pull" && !remoteContent) {
        observer?.expectDelete(localTargetPath);
        await removeFileIfExists(localTargetPath);
        await pruneEmptyDirectories(context.workspacePath, localTargetPath);
        result.deletedLocalPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      if (choice === "upload" && localContent) {
        await writeFileEnsuringDir(remoteTargetPath, localContent);
        if (trigger === "open") {
          result.uploadedPaths.push(relativePath);
        } else {
          result.pushedPaths.push(relativePath);
        }
        updateBaseline(nextBaseline, relativePath, localHash);
        continue;
      }

      if (choice === "upload" && !localContent) {
        await removeFileIfExists(remoteTargetPath);
        await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
        result.deletedPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
      }
    }

    const hasRemoteChanges = inherited || result.uploadedPaths.length > 0 || result.pushedPaths.length > 0 || result.deletedPaths.length > 0;
    result.committed = await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context));
    if (hasRemoteChanges && !result.committed) {
      throw new Error("配置仓库未能提交本轮 env 变更，同步状态未更新。");
    }
    if (inherited) {
      this.logger.info(`已初始化 ${context.project.slug} 的分支 ${context.branch} 存储；已提交：${result.committed ? "是" : "否"}。`);
    }
    if (trigger === "open" && result.uploadedPaths.length > 0) {
      this.logger.info(`打开工作区同步已上传 ${result.uploadedPaths.length} 个文件；已提交：${result.committed ? "是" : "否"}。`);
    }
    if (this.stateStore) {
      await this.stateStore.write(settings, context, nextBaseline);
    }
    return result;
  }
}
