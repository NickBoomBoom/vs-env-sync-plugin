import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ReadyConfigRepo } from "./configRepoManager";
import { readMatchingFiles, removeFileIfExists, writeFileEnsuringDir, pruneEmptyDirectories } from "./fileStore";
import {
  assertPathInside, BRANCH_METADATA_FILE, BranchStorageMetadata, branchStorePath, createBranchMetadata,
  hashedBranchStorePath, legacyBranchStorePath, legacyProjectStorePath, MIGRATION_JOURNAL_FILE, STORAGE_ARCHIVE_DIRECTORY
} from "./storagePaths";
import { Logger, SyncPrompts, WorkspaceSyncContext } from "./types";

type SourceKind = "hashed" | "legacy-branch" | "legacy-shared";
interface Source { root: string; kind: SourceKind; files: Map<string, Buffer>; complete: boolean; identified?: boolean }
interface Journal {
  version: 1;
  metadata: BranchStorageMetadata;
  source: string;
  sourceKind: SourceKind;
  fingerprint: string;
  selection: "source" | "target";
  archive?: string;
  archiveFingerprint?: string;
  archiveComplete?: boolean;
}

async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Refuse redirected ancestors, not just lexical '..' escapes. */
export async function assertSafePath(repoPath: string, target: string): Promise<void> {
  assertPathInside(repoPath, target);
  let current = path.resolve(repoPath);
  for (const segment of ["", ...path.relative(repoPath, target).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`存储路径包含符号链接或重定向，已停止迁移：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function validateIdentity(value: unknown, context: WorkspaceSyncContext): asserts value is BranchStorageMetadata {
  const marker = value as BranchStorageMetadata | undefined;
  const github = context.project.host.toLowerCase() === "github.com";
  const expected = github ? context.project.path.toLowerCase() : context.project.path;
  const actual = typeof marker?.project?.path === "string"
    ? (github ? marker.project.path.toLowerCase() : marker.project.path) : undefined;
  if (marker?.version !== 2 || marker.layout !== "readable-v2" || marker.project?.host !== context.project.host ||
      actual !== expected || marker.branch !== context.branch ||
      (marker.baselineGeneration !== undefined && typeof marker.baselineGeneration !== "string")) {
    throw new Error(`存储标记身份或版本不匹配，已停止以防覆盖其他项目/分支：${context.project.slug} [${context.branch}]`);
  }
}

async function readJson(target: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readFile(target, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`无法读取存储迁移标记 ${target}：${(error as Error).message}`);
  }
}

async function readMarker(root: string, context: WorkspaceSyncContext): Promise<BranchStorageMetadata | { version: 1 } | undefined> {
  const value = await readJson(path.join(root, BRANCH_METADATA_FILE));
  if (value === undefined) return undefined;
  if ((value as { version?: number })?.version === 1) return { version: 1 };
  validateIdentity(value, context);
  return value;
}

function fingerprint(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const content = files.get(name)!;
    hash.update(JSON.stringify([name, content.length])).update(content);
  }
  return hash.digest("hex");
}

async function sourceFiles(root: string, kind: SourceKind, context: WorkspaceSyncContext): Promise<Map<string, Buffer>> {
  // Complete branch snapshots are copied in full, even when today's regex is narrower.
  return kind === "legacy-shared"
    ? readMatchingFiles(root, context.pathRegexes, [...context.ignoredProjectRoots, "branches"], context.ignoredDirectoryNames, true)
    : readMatchingFiles(root, [/.+/], [], [], true);
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFileEnsuringDir(temporary, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    await fs.rename(temporary, target);
  } catch (error) {
    await removeFileIfExists(temporary);
    throw error;
  }
}

function relative(repoPath: string, target: string): string {
  return path.relative(repoPath, target).split(path.sep).join("/");
}

export async function prepareReadableBranchStore(
  repo: ReadyConfigRepo,
  context: WorkspaceSyncContext,
  prompts: SyncPrompts,
  logger: Logger
): Promise<{ remoteRoot: string; inherited: boolean; baselineGeneration?: string }> {
  const remoteRoot = branchStorePath(repo.repoPath, context);
  const markerPath = path.join(remoteRoot, BRANCH_METADATA_FILE);
  const journalPath = path.join(remoteRoot, MIGRATION_JOURNAL_FILE);
  await assertSafePath(repo.repoPath, markerPath);
  await assertSafePath(repo.repoPath, journalPath);
  const marker = await readMarker(remoteRoot, context);
  let journalValue = await readJson(journalPath);
  if (marker?.version === 2) {
    if (journalValue !== undefined) {
      validateIdentity((journalValue as Journal).metadata, context);
      await removeFileIfExists(journalPath);
    }
    // Old writers can still update their old directory. Warn, never silently re-import it.
    if (marker.migration?.source && marker.migration.fingerprint && marker.migration.sourceKind) {
      const oldRoot = path.resolve(repo.repoPath, marker.migration.source);
      await assertSafePath(repo.repoPath, oldRoot);
      if (await exists(oldRoot)) {
        const oldFiles = await sourceFiles(oldRoot, marker.migration.sourceKind, context);
        if (fingerprint(oldFiles) !== marker.migration.fingerprint) {
          logger.warn(`旧存储目录已发生变化，未自动合并：${marker.migration.source}。请升级同一配置仓库的其他客户端后手动确认差异。`);
        }
      }
    }
    return { remoteRoot, inherited: false, baselineGeneration: marker.baselineGeneration };
  }

  const targetFiles = await readMatchingFiles(remoteRoot, [/.+/], [], [], true);
  let source: Source | undefined;
  let journal: Journal | undefined;
  if (journalValue !== undefined) {
    journal = journalValue as Journal;
    validateIdentity(journal.metadata, context);
    if (journal.version !== 1 || !["hashed", "legacy-branch", "legacy-shared"].includes(journal.sourceKind) ||
        !["source", "target"].includes(journal.selection) || typeof journal.source !== "string") {
      throw new Error(`迁移日志无效，已停止：${journalPath}`);
    }
    const root = path.resolve(repo.repoPath, journal.source);
    const expectedSource = journal.sourceKind === "hashed" ? hashedBranchStorePath(repo.repoPath, context)
      : journal.sourceKind === "legacy-branch" ? legacyBranchStorePath(repo.repoPath, context) : legacyProjectStorePath(repo.repoPath, context);
    if (path.relative(expectedSource, root) !== "") throw new Error(`迁移日志来源不属于当前项目/分支，已停止：${journalPath}`);
    await assertSafePath(repo.repoPath, root);
    if (!(await exists(root))) throw new Error(`迁移来源已消失，请检查后重试：${root}`);
    const files = await sourceFiles(root, journal.sourceKind, context);
    if (fingerprint(files) !== journal.fingerprint) throw new Error(`迁移来源在中断后已改变，请先核对，未自动合并：${root}`);
    source = { root, kind: journal.sourceKind, files, complete: true };
  } else {
    const hashedRoot = hashedBranchStorePath(repo.repoPath, context);
    const legacyBranch = legacyBranchStorePath(repo.repoPath, context);
    const legacyShared = legacyProjectStorePath(repo.repoPath, context);
    const candidates: Array<{ root: string; kind: SourceKind }> = [
      { root: hashedRoot, kind: "hashed" },
      { root: legacyBranch, kind: "legacy-branch" }
    ];
    // Existing readable branch data is already a snapshot; never supplement it from shared legacy files.
    if (!marker && targetFiles.size === 0) candidates.push({ root: legacyShared, kind: "legacy-shared" });
    for (const candidate of candidates) {
      if (path.relative(remoteRoot, candidate.root) === "") continue;
      await assertSafePath(repo.repoPath, candidate.root);
      if (!(await exists(candidate.root))) continue;
      const files = await sourceFiles(candidate.root, candidate.kind, context);
      if (candidate.kind === "legacy-shared" && files.size === 0) continue;
      await assertSafePath(repo.repoPath, path.join(candidate.root, BRANCH_METADATA_FILE));
      const sourceMarker = candidate.kind === "legacy-shared" ? undefined : await readMarker(candidate.root, context);
      source = { ...candidate, files, complete: sourceMarker !== undefined, identified: sourceMarker?.version === 2 };
      break;
    }

    if (source) {
      const conflicts = [...targetFiles.keys()].filter(name => !source!.files.has(name) || !targetFiles.get(name)!.equals(source!.files.get(name)!));
      const ambiguous = source.kind !== "hashed" && (context.project.path.split("/").length !== 2 || context.branch !== context.branch.toLowerCase()) && !source.identified;
      let selection: "source" | "target" = "source";
      if (conflicts.length > 0 || ambiguous) {
        const decision = await prompts.chooseStorageMigration?.(context, {
          sourcePath: relative(repo.repoPath, source.root), targetPath: relative(repo.repoPath, remoteRoot),
          conflictingPaths: conflicts, reason: ambiguous ? "ambiguous-legacy" : "conflicting-snapshots"
        });
        if (decision !== "source" && decision !== "target") {
          throw new Error(`存储迁移尚未确认，未修改文件或更新基线：${context.project.slug} [${context.branch}]。来源：${relative(repo.repoPath, source.root)}`);
        }
        selection = decision;
      }
      // A confirmation can outlive manual Git/file edits outside the extension lock.
      await assertSafePath(repo.repoPath, source.root);
      await assertSafePath(repo.repoPath, markerPath);
      await assertSafePath(repo.repoPath, journalPath);
      if (!(await exists(source.root))) throw new Error("存储迁移来源在确认期间已消失，请重新检查。");
      const currentSource = await sourceFiles(source.root, source.kind, context);
      const currentTarget = await readMatchingFiles(remoteRoot, [/.+/], [], [], true);
      const currentMarker = await readMarker(remoteRoot, context);
      if (fingerprint(currentSource) !== fingerprint(source.files) || fingerprint(currentTarget) !== fingerprint(targetFiles) ||
          JSON.stringify(currentMarker) !== JSON.stringify(marker)) {
        throw new Error("存储迁移状态在确认期间已改变，请重新同步后再次确认；未执行迁移。");
      }
      const metadata = createBranchMetadata(context, {
        source: relative(repo.repoPath, source.root), sourceKind: source.kind,
        fingerprint: fingerprint(source.files), selection
      });
      // Only an equivalent complete hash snapshot can safely reuse the previous baseline.
      if (selection === "target" || source.kind !== "hashed" || !source.complete) metadata.baselineGeneration = randomUUID();
      const archive = conflicts.length > 0 && selection === "source"
        ? `${STORAGE_ARCHIVE_DIRECTORY}/${randomUUID()}` : undefined;
      if (archive) metadata.migration!.archive = archive;
      journal = {
        version: 1, metadata, source: relative(repo.repoPath, source.root), sourceKind: source.kind,
        fingerprint: fingerprint(source.files), selection, ...(archive ? { archive, archiveFingerprint: fingerprint(targetFiles) } : {})
      };
      await atomicJson(journalPath, journal);
    }
  }

  if (source && journal) {
    if (journal.archive && !journal.archiveComplete) {
      const archiveRoot = path.resolve(remoteRoot, journal.archive);
      assertPathInside(path.join(remoteRoot, STORAGE_ARCHIVE_DIRECTORY), archiveRoot);
      await assertSafePath(repo.repoPath, archiveRoot);
      for (const [name, content] of targetFiles) {
        const target = path.join(archiveRoot, name);
        await assertSafePath(repo.repoPath, target);
        await writeFileEnsuringDir(target, content);
      }
      if (marker) await writeFileEnsuringDir(path.join(archiveRoot, BRANCH_METADATA_FILE), await fs.readFile(markerPath));
      journal.archiveComplete = true;
      await atomicJson(journalPath, journal);
      logger.info(`可读旧快照已归档：${relative(repo.repoPath, archiveRoot)}（包含 env 敏感数据，与本分支一起提交）。`);
    }
    if (journal.archive) {
      const archiveRoot = path.resolve(remoteRoot, journal.archive);
      assertPathInside(path.join(remoteRoot, STORAGE_ARCHIVE_DIRECTORY), archiveRoot);
      await assertSafePath(repo.repoPath, archiveRoot);
      if (!journal.archiveComplete || !(await exists(archiveRoot)) ||
          fingerprint(await readMatchingFiles(archiveRoot, [/.+/], [], [], true)) !== journal.archiveFingerprint) {
        throw new Error("旧目标归档缺失或不完整，已停止迁移；请先恢复归档再重试。");
      }
    }
    if (journal.selection === "source") {
      // Remove archived target-only paths first: a file may block a source directory,
      // or a target directory may have to become a source file. The source is never changed.
      for (const name of targetFiles.keys()) {
        if (!source.files.has(name)) {
          if (!journal.archiveComplete) throw new Error("缺少完整归档，已拒绝移除旧快照文件。");
          const target = path.join(remoteRoot, name);
          await assertSafePath(repo.repoPath, target);
          await removeFileIfExists(target);
          await pruneEmptyDirectories(remoteRoot, target);
        }
      }
      for (const [name, content] of source.files) {
        const target = path.join(remoteRoot, name);
        await assertSafePath(repo.repoPath, target);
        await writeFileEnsuringDir(target, content);
      }
    }
    await atomicJson(markerPath, journal.metadata);
    await removeFileIfExists(journalPath);
    logger.info(`存储迁移完成：${journal.source} → ${relative(repo.repoPath, remoteRoot)}；旧来源保持不变。`);
    return { remoteRoot, inherited: true, baselineGeneration: journal.metadata.baselineGeneration };
  }

  const metadata = createBranchMetadata(context);
  metadata.baselineGeneration = randomUUID();
  await atomicJson(markerPath, metadata);
  return { remoteRoot, inherited: true, baselineGeneration: metadata.baselineGeneration };
}
