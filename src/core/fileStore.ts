import fs from "node:fs/promises";
import path from "node:path";

import { matchesWorkspaceRelativePath, normalizeRelativePath } from "./pathRegex";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  rootPath: string,
  excludedDirectories: ReadonlySet<string>,
  currentRelativePath = ""
): Promise<string[]> {
  const currentPath = currentRelativePath ? path.join(rootPath, currentRelativePath) : rootPath;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    const nextRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (excludedDirectories.has(normalizeRelativePath(nextRelativePath))) {
        continue;
      }

      results.push(...(await walkFiles(rootPath, excludedDirectories, nextRelativePath)));
      continue;
    }

    if (entry.isFile()) {
      results.push(normalizeRelativePath(nextRelativePath));
    }
  }

  return results;
}

export async function readMatchingFiles(
  rootPath: string,
  pathRegexes: readonly RegExp[],
  ignoredProjectRoots: readonly string[] = []
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!(await pathExists(rootPath))) {
    return files;
  }

  const excludedDirectories = new Set(
    ignoredProjectRoots
      .map((relativePath) => normalizeRelativePath(relativePath))
      .filter((relativePath) => relativePath.length > 0)
  );
  const relativePaths = await walkFiles(rootPath, excludedDirectories);
  for (const relativePath of relativePaths) {
    if (!matchesWorkspaceRelativePath(pathRegexes, relativePath)) {
      continue;
    }

    const absolutePath = path.join(rootPath, relativePath);
    files.set(relativePath, await fs.readFile(absolutePath));
  }

  return files;
}

export async function writeFileEnsuringDir(targetPath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

export async function removeFileIfExists(targetPath: string): Promise<void> {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function pruneEmptyDirectories(rootPath: string, startPath: string): Promise<void> {
  let currentPath = path.dirname(startPath);
  const normalizedRoot = path.resolve(rootPath);

  while (currentPath.startsWith(normalizedRoot) && currentPath !== normalizedRoot) {
    const entries = await fs.readdir(currentPath);
    if (entries.length > 0) {
      return;
    }

    await fs.rmdir(currentPath);
    currentPath = path.dirname(currentPath);
  }
}
