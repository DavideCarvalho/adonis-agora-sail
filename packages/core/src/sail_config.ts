import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isObjectStorageBackend, isServiceName, OBJECT_STORAGE_BACKENDS } from './services.js';
import type { ObjectStorageBackend, SailServiceName } from './types.js';

/**
 * Excludes the whole object storage slot, whichever backend would fill it.
 * Listing a backend name (`minio`) only rules that backend out.
 */
export const OBJECT_STORAGE_EXCLUDE = 'object-storage';

export type SailExclude = SailServiceName | typeof OBJECT_STORAGE_EXCLUDE;

/**
 * The persistent, committed preferences `sail:install` reads from the `sail`
 * key of the app's `package.json`:
 *
 * ```json
 * "sail": {
 *   "objectStorage": "seaweedfs",
 *   "exclude": ["mailpit"],
 *   "images": { "postgres": "postgres:16" }
 * }
 * ```
 *
 * `package.json` because sail already reads it for the app name and the
 * dependency scan, it is JSON (no TypeScript to evaluate at install time,
 * where the app is never booted) and it is committed, so the whole team gets
 * the same stack from a plain `node ace sail:install`.
 */
export interface SailConfig {
  /** Backend for the object storage slot. Default: `DEFAULT_OBJECT_STORAGE`. */
  objectStorage?: ObjectStorageBackend;
  /** Services auto-detection must never add. `--services` still wins. */
  exclude: SailExclude[];
  /** Image overrides for newly generated services, e.g. `{ "postgres": "postgres:16" }`. */
  images: Partial<Record<SailServiceName, string>>;
}

export const SAIL_CONFIG_KEY = 'sail';

export function isSailExclude(value: string): value is SailExclude {
  return value === OBJECT_STORAGE_EXCLUDE || isServiceName(value);
}

/**
 * Validates the raw `sail` value of a `package.json`. Unknown or malformed
 * entries are dropped and reported, never fatal: a typo in a preference must
 * not stop the compose file from being written.
 */
export function parseSailConfig(raw: unknown): { config: SailConfig; problems: string[] } {
  const config: SailConfig = { exclude: [], images: {} };
  const problems: string[] = [];
  if (raw === undefined || raw === null) {
    return { config, problems };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('package.json "sail" must be an object — ignored');
    return { config, problems };
  }
  const value = raw as Record<string, unknown>;

  if (value['objectStorage'] !== undefined) {
    const backend = value['objectStorage'];
    if (typeof backend === 'string' && isObjectStorageBackend(backend)) {
      config.objectStorage = backend;
    } else {
      problems.push(
        `package.json "sail.objectStorage" must be one of ${OBJECT_STORAGE_BACKENDS.join(', ')} — ignored`,
      );
    }
  }

  if (value['exclude'] !== undefined) {
    const entries = Array.isArray(value['exclude']) ? value['exclude'] : [value['exclude']];
    for (const entry of entries) {
      if (typeof entry === 'string' && isSailExclude(entry)) {
        if (!config.exclude.includes(entry)) {
          config.exclude.push(entry);
        }
      } else {
        problems.push(`package.json "sail.exclude" has an unknown service: ${String(entry)}`);
      }
    }
  }

  if (value['images'] !== undefined) {
    const images = value['images'];
    if (typeof images === 'object' && images !== null && !Array.isArray(images)) {
      for (const [name, image] of Object.entries(images)) {
        if (isServiceName(name) && typeof image === 'string' && image.trim().length > 0) {
          config.images[name] = image.trim();
        } else {
          problems.push(
            `package.json "sail.images.${name}" is not a known service image — ignored`,
          );
        }
      }
    } else {
      problems.push('package.json "sail.images" must be an object — ignored');
    }
  }

  return { config, problems };
}

async function readPackageJson(appRootPath: string): Promise<string | null> {
  try {
    return await readFile(join(appRootPath, 'package.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads and validates `package.json#sail`. A missing or unparseable
 * `package.json` yields the empty config.
 */
export async function readSailConfig(
  appRootPath: string,
): Promise<{ config: SailConfig; problems: string[] }> {
  const raw = await readPackageJson(appRootPath);
  if (raw === null) {
    return parseSailConfig(undefined);
  }
  try {
    return parseSailConfig((JSON.parse(raw) as Record<string, unknown>)[SAIL_CONFIG_KEY]);
  } catch {
    return parseSailConfig(undefined);
  }
}

/** The indentation a JSON document already uses, so a rewrite keeps the diff to the edit. */
function detectIndent(content: string): string | number {
  const match = /^([ \t]+)"/m.exec(content);
  return match?.[1] ?? 2;
}

/**
 * Records install-time preferences in `package.json#sail` so the next plain
 * `sail:install` honors them: `exclude` entries are merged (append-only),
 * `objectStorage` is set. Everything else in the file is preserved, including
 * its indentation and trailing newline. Pure — returns the new content, or the
 * input unchanged (same string) when there is nothing to record.
 */
export function updateSailConfigContent(
  content: string,
  patch: { objectStorage?: ObjectStorageBackend | undefined; exclude?: SailExclude[] | undefined },
): string {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  const current =
    typeof pkg[SAIL_CONFIG_KEY] === 'object' &&
    pkg[SAIL_CONFIG_KEY] !== null &&
    !Array.isArray(pkg[SAIL_CONFIG_KEY])
      ? { ...(pkg[SAIL_CONFIG_KEY] as Record<string, unknown>) }
      : {};

  let changed = false;
  if (patch.objectStorage && current['objectStorage'] !== patch.objectStorage) {
    current['objectStorage'] = patch.objectStorage;
    changed = true;
  }
  if (patch.exclude && patch.exclude.length > 0) {
    const existing = Array.isArray(current['exclude'])
      ? (current['exclude'] as unknown[]).filter((entry) => typeof entry === 'string')
      : [];
    const merged = [...existing];
    for (const entry of patch.exclude) {
      if (!merged.includes(entry)) {
        merged.push(entry);
      }
    }
    if (merged.length !== existing.length || !Array.isArray(current['exclude'])) {
      current['exclude'] = merged;
      changed = true;
    }
  }
  if (!changed) {
    return content;
  }

  pkg[SAIL_CONFIG_KEY] = current;
  const trailing = content.endsWith('\n') ? '\n' : '';
  return `${JSON.stringify(pkg, null, detectIndent(content))}${trailing}`;
}

/**
 * Applies {@link updateSailConfigContent} to the app's `package.json` on disk.
 * `missing` when there is no parseable `package.json` to record into.
 */
export async function updateSailConfig(
  appRootPath: string,
  patch: { objectStorage?: ObjectStorageBackend | undefined; exclude?: SailExclude[] | undefined },
): Promise<'updated' | 'unchanged' | 'missing'> {
  const raw = await readPackageJson(appRootPath);
  if (raw === null) {
    return 'missing';
  }
  let next: string;
  try {
    next = updateSailConfigContent(raw, patch);
  } catch {
    return 'missing';
  }
  if (next === raw) {
    return 'unchanged';
  }
  await writeFile(join(appRootPath, 'package.json'), next, 'utf8');
  return 'updated';
}
