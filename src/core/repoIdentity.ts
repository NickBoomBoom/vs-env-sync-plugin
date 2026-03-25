import { RepoIdentity } from "./types";

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function cleanSegment(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function toRepoIdentity(host: string, owner: string, repo: string): RepoIdentity {
  const normalizedHost = host.toLowerCase();
  const normalizedOwner = cleanSegment(owner);
  const normalizedRepo = cleanSegment(stripGitSuffix(repo));
  return {
    host: normalizedHost,
    owner: normalizedOwner,
    repo: normalizedRepo,
    slug: `${normalizedHost}/${normalizedOwner}/${normalizedRepo}`
  };
}

function parseScpLikeOrigin(originUrl: string): RepoIdentity | undefined {
  const match = originUrl.match(/^(?:.+@)?([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }

  const [, host, remainder] = match;
  const parts = cleanSegment(remainder).split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  return toRepoIdentity(host, parts[parts.length - 2], parts[parts.length - 1]);
}

function parseUrlOrigin(originUrl: string): RepoIdentity | undefined {
  try {
    const parsed = new URL(originUrl);
    const segments = cleanSegment(parsed.pathname).split("/").filter(Boolean);
    if (segments.length < 2) {
      return undefined;
    }

    return toRepoIdentity(parsed.hostname, segments[segments.length - 2], segments[segments.length - 1]);
  } catch {
    return undefined;
  }
}

export function parseOriginUrl(originUrl: string): RepoIdentity | undefined {
  const raw = originUrl.trim();
  if (raw.length === 0) {
    return undefined;
  }

  return parseUrlOrigin(raw) ?? parseScpLikeOrigin(raw);
}
