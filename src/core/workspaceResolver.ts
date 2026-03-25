import { GitCli } from "./git";
import { parseOriginUrl } from "./repoIdentity";
import { RepoIdentity } from "./types";

export async function resolveWorkspaceProject(workspacePath: string, git: GitCli): Promise<RepoIdentity | undefined> {
  const originUrl = await git.tryRun(["config", "--get", "remote.origin.url"], { cwd: workspacePath });
  if (!originUrl) {
    return undefined;
  }

  return parseOriginUrl(originUrl);
}
