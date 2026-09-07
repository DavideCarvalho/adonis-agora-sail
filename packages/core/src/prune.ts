import { sanitizeProjectName } from './context.js';

/**
 * A compose project reported by `docker compose ls --format json`.
 */
export interface ComposeProject {
  name: string;
  status: string;
  configFiles: string[];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * Parses `docker compose ls --format json` output. Older docker versions emit
 * a JSON array, newer ones emit NDJSON (one object per line) — both shapes
 * are accepted, and a blank output means "no projects".
 */
export function parseComposeProjects(output: string): ComposeProject[] {
  const raw = output.trim();
  if (!raw) {
    return [];
  }

  const entries: Record<string, unknown>[] = raw.startsWith('[')
    ? (JSON.parse(raw) as Record<string, unknown>[])
    : raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);

  return entries
    .map((entry) => ({
      name: String(entry['Name'] ?? ''),
      status: String(entry['Status'] ?? ''),
      configFiles: asStringArray(entry['ConfigFiles']),
    }))
    .filter((project) => project.name.length > 0);
}

/**
 * Whether a compose project belongs to this app's sail stacks: either the
 * main-checkout project (`appName` itself) or a per-worktree one
 * (`appName-<slug>`).
 */
export function isManagedProject(projectName: string, appName: string): boolean {
  const base = sanitizeProjectName(appName);
  return projectName === base || projectName.startsWith(`${base}-`);
}

/**
 * Finds managed projects whose compose file is gone from disk — i.e. stacks
 * left behind by deleted worktrees. A project with no reported config files
 * is never considered orphan: without a path there is nothing to verify, so
 * it is left alone. The `exists` parameter is `existsSync` in production and
 * a stub in tests.
 */
export function findOrphanProjects(
  projects: ComposeProject[],
  appName: string,
  exists: (path: string) => boolean,
): ComposeProject[] {
  return projects.filter(
    (project) =>
      isManagedProject(project.name, appName) &&
      project.configFiles.length > 0 &&
      project.configFiles.every((file) => !exists(file)),
  );
}
