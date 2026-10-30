import path from "node:path";

import { ConfigRepoManager, ReadyConfigRepo } from "./configRepoManager";
import { pathExists, readMatchingFiles, removeFileIfExists, writeFileEnsuringDir, pruneEmptyDirectories } from "./fileStore";
import {
  ConfigRepoSettings,
  Logger,
  OpenSyncResult,
  PushSyncResult,
  SyncPrompts,
  WorkspaceSyncContext
} from "./types";

function bufferEquals(left: Buffer, right: Buffer): boolean {
  return left.equals(right);
}

function projectStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(repoPath, "projects", context.project.host, context.project.owner, context.project.repo);
}

function branchStorePath(repoPath: string, context: WorkspaceSyncContext): string {
  return path.join(projectStorePath(repoPath, context), "branches", encodeURIComponent(context.branch));
}

async function prepareBranchStore(
  repo: ReadyConfigRepo,
  context: WorkspaceSyncContext
): Promise<{ remoteRoot: string; inherited: boolean }> {
  const remoteRoot = branchStorePath(repo.repoPath, context);
  if (await pathExists(remoteRoot)) {
    return { remoteRoot, inherited: false };
  }

  const legacyRoot = projectStorePath(repo.repoPath, context);
  const legacyFiles = await readMatchingFiles(legacyRoot, context.pathRegexes, [
    ...context.ignoredProjectRoots,
    "branches"
  ]);
  for (const [relativePath, content] of legacyFiles) {
    await writeFileEnsuringDir(path.join(remoteRoot, relativePath), content);
  }

  return { remoteRoot, inherited: legacyFiles.size > 0 };
}

function commitMessage(context: WorkspaceSyncContext): string {
  return `chore: sync env for ${context.project.slug}`;
}

export class EnvSyncEngine {
  constructor(
    private readonly configRepoManager: ConfigRepoManager,
    private readonly prompts: SyncPrompts,
    private readonly logger: Logger
  ) {}

  async verifyConfigRepo(settings: ConfigRepoSettings): Promise<void> {
    await this.configRepoManager.verifyRemote(settings);
  }

  async syncOnWorkspaceOpen(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<OpenSyncResult> {
    const repo = await this.configRepoManager.ensureReady(settings);
    await this.configRepoManager.refresh(repo);
    return this.runOpenSync(repo, context);
  }

  async syncLocalChanges(settings: ConfigRepoSettings, context: WorkspaceSyncContext): Promise<PushSyncResult> {
    const repo = await this.configRepoManager.ensureReady(settings);
    await this.configRepoManager.refresh(repo);
    return this.runPushSync(repo, context);
  }

  private async runOpenSync(repo: ReadyConfigRepo, context: WorkspaceSyncContext): Promise<OpenSyncResult> {
    const { remoteRoot, inherited } = await prepareBranchStore(repo, context);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes, context.ignoredProjectRoots);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes, context.ignoredProjectRoots);
    const allPaths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);

    const result: OpenSyncResult = {
      uploadedPaths: [],
      pulledPaths: [],
      skippedPaths: []
    };

    for (const relativePath of [...allPaths].sort()) {
      const localContent = localFiles.get(relativePath);
      const remoteContent = remoteFiles.get(relativePath);
      const localTargetPath = path.join(context.workspacePath, relativePath);
      const remoteTargetPath = path.join(remoteRoot, relativePath);

      if (!localContent && remoteContent) {
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        continue;
      }

      if (localContent && !remoteContent) {
        const decision = await this.prompts.chooseLocalOnly(context, relativePath);
        if (decision === "upload") {
          await writeFileEnsuringDir(remoteTargetPath, localContent);
          result.uploadedPaths.push(relativePath);
        } else {
          result.skippedPaths.push(relativePath);
        }
        continue;
      }

      if (!localContent || !remoteContent) {
        continue;
      }

      if (bufferEquals(localContent, remoteContent)) {
        continue;
      }

      const decision = await this.prompts.chooseConflict(context, relativePath);
      if (decision === "pull") {
        await writeFileEnsuringDir(localTargetPath, remoteContent);
        result.pulledPaths.push(relativePath);
        continue;
      }

      if (decision === "upload") {
        await writeFileEnsuringDir(remoteTargetPath, localContent);
        result.uploadedPaths.push(relativePath);
        continue;
      }

      result.skippedPaths.push(relativePath);
    }

    if (inherited || result.uploadedPaths.length > 0) {
      const committed = await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context));
      if (inherited) {
        this.logger.info(`已为 ${context.project.slug} 的分支 ${context.branch} 继承旧共享 env 数据；已提交：${committed ? "是" : "否"}。`);
      }
      if (result.uploadedPaths.length > 0) {
        this.logger.info(`打开工作区同步已上传 ${result.uploadedPaths.length} 个文件；已提交：${committed ? "是" : "否"}。`);
      }
    }

    return result;
  }

  private async runPushSync(repo: ReadyConfigRepo, context: WorkspaceSyncContext): Promise<PushSyncResult> {
    const { remoteRoot, inherited } = await prepareBranchStore(repo, context);
    const localFiles = await readMatchingFiles(context.workspacePath, context.pathRegexes, context.ignoredProjectRoots);
    const remoteFiles = await readMatchingFiles(remoteRoot, context.pathRegexes);
    const pushedPaths: string[] = [];
    const deletedPaths: string[] = [];

    for (const [relativePath, content] of localFiles) {
      const remoteTargetPath = path.join(remoteRoot, relativePath);
      const previousContent = remoteFiles.get(relativePath);
      if (!previousContent || !bufferEquals(previousContent, content)) {
        await writeFileEnsuringDir(remoteTargetPath, content);
        pushedPaths.push(relativePath);
      }
    }

    for (const relativePath of remoteFiles.keys()) {
      if (localFiles.has(relativePath)) {
        continue;
      }

      const remoteTargetPath = path.join(remoteRoot, relativePath);
      await removeFileIfExists(remoteTargetPath);
      await pruneEmptyDirectories(remoteRoot, remoteTargetPath);
      deletedPaths.push(relativePath);
    }

    const committed = inherited || pushedPaths.length > 0 || deletedPaths.length > 0
      ? await this.configRepoManager.commitProjectChanges(repo, remoteRoot, commitMessage(context))
      : false;
    if (inherited) {
      this.logger.info(`已为 ${context.project.slug} 的分支 ${context.branch} 继承旧共享 env 数据；已提交：${committed ? "是" : "否"}。`);
    }

    return {
      pushedPaths,
      deletedPaths,
      committed
    };
  }
}
