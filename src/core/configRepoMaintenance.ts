import fs from "node:fs/promises";
import path from "node:path";

import { ConfigRepoManager } from "./configRepoManager";
import { GitCli } from "./git";
import { ConfigRepoSettings, Logger } from "./types";

export interface ConfigRepoDiagnosis {
  repoPath: string;
  exists: boolean;
  configuredBranch: string;
  currentBranch?: string;
  rebase?: "rebase-merge" | "rebase-apply";
  status?: string;
  stashes?: string;
}

export type ConfigRepoRepairResult =
  | { outcome: "cancelled"; diagnosis: ConfigRepoDiagnosis }
  | { outcome: "not-needed"; diagnosis: ConfigRepoDiagnosis }
  | { outcome: "repaired"; diagnosis: ConfigRepoDiagnosis; backupPath: string };

/** Operates only on the extension-owned clone, under the same lock as automatic sync. */
export class ConfigRepoMaintenance {
  constructor(
    private readonly storagePath: string,
    private readonly manager: ConfigRepoManager,
    private readonly git: GitCli,
    private readonly logger: Logger
  ) {}

  diagnose(settings: ConfigRepoSettings): Promise<ConfigRepoDiagnosis> {
    return this.manager.runExclusive(settings, () => this.inspect(settings));
  }

  repair(
    settings: ConfigRepoSettings,
    confirm: (diagnosis: ConfigRepoDiagnosis) => Promise<boolean>
  ): Promise<ConfigRepoRepairResult> {
    return this.manager.runExclusive(settings, async () => {
      let diagnosis = await this.inspect(settings);
      if (!diagnosis.exists || !diagnosis.rebase) {
        return { outcome: "not-needed", diagnosis };
      }
      if (!(await confirm(diagnosis))) {
        return { outcome: "cancelled", diagnosis };
      }
      // The modal can stay open while a user operates Git outside this extension.
      // Revalidate paths and state before copying or aborting anything.
      diagnosis = await this.inspect(settings);
      if (!diagnosis.exists || !diagnosis.rebase) {
        return { outcome: "not-needed", diagnosis };
      }

      // Make a complete copy before invoking any mutating Git command. A failed copy
      // deliberately leaves the original untouched and keeps any partial backup.
      const backupsPath = path.join(this.storagePath, "repair-backups");
      await fs.mkdir(backupsPath, { recursive: true, mode: 0o700 });
      const backupRoot = await fs.mkdtemp(path.join(backupsPath, "rebase-"));
      const backupPath = path.join(backupRoot, "repository");
      this.logger.info(`正在备份配置仓库到 ${backupPath}（包含 env 密钥，请妥善保管）。`);
      try {
        await fs.cp(diagnosis.repoPath, backupPath, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true
        });
      } catch (error) {
        throw new Error(`配置仓库备份失败，尚未执行修复。可能的不完整备份：${backupRoot}。${(error as Error).message}`);
      }
      this.logger.info(`配置仓库完整备份已保存：${backupPath}`);
      try {
        await this.git.run(["rebase", "--abort"], { cwd: diagnosis.repoPath });
        if (await this.manager.getRebaseState(diagnosis.repoPath)) {
          throw new Error("Git 返回后仍检测到 rebase 状态。");
        }
      } catch (error) {
        throw new Error(`撤销 rebase 失败，备份已保留：${backupPath}。请查看配置仓库状态并手动处理。${(error as Error).message}`);
      }
      this.logger.info(`已撤销未完成的 rebase；未自动应用或删除 stash。备份：${backupPath}`);
      return { outcome: "repaired", diagnosis: await this.inspect(settings), backupPath };
    });
  }

  private async inspect(settings: ConfigRepoSettings): Promise<ConfigRepoDiagnosis> {
    const repoPath = this.manager.getRepoPath(settings);
    const diagnosis: ConfigRepoDiagnosis = { repoPath, configuredBranch: settings.branch, exists: false };
    let repoStat;
    try {
      repoStat = await fs.lstat(repoPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return diagnosis;
      throw error;
    }
    // A linked worktree or redirected cache cannot be safely backed up as one directory.
    const gitStat = await fs.lstat(path.join(repoPath, ".git"));
    if (!repoStat.isDirectory() || repoStat.isSymbolicLink() || !gitStat.isDirectory() || gitStat.isSymbolicLink()) {
      throw new Error(`配置缓存不是独立的普通 Git 克隆，已停止维护以保护数据：${repoPath}`);
    }
    const topLevel = await this.git.run(["rev-parse", "--show-toplevel"], { cwd: repoPath });
    const expected = await fs.realpath(repoPath);
    const actual = await fs.realpath(topLevel);
    if (path.relative(expected, actual) !== "") {
      throw new Error(`配置仓库工作树指向缓存目录之外，已停止维护：${repoPath}`);
    }
    diagnosis.exists = true;
    diagnosis.currentBranch = await this.git.run(["branch", "--show-current"], { cwd: repoPath });
    diagnosis.rebase = await this.manager.getRebaseState(repoPath);
    diagnosis.status = await this.git.run(["--no-optional-locks", "status", "--short", "--branch"], { cwd: repoPath });
    diagnosis.stashes = await this.git.run(["stash", "list"], { cwd: repoPath });
    return diagnosis;
  }
}
