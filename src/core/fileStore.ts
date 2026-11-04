import fs from "node:fs/promises";
import path from "node:path";

import { matchesWorkspaceRelativePath, normalizeRelativePath } from "./pathRegex";
import { BRANCH_METADATA_FILE } from "./storagePaths";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function* walkFiles(
  rootPath: string,
  excludedProjectRoots: ReadonlySet<string>,
  ignoredDirectoryNames: ReadonlySet<string>,
  currentRelativePath = ""
): AsyncGenerator<string> {
  const currentPath = currentRelativePath ? path.join(rootPath, currentRelativePath) : rootPath;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === BRANCH_METADATA_FILE) {
      continue;
    }

    const nextRelativePath = currentRelativePath ? path.posix.join(currentRelativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name) || excludedProjectRoots.has(normalizeRelativePath(nextRelativePath))) {
        continue;
      }
      yield* walkFiles(rootPath, excludedProjectRoots, ignoredDirectoryNames, nextRelativePath);
      continue;
    }

    if (entry.isFile()) {
      yield normalizeRelativePath(nextRelativePath);
    }
  }
}

export async function readMatchingFiles(
  rootPath: string,
  pathRegexes: readonly RegExp[],
  ignoredProjectRoots: readonly string[] = [],
  ignoredDirectoryNames: readonly string[] = []
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!(await pathExists(rootPath))) {
    return files;
  }

  const excludedProjectRoots = new Set(
    ignoredProjectRoots
      .map((relativePath) => normalizeRelativePath(relativePath))
      .filter((relativePath) => relativePath.length > 0)
  );
  const ignoredDirectoryNameSet = new Set(ignoredDirectoryNames);
  for await (const relativePath of walkFiles(rootPath, excludedProjectRoots, ignoredDirectoryNameSet)) {
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
