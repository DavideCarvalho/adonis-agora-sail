import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GitWorktree, getGitWorktree } from '@poppinss/utils';

import { computeWorktreePortOffset } from './ports.js';
import type { SailContext } from './types.js';

export const COMPOSE_FILE_NAME = 'compose.yml';

/**
 * Sanitizes a string into a valid docker compose project name:
 * lowercase alphanumerics, `-` and `_`, starting with an alphanumeric.
 */
export function sanitizeProjectName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[_-]+/, '')
    .replace(/-+$/, '');
  return sanitized || 'app';
}

/**
 * Builds a {@link SailContext} from already-resolved inputs. Pure — the
 * IO-bound resolution lives in {@link resolveSailContext} so this part
 * stays trivially testable.
 */
export function buildSailContext(
  appRootPath: string,
  appName: string,
  worktree: GitWorktree | null,
): SailContext {
  const baseName = sanitizeProjectName(appName);
  return {
    appName: baseName,
    projectName: worktree ? sanitizeProjectName(`${baseName}-${worktree.slug}`) : baseName,
    worktree,
    portOffset: worktree ? computeWorktreePortOffset(worktree.name) : 0,
    composeFilePath: join(appRootPath, COMPOSE_FILE_NAME),
  };
}

/**
 * Resolves the sail context for an application root: reads the app name from
 * package.json (falling back to the directory name) and detects whether the
 * root lives inside a linked git worktree. The worktree drives both the
 * compose project name (isolated containers/volumes per worktree) and the
 * deterministic port offset.
 */
export async function resolveSailContext(appRoot: URL): Promise<SailContext> {
  const appRootPath = fileURLToPath(appRoot);

  let appName = appRootPath.split('/').filter(Boolean).at(-1) ?? 'app';
  try {
    const pkg = JSON.parse(await readFile(join(appRootPath, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      appName = pkg.name.split('/').at(-1) ?? appName;
    }
  } catch {
    // no package.json — keep the directory name
  }

  const worktree = await getGitWorktree(appRootPath);
  return buildSailContext(appRootPath, appName, worktree);
}
