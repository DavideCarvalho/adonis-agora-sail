import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import string from '@poppinss/utils/string';

import { sanitizeProjectName } from './context.js';

const execFileAsync = promisify(execFile);

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

/**
 * A volume a compose project created, as `docker volume ls` reports it.
 */
export interface ComposeVolume {
  name: string;
  project: string;
  /** The volume's name inside its compose file (`sail-postgres`), when labelled. */
  volume?: string | undefined;
}

/**
 * Parses `docker volume ls --format '{{json .}}'` (one object per line, or a
 * JSON array) into volumes with their compose project, read from the
 * `com.docker.compose.project` label. Volumes without the label are dropped.
 */
export function parseComposeVolumes(output: string): ComposeVolume[] {
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

  const volumes: ComposeVolume[] = [];
  for (const entry of entries) {
    const name = String(entry['Name'] ?? '');
    const labels = entry['Labels'];
    const label = (key: string): string | undefined => {
      if (typeof labels === 'string') {
        return labels
          .split(',')
          .map((pair) => pair.split('='))
          .find(([candidate]) => candidate === key)?.[1];
      }
      if (labels && typeof labels === 'object') {
        const value = (labels as Record<string, unknown>)[key];
        return typeof value === 'string' ? value : undefined;
      }
      return undefined;
    };
    const project = label('com.docker.compose.project');
    if (name && project) {
      const volume = label('com.docker.compose.volume');
      volumes.push(volume ? { name, project, volume } : { name, project });
    }
  }
  return volumes;
}

/**
 * The compose project names of every worktree of the app's repository that
 * still exists — the main checkout's (`appName`) and one `appName-<slug>` per
 * linked worktree, computed exactly like {@link resolveSailContext} does.
 * Null when git cannot list them (not a repository, git missing): without
 * that list a stopped stack and a deleted one look the same, so callers must
 * not treat volumes as orphans.
 */
export async function liveProjectNames(
  appRootPath: string,
  appName: string,
): Promise<Set<string> | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: appRootPath,
      encoding: 'utf8',
      windowsHide: true,
    }));
  } catch {
    return null;
  }
  const paths = stdout
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
  if (paths.length === 0) {
    return null;
  }

  const base = sanitizeProjectName(appName);
  const names = new Set<string>([base]);
  for (const path of paths.slice(1)) {
    let resolved = path;
    try {
      resolved = await realpath(path);
    } catch {
      // a worktree git still lists but whose directory is gone: its stack is
      // an orphan, so it must not count as live
      continue;
    }
    const name = basename(resolved);
    // Same slug as `getGitWorktree`, including its fallback for names that
    // slug to nothing.
    const slug =
      string.slug(name, { lower: true, strict: true }) ||
      `worktree-${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`;
    names.add(sanitizeProjectName(`${base}-${slug}`));
  }
  return names;
}

/**
 * Volumes that belong to orphan stacks: those of the orphan projects found
 * through `compose ls`, plus — when the live worktree list is known — those of
 * managed projects that have no containers left and match no live worktree
 * (a stack stopped with `sail:down`, then its worktree deleted). Volumes of
 * other apps and of live worktrees are never included.
 *
 * The second kind has no compose file and no container left to vouch for it,
 * only a project name — and `shop-api` could be another app's main checkout
 * as much as a `shop` worktree named `api`. So those are limited to volumes
 * sail itself declares (`sail-postgres`, `sail-redis`, …).
 */
export function findOrphanVolumes(
  volumes: ComposeVolume[],
  options: {
    appName: string;
    orphanProjects: string[];
    knownProjects: string[];
    liveProjects: Set<string> | null;
  },
): ComposeVolume[] {
  return volumes.filter((volume) => {
    if (!isManagedProject(volume.project, options.appName)) {
      return false;
    }
    if (options.orphanProjects.includes(volume.project)) {
      return true;
    }
    if (!options.liveProjects || options.knownProjects.includes(volume.project)) {
      return false;
    }
    return !options.liveProjects.has(volume.project) && volume.volume?.startsWith('sail-') === true;
  });
}
