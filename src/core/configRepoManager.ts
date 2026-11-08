import fs from "node:fs/promises";
import path from "node:path";

import { FileLock } from "./fileLock";
import { GitCli, GitCommandError } from "./git";
import { ConfigRepoSettings, Logger } from "./types";
import { hashRemoteUrl } from "./git";

export interface ReadyConfigRepo {
  repoPath: string;
  branch: string;
}

export class ConfigRepoManager {
  private readonly fileLock: FileLock;

  constructor(
    private readonly baseStoragePath: string,
    private readonly git: GitCli,
    private readonly logger: Logger
  ) {
    this.fileLock = new FileLock(baseStoragePath);
  }

  async runExclusive<T>(settings: ConfigRepoSettings, task: () => Promise<T>): Promise<T> {
    return this.fileLock.runExclusive(hashRemoteUrl(settings.repoUrl), task);
  }

  getRepoPath(settings: ConfigRepoSettings): string {
    return path.join(this.baseStoragePath, "config-repos", hashRemoteUrl(settings.repoUrl));
  }

  async verifyRemote(settings: ConfigRepoSettings): Promise<void> {
    await this.git.verifyRemoteAccessible(settings.repoUrl);
  }

  async ensureReady(settings: ConfigRepoSettings): Promise<ReadyConfigRepo> {
    const repoPath = this.getRepoPath(settings);
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await this.git.ensureRepoClone(settings.repoUrl, repoPath);
    if (process.platform === "win32") {
      await this.git.run(["config", "core.longpaths", "true"], { cwd: repoPath });
    }
    await this.assertNoRebase(repoPath);
    await this.git.run(["fetch", "--prune", "origin"], { cwd: repoPath });
    await this.checkoutBranch(repoPath, settings.branch);
    return { repoPath, branch: settings.branch };
  }

  async refresh(repo: ReadyConfigRepo): Promise<void> {
    await this.assertNoRebase(repo.repoPath);
    await this.checkoutBranch(repo.repoPath, repo.branch);
    await this.updateFromRemote(repo);
    if (await this.hasUnpushedCommits(repo)) {
      await this.pushWithRecovery(repo);
    }
  }

  /** Returns whether a new commit was created; all staging/commit/push failures throw. */
  async commitProjectChanges(repo: ReadyConfigRepo, projectStorePath: string, message: string): Promise<boolean> {
    const relativeProjectPath = path.relative(repo.repoPath, projectStorePath) || ".";
    await this.git.run(["add", "-f", "-A", "--", relativeProjectPath], { cwd: repo.repoPath });

    try {
      await this.git.run(["diff", "--cached", "--quiet", "--", relativeProjectPath], { cwd: repo.repoPath });
      // Staging can normalize line endings/clean filters back to the existing tree.
      // false means success without a new commit, not a failed commit.
      return false;
    } catch (error) {
      // git diff --quiet: 1 means differences; other failures must remain visible.
      if (!(error instanceof GitCommandError) || error.exitCode !== 1) {
        throw error;
      }
    }

    await this.git.run(["commit", "-m", message, "--", relativeProjectPath], { cwd: repo.repoPath });
    await this.pushWithRecovery(repo);
    return true;
  }

  private async updateFromRemote(repo: ReadyConfigRepo): Promise<void> {
    await this.assertNoRebase(repo.repoPath);
    await this.git.run(["fetch", "--prune", "origin"], { cwd: repo.repoPath });
    if (await this.hasRemoteBranch(repo.repoPath, repo.branch)) {
      const trackedStash = await this.stashChanges(repo.repoPath, false);
      const untrackedStash = await this.stashChanges(repo.repoPath, true);
      try {
        await this.git.run(["rebase", `origin/${repo.branch}`], { cwd: repo.repoPath });
      } catch (error) {
        // Only abort a rebase started by this invocation; never discard an existing operation.
        if (await this.hasRebase(repo.repoPath)) {
          try {
            await this.git.run(["rebase", "--abort"], { cwd: repo.repoPath });
          } catch {
            this.logger.warn(`无法撤销本次 rebase，请先备份并检查配置仓库：${repo.repoPath}`);
          }
        }
        this.logger.warn(`拉取失败，本地提交及 stash 已保留。配置仓库：${repo.repoPath}；tracked stash: ${trackedStash ?? "无"}；untracked stash: ${untrackedStash ?? "无"}`);
        throw error;
      }
      if (untrackedStash) {
        await this.git.run(["restore", `--source=${untrackedStash}^3`, "--worktree", "--", "."], {
          cwd: repo.repoPath
        });
        await this.git.run(["stash", "drop", "stash@{0}"], { cwd: repo.repoPath });
      }
      if (trackedStash) {
        await this.git.run(["stash", "pop", "stash@{0}"], { cwd: repo.repoPath });
      }
      return;
    }
    this.logger.info(`远端分支 ${repo.branch} 暂不存在，已跳过拉取。`);
  }

