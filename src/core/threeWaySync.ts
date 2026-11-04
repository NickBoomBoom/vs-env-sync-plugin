export type ThreeWayDecision = "none" | "pull" | "push" | "delete-local" | "delete-remote" | "conflict";
export type ThreeWayTrigger = "open" | "change";

export function decideThreeWay(
  baseHash: string | undefined,
  localHash: string | undefined,
  remoteHash: string | undefined,
  hasBaseline: boolean,
  trigger: ThreeWayTrigger
): ThreeWayDecision {
  if (localHash === remoteHash) {
    return "none";
  }

  if (!hasBaseline) {
    if (localHash === undefined) {
      return "pull";
    }
    if (remoteHash === undefined) {
      return trigger === "open" ? "conflict" : "push";
    }
    return "conflict";
  }

  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;
  if (!localChanged && !remoteChanged) {
    return "none";
  }
  if (localChanged && !remoteChanged) {
    return localHash === undefined ? "delete-remote" : "push";
  }
  if (remoteChanged && !localChanged) {
    return remoteHash === undefined ? "delete-local" : "pull";
  }
  return "conflict";
}
