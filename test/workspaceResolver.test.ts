import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GitCli } from "../src/core/git";
import { discoverWorkspaceProjects, resolveWorkspaceProject } from "../src/core/workspaceResolver";

async function git(gitCli: GitCli, cwd: string, ...args: string[]): Promise<string> {
  return gitCli.run(args, { cwd });
}

async function initRepo(repoPath: string, gitCli: GitCli, originUrl: string): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  await git(gitCli, repoPath, "init");
  await git(gitCli, repoPath, "remote", "add", "origin", originUrl);
}

describe("workspaceResolver", () => {
  it("resolves only when the candidate path is the git project root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-resolve-"));
    const repoPath = path.join(root, "repo");
    const nestedPath = path.join(repoPath, "nested");
    const gitCli = new GitCli();

    await initRepo(repoPath, gitCli, "git@github.com:team/app.git");
    await fs.mkdir(nestedPath, { recursive: true });

    const rootProject = await resolveWorkspaceProject(repoPath, gitCli);
    const nestedProject = await resolveWorkspaceProject(nestedPath, gitCli);

    assert.equal(rootProject?.slug, "github.com/team/app");
    assert.equal(nestedProject, undefined);
  });

  it("discovers git projects within the configured search depth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-discover-"));
    const workspacePath = path.join(root, "workspace");
    const repoLevel1 = path.join(workspacePath, "repo-one");
    const repoLevel2 = path.join(workspacePath, "group", "repo-two");
    const repoLevel3 = path.join(workspacePath, "group", "deep", "repo-three");
    const gitCli = new GitCli();

    await fs.mkdir(workspacePath, { recursive: true });
    await initRepo(repoLevel1, gitCli, "git@github.com:team/repo-one.git");
    await initRepo(repoLevel2, gitCli, "git@github.com:team/repo-two.git");
    await initRepo(repoLevel3, gitCli, "git@github.com:team/repo-three.git");

    const discoveredProjects = await discoverWorkspaceProjects(workspacePath, gitCli, 2);
    const normalizedWorkspacePath = await fs.realpath(workspacePath);

    assert.deepEqual(
      discoveredProjects.map((project) => ({
        projectPath: path.relative(normalizedWorkspacePath, project.projectPath).replace(/\\/g, "/"),
        slug: project.project.slug
      })),
      [
        { projectPath: "group/repo-two", slug: "github.com/team/repo-two" },
        { projectPath: "repo-one", slug: "github.com/team/repo-one" }
      ]
    );
  });
});
