import { createHash } from "node:crypto";
import path from "node:path";

import { ConfigRepoManager, ReadyConfigRepo } from "./configRepoManager";
import { readMatchingFiles, removeFileIfExists, writeFileEnsuringDir, pruneEmptyDirectories } from "./fileStore";
import { assertPathInside, branchStorePath } from "./storagePaths";
import { assertSafePath, prepareReadableBranchStore } from "./storageMigration";
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
        skippedPaths: result.skippedPaths,
        ...(result.deletedPaths.length > 0 ? { deletedPaths: result.deletedPaths } : {}),
        ...(result.deletedLocalPaths.length > 0 ? { deletedLocalPaths: result.deletedLocalPaths } : {})
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
    const storePath = path.relative(repo.repoPath, branchStorePath(repo.repoPath, context)).split(path.sep).join("/");
    this.logger.info(`同步目标：${context.project.slug} [${context.branch}] → 配置仓库分支 ${repo.branch}；存储目录：${storePath}`);
    const { remoteRoot, inherited, baselineGeneration } = await prepareReadableBranchStore(repo, context, this.prompts, this.logger);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes, context.ignoredProjectRoots, context.ignoredDirectoryNames);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes, context.ignoredProjectRoots, context.ignoredDirectoryNames, true);
    this.logger.info(`匹配文件：本地 ${localFiles.size} 个，配置仓库 ${remoteFiles.size} 个；规则：${context.pathRegexSources.join("、")}`);
    if (localFiles.size === 0) {
      this.logger.warn(`本地没有匹配的 env 文件：${context.workspacePath}；请检查文件位置、匹配规则及排除目录。`);
    }
    const baseline = this.stateStore ? await this.stateStore.read(settings, context, baselineGeneration) : new Map<string, string>();
    const contextChanged = this.stateStore ? await this.stateStore.hasContextChanged(settings, context, baselineGeneration) : false;
    const decisionTrigger = contextChanged ? "open" : trigger;
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
      const hasBaseline = !contextChanged && baseline.has(relativePath);
      const decision = decideThreeWay(
        baseline.get(relativePath),
        localHash,
        remoteHash,
        hasBaseline,
        decisionTrigger
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
        await assertSafePath(context.workspacePath, localTargetPath);
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, remoteHash);
        continue;
      }

      if (decision === "delete-local") {
        observer?.expectDelete(localTargetPath);
        await assertSafePath(context.workspacePath, localTargetPath);
        await removeFileIfExists(localTargetPath);
        await pruneEmptyDirectories(context.workspacePath, localTargetPath);
        result.deletedLocalPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      if (decision === "push" && localContent) {
        await assertSafePath(repo.repoPath, remoteTargetPath);
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
        await assertSafePath(repo.repoPath, remoteTargetPath);
        await removeFileIfExists(remoteTargetPath);
        await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
        result.deletedPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      const localOnly = !hasBaseline && localContent !== undefined && remoteContent === undefined;
      const choice = localOnly
        ? await this.prompts.chooseLocalOnly(context, relativePath)
        : await this.prompts.chooseConflict(context, relativePath, localContent !== undefined, remoteContent !== undefined);
      if (choice === "skip") {
        result.skippedPaths.push(relativePath);
        continue;
      }

      if (choice === "pull" && remoteContent) {
        observer?.expectWrite(localTargetPath, remoteContent);
        await assertSafePath(context.workspacePath, localTargetPath);
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, remoteHash);
        continue;
      }

      if (choice === "pull" && !remoteContent) {
        observer?.expectDelete(localTargetPath);
        await assertSafePath(context.workspacePath, localTargetPath);
        await removeFileIfExists(localTargetPath);
        await pruneEmptyDirectories(context.workspacePath, localTargetPath);
        result.deletedLocalPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
        continue;
      }

      if (choice === "upload" && localContent) {
        await assertSafePath(repo.repoPath, remoteTargetPath);
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
        await assertSafePath(repo.repoPath, remoteTargetPath);
        await removeFileIfExists(remoteTargetPath);
        await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
        result.deletedPaths.push(relativePath);
        updateBaseline(nextBaseline, relativePath, undefined);
      }
    }

    const hasRemoteChanges = inherited || result.uploadedPaths.length > 0 || result.pushedPaths.length > 0 || result.deletedPaths.length > 0;
    result.committed = await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context));
    if (hasRemoteChanges && !result.committed) {
      this.logger.info("配置仓库经 Git 暂存后无新增差异，无需新提交；本轮同步按成功更新状态。");
    }
    if (inherited) {
      this.logger.info(`已初始化 ${context.project.slug} 的分支 ${context.branch} 存储；已提交：${result.committed ? "是" : "否"}。`);
    }
    if (trigger === "open" && result.uploadedPaths.length > 0) {
      this.logger.info(`打开工作区同步已上传 ${result.uploadedPaths.length} 个文件；已提交：${result.committed ? "是" : "否"}。`);
    }
    if (this.stateStore) {
      await this.stateStore.write(settings, context, nextBaseline, !(contextChanged && result.skippedPaths.length > 0), baselineGeneration);
    }
    if (result.skippedPaths.length > 0) {
      const visiblePaths = result.skippedPaths.slice(0, 10).join("、");
      this.logger.warn(`本轮跳过 ${result.skippedPaths.length} 个文件，尚未同步这些文件：${visiblePaths}${result.skippedPaths.length > 10 ? " 等" : ""}`);
    }
    const noChanges = !result.committed && !hasRemoteChanges && result.pulledPaths.length === 0 && result.deletedLocalPaths.length === 0 && result.skippedPaths.length === 0;
    this.logger.info(
      `同步检查完成：${context.project.slug} [${context.branch}]；` +
      `更新配置仓库 ${result.uploadedPaths.length + result.pushedPaths.length} 个、删除配置仓库 ${result.deletedPaths.length} 个、` +
      `拉取 ${result.pulledPaths.length} 个、删除本地 ${result.deletedLocalPaths.length} 个、跳过 ${result.skippedPaths.length} 个；` +
      `新提交：${result.committed ? "是" : "否"}${noChanges ? (localFiles.size + remoteFiles.size > 0 ? "；无需变更，匹配文件已一致。" : "；没有匹配文件可同步。") : "。"}`
    );
    return result;
  }
}
