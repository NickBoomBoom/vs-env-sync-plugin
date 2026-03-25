import fs from "node:fs/promises";
import path from "node:path";

import { GitCli } from "./git";
import { ConfigRepoSettings, Logger } from "./types";
import { hashRemoteUrl } from "./git";

export interface ReadyConfigRepo {
  repoPath: string;
  branch: string;
}

export class ConfigRepoManager {
  constructor(
    private readonly baseStoragePath: string,
    private readonly git: GitCli,
    private readonly logger: Logger
  ) {}

  async verifyRemote(settings: ConfigRepoSettings): Promise<void> {
    await this.git.verifyRemoteAccessible(settings.repoUrl);
  }

  async ensureReady(settings: ConfigRepoSettings): Promise<ReadyConfigRepo> {
    const repoPath = path.join(this.baseStoragePath, "config-repos", hashRemoteUrl(settings.repoUrl));
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    await this.git.ensureRepoClone(settings.repoUrl, repoPath);
    await this.checkoutBranch(repoPath, settings.branch);
    return { repoPath, branch: settings.branch };
  }

  async refresh(repo: ReadyConfigRepo): Promise<void> {
    await this.checkoutBranch(repo.repoPath, repo.branch);
    await this.git.run(["fetch", "--prune", "origin"], { cwd: repo.repoPath });

    if (await this.hasRemoteBranch(repo.repoPath, repo.branch)) {
      await this.git.run(["pull", "--rebase", "origin", repo.branch], { cwd: repo.repoPath });
      return;
    }

    this.logger.info(`Remote branch ${repo.branch} does not exist yet. Skipping pull.`);
  }

  async commitProjectChanges(repo: ReadyConfigRepo, projectStorePath: string, message: string): Promise<boolean> {
    const relativeProjectPath = path.relative(repo.repoPath, projectStorePath) || ".";
    await this.git.run(["add", "-A", "--", relativeProjectPath], { cwd: repo.repoPath });

    const hasChanges = await this.git.tryRun(["diff", "--cached", "--quiet", "--", relativeProjectPath], {
      cwd: repo.repoPath
    });
    if (hasChanges === undefined) {
      await this.git.run(["commit", "-m", message], { cwd: repo.repoPath });
      await this.push(repo);
      return true;
    }

    return false;
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
    const localBranchExists = await this.hasLocalBranch(repoPath, branch);
    const remoteBranchExists = await this.hasRemoteBranch(repoPath, branch);

    if (remoteBranchExists) {
      await this.git.run(["checkout", "-B", branch, `origin/${branch}`], { cwd: repoPath });
      return;
    }

    if (localBranchExists) {
      await this.git.run(["checkout", branch], { cwd: repoPath });
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