  private async hasRebase(repoPath: string): Promise<boolean> {
    return (await this.getRebaseState(repoPath)) !== undefined;
  }

  async getRebaseState(repoPath: string): Promise<"rebase-merge" | "rebase-apply" | undefined> {
    for (const state of ["rebase-merge", "rebase-apply"] as const) {
      const statePath = await this.git.run(["rev-parse", "--git-path", state], { cwd: repoPath });
      try {
        await fs.stat(path.resolve(repoPath, statePath));
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return undefined;
  }

  private async assertNoRebase(repoPath: string): Promise<void> {
    if (await this.hasRebase(repoPath)) {
      throw new Error(
        `配置仓库存在未完成的 rebase，已停止同步并保留现场。配置仓库路径：${repoPath}。` +
        `可从命令面板运行“Env Sync：诊断配置仓库”或“Env Sync：修复未完成的 rebase”。` +
        `如需手动处理，请先备份该目录（包含 .git），再在该目录运行 git status 和 git stash list；` +
        `需要保留当前变基时手动解决冲突并 git rebase --continue，` +
        `确认放弃本次变基时运行 git rebase --abort。不要直接删除 .git/rebase-merge 或 .git/rebase-apply。`
      );
    }
  }

  private async stashChanges(repoPath: string, includeAll: boolean): Promise<string | undefined> {
    const previousStash = await this.git.tryRun(["rev-parse", "--verify", "refs/stash"], { cwd: repoPath });
    const args = ["stash", "push", "-m", includeAll ? "env-sync untracked before rebase" : "env-sync tracked before rebase"];
    if (includeAll) {
      args.push("--all");
    }
    await this.git.run(args, { cwd: repoPath });
    const currentStash = await this.git.tryRun(["rev-parse", "--verify", "refs/stash"], { cwd: repoPath });
    return currentStash && currentStash !== previousStash ? currentStash : undefined;
  }

  private async hasUnpushedCommits(repo: ReadyConfigRepo): Promise<boolean> {
    if (!(await this.hasHead(repo.repoPath))) {
      return false;
    }
    if (!(await this.hasRemoteBranch(repo.repoPath, repo.branch))) {
      return true;
    }
    const count = await this.git.run(["rev-list", "--count", `origin/${repo.branch}..HEAD`], {
      cwd: repo.repoPath
    });
    return Number(count) > 0;
  }

  private async pushWithRecovery(repo: ReadyConfigRepo): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.push(repo);
        return;
      } catch (error) {
        if (!this.isPushRejected(error) || attempt === 2) {
          throw error;
        }
        await this.updateFromRemote(repo);
      }
    }
  }

  private isPushRejected(error: unknown): boolean {
    if (!(error instanceof GitCommandError)) {
      return false;
    }
    const details = `${error.message}\n${error.stderr}\n${error.stdout}`.toLowerCase();
    return ["non-fast-forward", "failed to push some refs", "[rejected]", "fetch first"].some((part) => details.includes(part));
  }

  private async push(repo: ReadyConfigRepo): Promise<void> {
    const upstream = await this.git.tryRun(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repo.repoPath
    });
    if (upstream) {
      await this.git.run(["push"], { cwd: repo.repoPath });
      return;
    }

    await this.git.run(["push", "-u", "origin", repo.branch], { cwd: repo.repoPath });
  }

  private async checkoutBranch(repoPath: string, branch: string): Promise<void> {
    const currentBranch = await this.git.tryRun(["branch", "--show-current"], { cwd: repoPath });
    if (currentBranch === branch) {
      return;
    }

    const localBranchExists = await this.hasLocalBranch(repoPath, branch);
    const remoteBranchExists = await this.hasRemoteBranch(repoPath, branch);

    if (localBranchExists) {
      await this.git.run(["checkout", branch], { cwd: repoPath });
      return;
    }

    if (remoteBranchExists) {
      await this.git.run(["checkout", "-b", branch, "--track", `origin/${branch}`], { cwd: repoPath });
      return;
    }

    if (await this.hasHead(repoPath)) {
      await this.git.run(["checkout", "-b", branch], { cwd: repoPath });
      return;
    }

    await this.git.run(["checkout", "--orphan", branch], { cwd: repoPath });
  }

  private async hasHead(repoPath: string): Promise<boolean> {
    return (await this.git.tryRun(["rev-parse", "--verify", "HEAD"], { cwd: repoPath })) !== undefined;
  }

  private async hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
    return (await this.git.tryRun(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })) !== undefined;
  }

  private async hasRemoteBranch(repoPath: string, branch: string): Promise<boolean> {
    return (await this.git.tryRun(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: repoPath })) !== undefined;
  }
}
