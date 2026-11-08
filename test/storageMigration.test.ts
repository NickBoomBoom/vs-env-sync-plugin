import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ReadyConfigRepo } from "../src/core/configRepoManager";
import { readMatchingFiles } from "../src/core/fileStore";
import { prepareReadableBranchStore } from "../src/core/storageMigration";
import {
  BRANCH_METADATA_FILE,
  BranchStorageMetadata,
  MIGRATION_JOURNAL_FILE,
  STORAGE_ARCHIVE_DIRECTORY,
  branchStorePath,
  createBranchMetadata,
  hashedBranchStorePath,
  legacyBranchStorePath,
  legacyProjectStorePath
} from "../src/core/storagePaths";
import { Logger, StorageMigrationChoice, SyncPrompts, WorkspaceSyncContext } from "../src/core/types";

const sample = (value: string) => Buffer.from(`SAMPLE=${value}\n`);

function contextFor(root: string, nestedGitLab = false): WorkspaceSyncContext {
  const host = nestedGitLab ? "gitlab.com" : "github.com";
  const projectPath = nestedGitLab ? "group/subgroup/app" : "NickBoomBoom/electron-ai-switch";
  return {
    workspacePath: path.join(root, "workspace"),
    workspaceName: "sample-workspace",
    branch: "v3",
    project: {
      host,
      owner: nestedGitLab ? "subgroup" : "NickBoomBoom",
      repo: nestedGitLab ? "app" : "electron-ai-switch",
      path: projectPath,
      slug: `${host}/${projectPath}`
    },
    pathRegexSources: ["^\\.env[^/]*$"],
    pathRegexes: [/^\.env[^/]*$/],
    ignoredProjectRoots: [],
    ignoredDirectoryNames: []
  };
}

class RecordingLogger implements Logger {
  readonly messages: string[] = [];
  info(message: string): void { this.messages.push(`info:${message}`); }
  warn(message: string): void { this.messages.push(`warn:${message}`); }
  error(message: string): void { this.messages.push(`error:${message}`); }
}

function promptsFor(
  choose?: NonNullable<SyncPrompts["chooseStorageMigration"]>
): SyncPrompts {
  return {
    async chooseLocalOnly() { return "skip"; },
    async chooseConflict() { return "skip"; },
    ...(choose ? { chooseStorageMigration: choose } : {})
  };
}

