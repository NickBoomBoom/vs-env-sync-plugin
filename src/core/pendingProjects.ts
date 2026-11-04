export async function processPendingProjects(
  pendingProjectPaths: Set<string>,
  task: (projectPath: string) => Promise<void>,
  onError: (projectPath: string, error: unknown) => void
): Promise<boolean> {
  let succeeded = true;
  for (const projectPath of [...pendingProjectPaths]) {
    pendingProjectPaths.delete(projectPath);
    try {
      await task(projectPath);
    } catch (error) {
      succeeded = false;
      pendingProjectPaths.add(projectPath);
      onError(projectPath, error);
    }
  }
  return succeeded;
}
