import { RepoIdentity } from "./types";

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function validSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !/[\\\\\u0000-\u001f/]/.test(segment);
}

function validHost(host: string): boolean {
  return host.length > 0 && host !== "." && host !== ".." && !/[\\\\\u0000-\u001f/]/.test(host);
}

function toRepoIdentity(host: string, rawSegments: readonly string[]): RepoIdentity | undefined {
  const normalizedHost = host.toLowerCase();
  const segments = [...rawSegments];
  if (!validHost(normalizedHost) || segments.length < 2) {
    return undefined;
  }

  segments[segments.length - 1] = stripGitSuffix(segments[segments.length - 1]);
  if (!segments.every(validSegment)) {
    return undefined;
  }

  const projectPath = segments.join("/");
  return {
    host: normalizedHost,
    owner: segments[segments.length - 2],
    repo: segments[segments.length - 1],
    path: projectPath,
    slug: `${normalizedHost}/${projectPath}`
  };
}

function pathSegments(value: string): string[] | undefined {
  const trimmed = value.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = trimmed.split("/");
  return segments.every((segment) => segment.length > 0) ? segments : undefined;
}

function parseScpLikeOrigin(originUrl: string): RepoIdentity | undefined {
  const match = originUrl.match(/^(?:.+@)?([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }

  const segments = pathSegments(match[2]);
  return segments ? toRepoIdentity(match[1], segments) : undefined;
}

function parseUrlOrigin(originUrl: string): RepoIdentity | undefined {
  try {
    const parsed = new URL(originUrl);
    const rawSegments = pathSegments(parsed.pathname);
    if (!rawSegments) {
      return undefined;
    }
    const segments = rawSegments.map((segment) => decodeURIComponent(segment));
    return toRepoIdentity(parsed.hostname, segments);
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
