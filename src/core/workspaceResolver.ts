import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";

import { GitCli } from "./git";
import { parseOriginUrl } from "./repoIdentity";
import { DEFAULT_GIT_PROJECT_IGNORE_DIRECTORIES, RepoIdentity } from "./types";

export interface DiscoveredWorkspaceProject {
  projectPath: string;
  project: RepoIdentity;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRealPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function resolveWorkspaceProject(workspacePath: string, git: GitCli): Promise<RepoIdentity | undefined> {
  const repoRoot = await git.tryRun(["rev-parse", "--show-toplevel"], { cwd: workspacePath });
  if (!repoRoot) {
    return undefined;
  }

  const [normalizedRepoRoot, normalizedWorkspacePath] = await Promise.all([
    resolveRealPath(repoRoot),
    resolveRealPath(workspacePath)
  ]);

  if (normalizedRepoRoot !== normalizedWorkspacePath) {
    return undefined;
  }

  const originUrl = await git.tryRun(["config", "--get", "remote.origin.url"], { cwd: workspacePath });
  if (!originUrl) {
    return undefined;
  }

  return parseOriginUrl(originUrl);
}

export async function discoverWorkspaceProjects(
  workspaceRootPath: string,
  git: GitCli,
  maxDepth: number,
  ignoredDirectoryNames: readonly string[] = DEFAULT_GIT_PROJECT_IGNORE_DIRECTORIES
): Promise<DiscoveredWorkspaceProject[]> {
  const discoveredProjects = new Map<string, RepoIdentity>();
  const ignoredDirectoryNameSet = new Set(
    ignoredDirectoryNames.map((directoryName) => directoryName.trim()).filter((directoryName) => directoryName.length > 0)
  );

  async function walk(currentPath: string, currentDepth: number): Promise<void> {
    if (await pathExists(path.join(currentPath, ".git"))) {
      const project = await resolveWorkspaceProject(currentPath, git);
      if (project) {
        discoveredProjects.set(await resolveRealPath(currentPath), project);
      }
    }

    if (currentDepth >= maxDepth) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || ignoredDirectoryNameSet.has(entry.name)) {
        continue;
      }

      await walk(path.join(currentPath, entry.name), currentDepth + 1);
    }
  }

  await walk(await resolveRealPath(workspaceRootPath), 0);

  return [...discoveredProjects.entries()]
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([projectPath, project]) => ({ projectPath, project }));
}
