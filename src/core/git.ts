import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly stdout: string,
    readonly exitCode?: number,
    readonly systemCode?: string,
    readonly causeMessage?: string
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd?: string;
}

export class GitCli {
  async run(args: string[], options: GitRunOptions = {}): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0"
        }
      });
      return stdout.trim();
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      throw new GitCommandError(
        `git ${args.join(" ")} failed`,
        failed.stderr ?? "",
        failed.stdout ?? "",
        typeof failed.code === "number" ? failed.code : undefined,
        typeof failed.code === "string" ? failed.code : undefined,
        failed.message ?? ""
      );
    }
  }

  async tryRun(args: string[], options: GitRunOptions = {}): Promise<string | undefined> {
    try {
      return await this.run(args, options);
    } catch {
      return undefined;
    }
  }

  async ensureRepoClone(repoUrl: string, targetPath: string): Promise<void> {
    const gitDir = path.join(targetPath, ".git");
    try {
      await fs.access(gitDir);
      return;
    } catch {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await this.run(["clone", repoUrl, targetPath]);
    }
  }

  async verifyRemoteAccessible(repoUrl: string): Promise<void> {
    await this.run(["ls-remote", repoUrl]);
  }
}

export function hashRemoteUrl(remoteUrl: string): string {
  return createHash("sha1").update(remoteUrl).digest("hex");
}
