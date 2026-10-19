import { isObjectStorageBackend, SERVICES } from './services.js';
import type { SailServiceName } from './types.js';

/**
 * The properties of an AdonisJS `s3` disk (`services.s3({...})` in
 * `config/drive.ts`) that sail fills from the environment.
 */
export type S3Property =
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'region'
  | 'bucket'
  | 'endpoint'
  | 'forcePathStyle';

/**
 * Which env key the app reads for each `s3` disk property. `null` means the
 * app does not read that property from the environment (a literal, or no
 * such property) — sail then writes nothing for it.
 */
export type S3EnvNames = Record<S3Property, string | null>;

/**
 * The stock names, from `@adonisjs/drive`'s scaffold. `forcePathStyle` has no
 * stock env key: the scaffold does not set it at all.
 */
export const DEFAULT_S3_ENV_NAMES: S3EnvNames = {
  accessKeyId: 'AWS_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  region: 'AWS_REGION',
  bucket: 'S3_BUCKET',
  endpoint: 'S3_ENDPOINT',
  forcePathStyle: null,
};

/** Stock key → disk property, the inverse of {@link DEFAULT_S3_ENV_NAMES}. */
const STOCK_S3_KEYS: Record<string, S3Property> = {
  AWS_ACCESS_KEY_ID: 'accessKeyId',
  AWS_SECRET_ACCESS_KEY: 'secretAccessKey',
  AWS_REGION: 'region',
  S3_BUCKET: 'bucket',
  S3_ENDPOINT: 'endpoint',
};

/**
 * The disk property a stock key stands for, or null for keys that are not
 * part of the object storage env.
 */
export function s3PropertyOf(key: string): S3Property | null {
  return STOCK_S3_KEYS[key] ?? null;
}

export interface S3DiskConfig {
  names: S3EnvNames;
  /** The disk sets `endpoint` at all — without it the SDK talks to AWS. */
  endpointConfigured: boolean;
  /** The disk sets `forcePathStyle` at all — the local backends need path-style URLs. */
  forcePathStyleConfigured: boolean;
}

/**
 * The body of the first `services.s3(` / `disks.s3(` call, parentheses
 * balanced. Null when the file defines no s3 disk.
 */
function s3DiskBody(stripped: string): string | null {
  const opening = /(?:services|disks)\.s3\(/.exec(stripped);
  if (!opening) {
    return null;
  }
  let depth = 1;
  const from = opening.index + opening[0].length;
  for (let index = from; index < stripped.length; index++) {
    const char = stripped[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return stripped.slice(from, index);
      }
    }
  }
  return stripped.slice(from);
}

/**
 * Reads which env keys the app's `s3` disk takes its settings from, so sail
 * writes `S3_ACCESS_KEY` when that is what `config/drive.ts` reads, instead of
 * stock names nothing reads. Expects comment-stripped source.
 *
 * Per property: an `env.get('KEY')` (or `process.env.KEY`) value → `KEY`; any
 * other value (a literal region, a computed endpoint) → null, sail writes
 * nothing; property absent → the stock name, except `forcePathStyle`, which
 * has none. No s3 disk at all → null.
 */
export function parseS3DiskConfig(strippedDriveTs: string): S3DiskConfig | null {
  const body = s3DiskBody(strippedDriveTs);
  if (body === null) {
    return null;
  }
  const names: S3EnvNames = { ...DEFAULT_S3_ENV_NAMES };
  const present: Partial<Record<S3Property, boolean>> = {};
  for (const property of Object.keys(DEFAULT_S3_ENV_NAMES) as S3Property[]) {
    const declared = new RegExp(`(?:^|[^A-Za-z0-9_$])${property}\\s*:`).exec(body);
    if (!declared) {
      continue;
    }
    present[property] = true;
    const value = body.slice(declared.index + declared[0].length);
    const key =
      /^\s*env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/.exec(value)?.[1] ??
      /^\s*process\.env\.([A-Z][A-Z0-9_]*)/.exec(value)?.[1] ??
      null;
    names[property] = key;
  }
  return {
    names,
    endpointConfigured: present.endpoint === true,
    forcePathStyleConfigured: present.forcePathStyle === true,
  };
}

/**
 * Keys `start/env.ts` declares as required — any `Env.schema.*` declaration
 * without `.optional`. Sail never writes an empty value for one of those: the
 * app would refuse to boot on it.
 */
export function parseRequiredEnvKeys(strippedEnvTs: string): string[] {
  const required: string[] = [];
  for (const match of strippedEnvTs.matchAll(
    /(?:^|[{,])\s*([A-Z][A-Z0-9_]*)\s*:\s*(Env\.schema\.[^\n]*)/gm,
  )) {
    const [, key, declaration] = match;
    if (key && declaration && !/\.optional\b|optional\(/.test(declaration)) {
      required.push(key);
    }
  }
  return required;
}

/**
 * How the app reads the env sail writes. Both fields come from the app scan;
 * leaving them out gives the stock behavior.
 */
export interface AppEnvOptions {
  /** Env keys the app's `s3` disk reads (see {@link parseS3DiskConfig}). */
  s3EnvNames?: S3EnvNames | undefined;
  /** Keys `start/env.ts` requires — never written empty (see {@link parseRequiredEnvKeys}). */
  requiredEnvKeys?: string[] | undefined;
}

/**
 * The env one service hands the app, given its resolved host ports, under
 * the key names the app actually reads:
 *
 * - object storage keys are renamed to what `config/drive.ts` reads (and
 *   dropped where it reads none); a `forcePathStyle` read from the env gets
 *   `true`, which every local backend needs;
 * - an empty credential (`REDIS_PASSWORD=`) is dropped when `start/env.ts`
 *   declares the key as required.
 */
export function serviceAppEnv(
  name: SailServiceName,
  ports: Record<string, number>,
  options: AppEnvOptions = {},
): Record<string, string> {
  const stock = SERVICES[name].appEnv(ports);
  const names = isObjectStorageBackend(name) ? options.s3EnvNames : undefined;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(stock)) {
    const property = names ? s3PropertyOf(key) : null;
    const target = property && names ? names[property] : key;
    if (target) {
      env[target] = value;
    }
  }
  if (names?.forcePathStyle) {
    env[names.forcePathStyle] = 'true';
  }

  for (const key of options.requiredEnvKeys ?? []) {
    if (env[key] === '') {
      delete env[key];
    }
  }
  return env;
}

/**
 * The stock key behind an env key sail writes, for keys renamed through
 * {@link S3EnvNames} — `S3_ACCESS_KEY` → `AWS_ACCESS_KEY_ID` when the disk
 * reads it for `accessKeyId`. Null for keys that are not renamed object
 * storage keys. `forcePathStyle` maps to the pseudo key `S3_FORCE_PATH_STYLE`.
 */
export function stockKeyFor(key: string, names: S3EnvNames | undefined): string | null {
  if (!names) {
    return null;
  }
  for (const [stock, property] of Object.entries(STOCK_S3_KEYS)) {
    if (names[property] === key) {
      return stock;
    }
  }
  return names.forcePathStyle === key ? 'S3_FORCE_PATH_STYLE' : null;
}