async function write(root: string, relativePath: string, content: Buffer | string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function marker(root: string, value: unknown = { version: 1 }): Promise<void> {
  await write(root, BRANCH_METADATA_FILE, `${JSON.stringify(value)}\n`);
}

async function readMetadata(root: string): Promise<BranchStorageMetadata> {
  return JSON.parse(await fs.readFile(path.join(root, BRANCH_METADATA_FILE), "utf8")) as BranchStorageMetadata;
}

async function absent(target: string): Promise<void> {
  await assert.rejects(fs.lstat(target), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

async function activeFiles(root: string): Promise<Map<string, Buffer>> {
  return readMatchingFiles(root, [/.+/]);
}

async function assertFiles(root: string, expected: Record<string, Buffer>): Promise<void> {
  const actual = await activeFiles(root);
  assert.deepEqual([...actual.keys()].sort(), Object.keys(expected).sort());
  for (const [name, bytes] of Object.entries(expected)) {
    assert.deepEqual(actual.get(name), bytes, `${name} must preserve its sample bytes`);
  }
}

async function createDirectoryLink(suite: Mocha.Context, target: string, link: string): Promise<void> {
  await fs.mkdir(path.dirname(link), { recursive: true });
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS", "EINVAL"].includes(code ?? "")) suite.skip();
    throw error;
  }
}

describe("readable branch storage migration", function () {
  this.timeout(30_000);
  let root: string;
  let repo: ReadyConfigRepo;
  let context: WorkspaceSyncContext;
  let logger: RecordingLogger;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "env-storage-migration-"));
    repo = { repoPath: path.join(root, "repo"), branch: "main" };
    await fs.mkdir(repo.repoPath, { recursive: true });
    context = contextFor(root);
    logger = new RecordingLogger();
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const noPrompt = () => promptsFor(async () => { throw new Error("unexpected migration prompt"); });

  it("copies a complete hashed v3 snapshot into the exact readable path and keeps its source", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    const files = { ".env": sample("hash-current"), "config/extra.txt": sample("complete-snapshot") };
    for (const [name, bytes] of Object.entries(files)) await write(source, name, bytes);
    await marker(source);
    const sourceMarker = await fs.readFile(path.join(source, BRANCH_METADATA_FILE));

    const result = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    assert.equal(target, path.join(repo.repoPath, "projects", "github.com", "NickBoomBoom", "electron-ai-switch", "branches", "v3"));
    assert.equal(result.remoteRoot, target);
    assert.equal(result.inherited, true);
    await assertFiles(target, files);
    await assertFiles(source, files);
    assert.deepEqual(await fs.readFile(path.join(source, BRANCH_METADATA_FILE)), sourceMarker);
    const metadata = await readMetadata(target);
    assert.equal(metadata.version, 2);
    assert.equal(metadata.layout, "readable-v2");
    assert.deepEqual(metadata.project, { host: context.project.host, path: context.project.path });
    assert.equal(metadata.branch, "v3");
    assert.equal(metadata.migration?.sourceKind, "hashed");
    assert.equal(metadata.migration?.source, path.relative(repo.repoPath, source).split(path.sep).join("/"));
    await absent(path.join(target, MIGRATION_JOURNAL_FILE));
  });

  it("does not let a readable v1 marker hide newer hash data or silently resolve a cancelled conflict", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    await write(source, ".env", sample("hash-new"));
    await marker(source);
    await write(target, ".env", sample("readable-old"));
    await marker(target);
    const originalMarker = await fs.readFile(path.join(target, BRANCH_METADATA_FILE));
    const decisions: StorageMigrationChoice[] = [];

    await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(async (_context, details) => {
      decisions.push(details);
      return "cancel";
    }), logger));

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].reason, "conflicting-snapshots");
    assert.ok(decisions[0].conflictingPaths.includes(".env"));
    await assertFiles(target, { ".env": sample("readable-old") });
    await assertFiles(source, { ".env": sample("hash-new") });
    assert.deepEqual(await fs.readFile(path.join(target, BRANCH_METADATA_FILE)), originalMarker);
    await absent(path.join(target, MIGRATION_JOURNAL_FILE));
    await absent(path.join(target, STORAGE_ARCHIVE_DIRECTORY));
    assert.ok(!logger.messages.some(message => message.includes("存储迁移完成")));
  });

  it("treats target-only files missing from a complete hash snapshot as conflicts, not files to revive", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("same"));
    await marker(target);
    await write(target, ".env", sample("same"));
    await write(target, ".env.deleted", sample("obsolete"));
    let prompted = false;

    await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(async (_context, details) => {
      prompted = true;
      assert.ok(details.conflictingPaths.includes(".env.deleted"));
      return "cancel";
    }), logger));
    assert.equal(prompted, true);
    // Cancellation preserves the pre-migration snapshot; it does not activate a v2 layout.
    assert.equal((await readMetadata(target)).version, 1);
    await absent(path.join(target, MIGRATION_JOURNAL_FILE));
    await assertFiles(source, { ".env": sample("same") });
    await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(), logger));
  });

  it("archives the entire old target before explicit source replacement and excludes the archive from broad scans", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    const sourceFiles = { ".env": sample("source-current"), "config/extra.txt": sample("source-extra") };
    const targetFiles = { ".env": sample("target-old"), ".env.deleted": sample("target-only") };
    for (const [name, bytes] of Object.entries(sourceFiles)) await write(source, name, bytes);
    for (const [name, bytes] of Object.entries(targetFiles)) await write(target, name, bytes);
    await marker(source);
    await marker(target);

    const result = await prepareReadableBranchStore(repo, context, promptsFor(async () => "source"), logger);

    assert.equal(result.inherited, true);
    const metadata = await readMetadata(target);
    assert.equal(metadata.migration?.selection, "source");
    assert.ok(metadata.migration?.archive);
    const archiveRoot = path.resolve(target, metadata.migration!.archive!);
    const archiveRelative = path.relative(path.join(target, STORAGE_ARCHIVE_DIRECTORY), archiveRoot);
    assert.ok(archiveRelative.length > 0 && !archiveRelative.startsWith("..") && !path.isAbsolute(archiveRelative));
    await assertFiles(archiveRoot, targetFiles);
    assert.equal((await readMetadata(archiveRoot)).version, 1);
    await assertFiles(target, sourceFiles);
    await assertFiles(source, sourceFiles);
    await absent(path.join(target, ".env.deleted"));
    const broadScan = await readMatchingFiles(target, [/.*/]);
    assert.deepEqual([...broadScan.keys()].sort(), Object.keys(sourceFiles).sort());
    assert.ok(![...broadScan.keys()].some(name => name.includes(STORAGE_ARCHIVE_DIRECTORY) || name.includes(BRANCH_METADATA_FILE)));
  });

  it("keeps the selected target snapshot without supplementing source files and assigns a stable baseline generation", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("source-new"));
    await write(source, ".env.source-only", sample("must-not-merge"));
    await marker(target);
    await write(target, ".env", sample("target-chosen"));
    await write(target, ".env.target-only", sample("target-kept"));

    const result = await prepareReadableBranchStore(repo, context, promptsFor(async () => "target"), logger);

    await assertFiles(target, { ".env": sample("target-chosen"), ".env.target-only": sample("target-kept") });
    assert.equal(typeof result.baselineGeneration, "string");
    assert.ok(result.baselineGeneration!.length > 0);
    const metadata = await readMetadata(target);
    assert.equal(metadata.baselineGeneration, result.baselineGeneration);
    assert.equal(metadata.migration?.selection, "target");
    await absent(path.join(target, STORAGE_ARCHIVE_DIRECTORY));
    assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("source-new"));
    const repeat = await prepareReadableBranchStore(repo, context, noPrompt(), logger);
    assert.equal(repeat.inherited, false);
    assert.equal(repeat.baselineGeneration, result.baselineGeneration);
  });

  for (const shape of ["file-to-directory", "directory-to-file"] as const) {
    it(`replaces ${shape} conflicts after archiving without manual target edits`, async () => {
      const source = hashedBranchStorePath(repo.repoPath, context);
      const target = branchStorePath(repo.repoPath, context);
      await marker(source);
      await marker(target);
      const sourceName = shape === "file-to-directory" ? "nested/.env" : "nested";
      const targetName = shape === "file-to-directory" ? "nested" : "nested/.env";
      await write(source, sourceName, sample("new-shape"));
      await write(target, targetName, sample("old-shape"));
      await prepareReadableBranchStore(repo, context, promptsFor(async () => "source"), logger);
      assert.deepEqual(await fs.readFile(path.join(target, sourceName)), sample("new-shape"));
      const metadata = await readMetadata(target);
      assert.deepEqual(await fs.readFile(path.join(target, metadata.migration!.archive!, targetName)), sample("old-shape"));
      assert.deepEqual(await fs.readFile(path.join(source, sourceName)), sample("new-shape"));
      assert.equal(metadata.version, 2);
    });
  }

  async function interruptCopy() {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("snapshot"));
    await write(source, "nested/.env", sample("nested-snapshot"));
    await marker(target);
    await write(target, "nested", sample("blocking-file"));
    const originalWrite = fs.writeFile;
    const descriptor = Object.getOwnPropertyDescriptor(fs, "writeFile")!;
    let interrupted = false;
    Object.defineProperty(fs, "writeFile", {
      ...descriptor,
      value: async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]) === path.join(target, "nested", ".env")) {
          interrupted = true;
          throw Object.assign(new Error("sample interrupted disk write"), { code: "EIO" });
        }
        return originalWrite(...args);
      }
    });
    try {
      await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(async () => "source"), logger));
    } finally {
      Object.defineProperty(fs, "writeFile", descriptor);
    }
    assert.equal(interrupted, true);
    const journalPath = path.join(target, MIGRATION_JOURNAL_FILE);
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    assert.equal(journal.version, 1);
    assert.equal(journal.selection, "source");
    assert.equal((await readMetadata(target)).version, 1, "the completion marker must be written last");
    assert.ok(journal.archiveComplete, "the previous target is archived before the interrupted copy");
    const archiveRoot = path.resolve(target, journal.archive);
    assert.deepEqual(await fs.readFile(path.join(archiveRoot, "nested")), sample("blocking-file"));
    return { source, target, journalPath, journal };
  }

  it("retries a journaled interrupted copy without reprompting and writes v2 only after all files exist", async () => {
    const { source, target, journalPath } = await interruptCopy();

    const result = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    assert.equal(result.inherited, true);
    const expected = { ".env": sample("snapshot"), "nested/.env": sample("nested-snapshot") };
    await assertFiles(target, expected);
    await assertFiles(source, expected);
    assert.equal((await readMetadata(target)).version, 2);
    await absent(journalPath);
    const again = await prepareReadableBranchStore(repo, context, noPrompt(), logger);
    assert.equal(again.inherited, false);
  });

  it("refuses a retry if an already completed archive was removed or changed", async () => {
    const { target, journal } = await interruptCopy();
    const archiveRoot = path.resolve(target, journal.archive);
    await fs.unlink(path.join(archiveRoot, "nested"));
    const before = await activeFiles(target);
    await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger), /归档缺失或不完整/);
    assert.deepEqual(await activeFiles(target), before);
    assert.equal((await readMetadata(target)).version, 1);
  });

  it("rejects a retry if the original source changed while migration was interrupted", async () => {
    const { source, target, journalPath } = await interruptCopy();
    await write(source, "nested/.env", sample("changed-after-interruption"));
    const before = await activeFiles(target);

    await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));

    assert.deepEqual(await activeFiles(target), before);
    assert.equal((await readMetadata(target)).version, 1);
    await fs.access(journalPath);
  });

  it("rejects a journal redirected to a different same-content source instead of trusting a valid fingerprint alone", async () => {
    const { source, target, journalPath, journal } = await interruptCopy();
    const other = path.join(repo.repoPath, "other-project", "snapshot");
    await fs.cp(source, other, { recursive: true });
    const redirected = path.relative(repo.repoPath, other).split(path.sep).join("/");
    journal.source = redirected;
    journal.metadata.migration.source = redirected;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    const before = await activeFiles(target);

    await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));

    assert.deepEqual(await activeFiles(target), before);
    assert.equal((await readMetadata(target)).version, 1);
  });

  it("rejects a journal whose source kind does not match its identity-derived path", async () => {
    const { target, journalPath, journal } = await interruptCopy();
    journal.sourceKind = "legacy-shared";
    journal.metadata.migration.sourceKind = "legacy-shared";
    await fs.writeFile(journalPath, JSON.stringify(journal));
    const before = await activeFiles(target);
    await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));
    assert.deepEqual(await activeFiles(target), before);
    assert.equal((await readMetadata(target)).version, 1);
  });

  it("does not revive a deleted readable env file from either hash or legacy after v2 completion", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("current"));
    const first = await prepareReadableBranchStore(repo, context, noPrompt(), logger);
    const metadataBefore = await fs.readFile(path.join(first.remoteRoot, BRANCH_METADATA_FILE));
    await fs.unlink(path.join(first.remoteRoot, ".env"));
    await write(legacyProjectStorePath(repo.repoPath, context), ".env", sample("legacy-must-not-revive"));

    const result = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    assert.equal(result.inherited, false);
    await absent(path.join(result.remoteRoot, ".env"));
    assert.deepEqual(await fs.readFile(path.join(result.remoteRoot, BRANCH_METADATA_FILE)), metadataBefore);
    assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("current"));
  });

  it("does not mix legacy shared files into a complete hash snapshot", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("hash-authoritative"));
    const shared = legacyProjectStorePath(repo.repoPath, context);
    await write(shared, ".env", sample("shared-old"));
    await write(shared, ".env.shared-only", sample("shared-only"));

    const result = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    await assertFiles(result.remoteRoot, { ".env": sample("hash-authoritative") });
    await absent(path.join(result.remoteRoot, ".env.shared-only"));
    assert.deepEqual(await fs.readFile(path.join(shared, ".env.shared-only")), sample("shared-only"));
  });

  for (const location of ["source", "target"] as const) {
    it(`rejects identity-mismatched v2 metadata in the ${location}`, async () => {
      const source = hashedBranchStorePath(repo.repoPath, context);
      const target = branchStorePath(repo.repoPath, context);
      await write(source, ".env", sample("source"));
      await marker(source);
      const wrongMetadata = { ...createBranchMetadata(context), project: { host: context.project.host, path: "different/project" } };
      await marker(location === "source" ? source : target, wrongMetadata);
      const before = await activeFiles(target);

      await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));

      assert.deepEqual(await activeFiles(target), before);
      assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("source"));
      await absent(path.join(target, MIGRATION_JOURNAL_FILE));
      if (location === "source") await absent(path.join(target, BRANCH_METADATA_FILE));
      else assert.deepEqual(await readMetadata(target), wrongMetadata);
    });
  }

  for (const legacyMarker of ["absent", "v1"] as const) {
    it(`requires confirmation for a nested GitLab legacy owner/repo source with ${legacyMarker} identity metadata`, async () => {
      context = contextFor(root, true);
      const source = legacyBranchStorePath(repo.repoPath, context);
      const target = branchStorePath(repo.repoPath, context);
      assert.notEqual(source, target);
      await write(source, ".env", sample("ambiguous-legacy"));
      if (legacyMarker === "v1") await marker(source);
      let prompted = false;

      await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(async (_context, details) => {
        prompted = true;
        assert.equal(details.reason, "ambiguous-legacy");
        return "cancel";
      }), logger));

      assert.equal(prompted, true, "v1 alone does not prove the complete nested project identity");
      await absent(target);
      assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("ambiguous-legacy"));
    });
  }

  it("migrates ambiguous nested legacy data only after explicit source selection", async () => {
    context = contextFor(root, true);
    const source = legacyBranchStorePath(repo.repoPath, context);
    await write(source, ".env", sample("explicitly-approved"));
    await marker(source);
    let prompts = 0;
    const result = await prepareReadableBranchStore(repo, context, promptsFor(async (_context, details) => {
      prompts += 1;
      assert.equal(details.reason, "ambiguous-legacy");
      return "source";
    }), logger);
    assert.equal(prompts, 1);
    assert.ok(result.baselineGeneration);
    await assertFiles(result.remoteRoot, { ".env": sample("explicitly-approved") });
    assert.equal((await readMetadata(result.remoteRoot)).project.path, "group/subgroup/app");
    assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("explicitly-approved"));
  });

  for (const changed of ["source", "target"] as const) {
    it(`rechecks the ${changed} after the confirmation dialog before accepting the selected snapshot`, async () => {
      const source = hashedBranchStorePath(repo.repoPath, context);
      const target = branchStorePath(repo.repoPath, context);
      await marker(source);
      await write(source, ".env", sample("source-before-confirm"));
      await marker(target);
      await write(target, ".env", sample("target-before-confirm"));
      let confirmations = 0;

      await assert.rejects(prepareReadableBranchStore(repo, context, promptsFor(async () => {
        confirmations += 1;
        if (confirmations > 1) return "cancel";
        await write(changed === "source" ? source : target, ".env", sample("changed-during-confirm"));
        return "source";
      }), logger));

      assert.ok(confirmations >= 1);
      assert.equal((await readMetadata(target)).version, 1);
      await absent(path.join(target, MIGRATION_JOURNAL_FILE));
      await absent(path.join(target, STORAGE_ARCHIVE_DIRECTORY));
      assert.deepEqual(await fs.readFile(path.join(target, ".env")), sample(changed === "target" ? "changed-during-confirm" : "target-before-confirm"));
    });
  }

  for (const redirected of ["source", "target", "repo"] as const) {
    it(`rejects a symbolic-link or junction ${redirected} root`, async function () {
      const source = hashedBranchStorePath(repo.repoPath, context);
      const target = branchStorePath(repo.repoPath, context);
      const outside = path.join(root, "outside");
      await fs.mkdir(outside, { recursive: true });
      await write(outside, ".env", sample("outside-must-not-change"));
      if (redirected === "source") {
        await marker(outside);
        await createDirectoryLink(this, outside, source);
      } else if (redirected === "target") {
        await marker(source);
        await write(source, ".env", sample("source"));
        await createDirectoryLink(this, outside, target);
      } else {
        const alias = path.join(root, "repo-link");
        await createDirectoryLink(this, repo.repoPath, alias);
        repo = { ...repo, repoPath: alias };
      }

      await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));

      assert.deepEqual(await fs.readFile(path.join(outside, ".env")), sample("outside-must-not-change"));
      await absent(path.join(outside, MIGRATION_JOURNAL_FILE));
      if (redirected === "target") await absent(path.join(outside, BRANCH_METADATA_FILE));
    });
  }

  it("upgrades an in-place legacy v1 marker to v2 without copying from itself or looping", async () => {
    const target = branchStorePath(repo.repoPath, context);
    assert.equal(legacyBranchStorePath(repo.repoPath, context), target);
    await marker(target);
    await write(target, ".env", sample("already-readable"));

    const first = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    assert.equal(first.inherited, true);
    assert.equal((await readMetadata(target)).version, 2);
    await assertFiles(target, { ".env": sample("already-readable") });
    await absent(path.join(target, MIGRATION_JOURNAL_FILE));
    await absent(path.join(target, STORAGE_ARCHIVE_DIRECTORY));
    const markerBefore = await fs.readFile(path.join(target, BRANCH_METADATA_FILE));
    const next = await prepareReadableBranchStore(repo, context, noPrompt(), logger);
    assert.equal(next.inherited, false);
    assert.equal(next.baselineGeneration, first.baselineGeneration);
    assert.deepEqual(await fs.readFile(path.join(target, BRANCH_METADATA_FILE)), markerBefore);
  });

  it("leaves a completed v2 snapshot untouched and does not repeat migration", async () => {
    const target = branchStorePath(repo.repoPath, context);
    const metadata = { ...createBranchMetadata(context), baselineGeneration: "sample-existing-generation" };
    await marker(target, metadata);
    await write(target, ".env", sample("v2-active"));
    const source = hashedBranchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("old-writer-source"));
    const before = await fs.readFile(path.join(target, BRANCH_METADATA_FILE));

    const result = await prepareReadableBranchStore(repo, context, noPrompt(), logger);

    assert.equal(result.inherited, false);
    assert.equal(result.baselineGeneration, "sample-existing-generation");
    assert.deepEqual(await fs.readFile(path.join(target, BRANCH_METADATA_FILE)), before);
    await assertFiles(target, { ".env": sample("v2-active") });
    await absent(path.join(target, MIGRATION_JOURNAL_FILE));
    await absent(path.join(target, STORAGE_ARCHIVE_DIRECTORY));
  });

  it("cleans an atomic journal temporary file if rename fails without changing the target snapshot", async () => {
    const source = hashedBranchStorePath(repo.repoPath, context);
    const target = branchStorePath(repo.repoPath, context);
    await marker(source);
    await write(source, ".env", sample("source"));
    const journalPath = path.join(target, MIGRATION_JOURNAL_FILE);
    const originalRename = fs.rename;
    const renameDescriptor = Object.getOwnPropertyDescriptor(fs, "rename")!;
    let renameAttempted = false;
    Object.defineProperty(fs, "rename", {
      ...renameDescriptor,
      value: async (oldPath: Parameters<typeof fs.rename>[0], newPath: Parameters<typeof fs.rename>[1]) => {
        if (String(newPath) === journalPath) {
          renameAttempted = true;
          throw Object.assign(new Error("sample atomic rename failure"), { code: "EACCES" });
        }
        return originalRename(oldPath, newPath);
      }
    });
    try {
      await assert.rejects(prepareReadableBranchStore(repo, context, noPrompt(), logger));
    } finally {
      Object.defineProperty(fs, "rename", renameDescriptor);
    }
    assert.equal(renameAttempted, true);
    await absent(journalPath);
    await absent(path.join(target, BRANCH_METADATA_FILE));
    await absent(path.join(target, ".env"));
    assert.ok(!(await fs.readdir(target)).some(name => name.endsWith(".tmp")), "failed atomic writes must clean temporary files");
    assert.deepEqual(await fs.readFile(path.join(source, ".env")), sample("source"));
  });
});
