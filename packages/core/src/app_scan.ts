import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRequiredEnvKeys,
  parseS3DiskConfig,
  type S3DiskConfig,
  type S3EnvNames,
  stockKeyFor,
} from './app_env.js';
import { detectServicesFromDependencies } from './detect.js';
import {
  OBJECT_STORAGE_EXCLUDE,
  readSailConfig,
  type SailConfig,
  type SailExclude,
} from './sail_config.js';
import {
  DEFAULT_OBJECT_STORAGE,
  isObjectStorageBackend,
  OBJECT_STORAGE_DEPENDENCIES,
  SERVICE_NAMES,
  SERVICES,
} from './services.js';
import type { ObjectStorageBackend, SailServiceName } from './types.js';

export type ServiceEvidenceVia = 'dependency' | 'config' | 'env';

export interface ServiceEvidence {
  service: SailServiceName;
  via: ServiceEvidenceVia;
  detail: string;
}

export type DbClient = 'pg' | 'mysql' | 'sqlite' | 'libsql' | 'mssql' | null;

export interface AgoraSignal {
  file: string;
  service: SailServiceName;
  detail: string;
}

/**
 * Setup hint shown when object storage is selected and the app's s3 disk
 * lacks what a local backend needs: the stock `drive.stub` sets neither an
 * endpoint (so the SDK would talk to AWS) nor path-style addressing (which
 * every local backend needs — `<bucket>.localhost` resolves nowhere useful).
 * The bucket itself is created by `sail:up`.
 */
export const OBJECT_STORAGE_SETUP_NOTE =
  "Object storage: add `endpoint: env.get('S3_ENDPOINT')` and `forcePathStyle: true` to the s3 disk in config/drive.ts — the local backend needs both";

/** @deprecated Kept for imports from 0.4; use {@link OBJECT_STORAGE_SETUP_NOTE}. */
export const MINIO_SETUP_NOTE = OBJECT_STORAGE_SETUP_NOTE;

/**
 * The setup note for an app's s3 disk, or null when it already sets both an
 * endpoint and `forcePathStyle`. Without a parsed disk (object storage chosen
 * from a dependency or a flag alone) the full note applies.
 */
export function objectStorageSetupNote(disk: S3DiskConfig | null): string | null {
  if (!disk) {
    return OBJECT_STORAGE_SETUP_NOTE;
  }
  const missing: string[] = [];
  if (!disk.endpointConfigured) {
    missing.push(`\`endpoint: env.get('${disk.names.endpoint ?? 'S3_ENDPOINT'}')\``);
  }
  if (!disk.forcePathStyleConfigured) {
    missing.push('`forcePathStyle: true`');
  }
  if (missing.length === 0) {
    return null;
  }
  return `Object storage: add ${missing.join(' and ')} to the s3 disk in config/drive.ts — the local backend needs ${missing.length > 1 ? 'both' : 'it'}`;
}

/**
 * `CREATE EXTENSION [IF NOT EXISTS] vector` in any quoting, any case.
 */
const PGVECTOR_PATTERN =
  /create\s+extension\s+(?:if\s+not\s+exists\s+)?(?:["'`]|\\["'])?vector(?:["'`]|\\["'])?(?![A-Za-z0-9_])/i;

/**
 * The first migration (by path) that creates the pgvector extension, or null.
 */
export function findPgvectorMigration(migrations: Record<string, string>): string | null {
  for (const file of Object.keys(migrations).sort()) {
    if (PGVECTOR_PATTERN.test(migrations[file] ?? '')) {
      return file;
    }
  }
  return null;
}

export interface AppScan {
  /** Merged service list (postgres wins over mysql unless the config says mysql). */
  services: SailServiceName[];
  evidence: ServiceEvidence[];
  /** Keys declared in `start/env.ts`. Empty when the file is missing. */
  declaredEnvKeys: string[];
  /** Keys read via `env.get()` / `process.env` across the scanned configs. */
  usedEnvKeys: string[];
  /** Used but not declared — the keys `sail:install` offers to validate. */
  missingEnvKeys: string[];
  dbClient: DbClient;
  /** Active (uncommented) store/disk selections in non-first-party configs. */
  agora: AgoraSignal[];
  /** Human hints: sqlite, memory stores, the s3 endpoint, unmapped missing keys… */
  notes: string[];
  /** The backend that fills the object storage slot when object storage is selected. */
  objectStorage: ObjectStorageBackend;
  /** The app's s3 disk (`config/drive.ts`), when it defines one. */
  s3Disk: S3DiskConfig | null;
  /** Env keys the s3 disk reads — what the object storage env is written under. */
  s3EnvNames: S3EnvNames | undefined;
  /** Keys `start/env.ts` declares as required (no `.optional`). */
  requiredEnvKeys: string[];
  /** A migration under `database/migrations` that creates the pgvector extension. */
  pgvectorMigration: string | null;
  /** Validated `package.json#sail` preferences. */
  config: SailConfig;
}

/**
 * Stock `Env.schema` validations for the connection keys sail manages, copied
 * from the first-party scaffolds (`@adonisjs/presets` lucid stubs,
 * `@adonisjs/redis`, `@adonisjs/mail`, `@adonisjs/drive`). Keys outside this
 * map (e.g. `MAIL_MAILER`, `DRIVE_DISK`) are reported but never auto-added:
 * sail does not guess their shape.
 */
/**
 * Whether the file picks its active store through an env variable
 * (`default: env.get('LOCK_STORE')`), which is the shape `config/lock.ts`,
 * `config/limiter.ts` and `config/session.ts` ship with. The value lives in
 * `.env`, not in the file, so no amount of reading the source settles which
 * store is active — and telling the user to "select it" is advice for
 * something they may have done already.
 */
function selectedFromEnv(stripped: string): boolean {
  return /(^|[^a-zA-Z])(store|default|active)\s*:\s*env\.get\(/.test(stripped);
}

/**
 * Keys the framework reads without declaring, so their absence from
 * `start/env.ts` is normal rather than an oversight. `config/logger.ts` in
 * every stock AdonisJS app reads `APP_NAME` while no starter declares it —
 * without this list, sail tells every user on their first install to go fix a
 * file that is already correct.
 */
export const FRAMEWORK_ENV_KEYS: string[] = ['APP_NAME'];

export const ENV_VALIDATIONS: Record<string, string> = {
  DB_HOST: "Env.schema.string({ format: 'host' })",
  DB_PORT: 'Env.schema.number()',
  DB_USER: 'Env.schema.string()',
  DB_PASSWORD: 'Env.schema.string.optional()',
  DB_DATABASE: 'Env.schema.string()',
  REDIS_HOST: "Env.schema.string({ format: 'host' })",
  REDIS_PORT: 'Env.schema.number()',
  REDIS_PASSWORD: 'Env.schema.string.optional()',
  SMTP_HOST: "Env.schema.string({ format: 'host' })",
  SMTP_PORT: 'Env.schema.number()',
  // Object storage keys are optional on purpose. Sail adds them for the local
  // backend, but production and CI often reach S3 through an IAM role or a
  // differently-named set of keys, and a required validation sail added would
  // stop those boots on a key nobody there sets.
  AWS_ACCESS_KEY_ID: 'Env.schema.string.optional()',
  AWS_SECRET_ACCESS_KEY: 'Env.schema.string.optional()',
  AWS_REGION: 'Env.schema.string.optional()',
  S3_BUCKET: 'Env.schema.string.optional()',
  S3_ENDPOINT: "Env.schema.string.optional({ format: 'url', tld: false })",
  S3_FORCE_PATH_STYLE: 'Env.schema.boolean.optional()',
};

/**
 * The validation sail adds for a key it writes: the stock shape, or — for an
 * object storage key the app's s3 disk names differently (`S3_ACCESS_KEY`) —
 * the stock key's shape. Undefined when sail has no shape for it.
 */
export function envValidationFor(key: string, s3EnvNames?: S3EnvNames): string | undefined {
  const stock = stockKeyFor(key, s3EnvNames);
  return stock ? ENV_VALIDATIONS[stock] : ENV_VALIDATIONS[key];
}

/**
 * Cuts a `//` comment off a line, ignoring `//` inside single, double or
 * template strings and the `://` of URLs. The Agora fixtures comment
 * *out* store alternatives (`// lucid: storage.lucid(...)`), sometimes
 * trailing after code — without this, a commented alternative reads as an
 * active selection and sail would provision the wrong service.
 */
export function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length - 1; index++) {
    const char = line[index] as string;
    if (quote) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && line[index + 1] === '/' && line[index - 1] !== ':') {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * Strips block comments and `//` comments (see {@link stripLineComment}).
 * Only commented-out alternatives disappear — inline code, including URLs
 * in strings, survives.
 */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n');
}

/**
 * Keys declared as `KEY: Env.schema…` in `start/env.ts`. The key may open
 * the line (prettier output) or follow `{` / `,` (single-line objects).
 */
export function parseEnvTsKeys(content: string): string[] {
  const keys: string[] = [];
  for (const match of stripComments(content).matchAll(/(?:^|[{,])\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
    const key = match[1];
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Keys read as `env.get('KEY')` or `process.env.KEY` in config files.
 */
export function parseEnvGets(content: string): string[] {
  const keys: string[] = [];
  const stripped = stripComments(content);
  const patterns = [/env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, /process\.env\.([A-Z][A-Z0-9_]*)/g];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const key = match[1];
      if (key && !keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

const DB_CLIENT_BY_NAME: Record<string, Exclude<DbClient, null>> = {
  pg: 'pg',
  postgres: 'pg',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'libsql',
  mssql: 'mssql',
};

/**
 * The database client configured in `config/database.ts` (comments stripped),
 * via `client: 'pg'` or the `connection: 'postgres'` fallback. Null when the
 * file is absent or no client can be read.
 */
export function parseDbClient(databaseTs: string): DbClient {
  const stripped = stripComments(databaseTs);
  const client = /client\s*:\s*['"]([^'"]+)['"]/.exec(stripped)?.[1];
  if (client && client in DB_CLIENT_BY_NAME) {
    return DB_CLIENT_BY_NAME[client] as Exclude<DbClient, null>;
  }
  const connection = /connection\s*:\s*['"]([^'"]+)['"]/.exec(stripped)?.[1];
  if (connection && connection in DB_CLIENT_BY_NAME) {
    return DB_CLIENT_BY_NAME[connection] as Exclude<DbClient, null>;
  }
  return null;
}

const FIRST_PARTY_CONFIGS = new Set([
  'database.ts',
  'database.js',
  'redis.ts',
  'redis.js',
  'mail.ts',
  'mail.js',
  'drive.ts',
  'drive.js',
  'queue.ts',
  'queue.js',
]);

export interface AppScanInput {
  dependencies: Record<string, string>;
  envTs?: string | null;
  /** Filename (e.g. `telescope.ts`) → file content. */
  configs?: Record<string, string>;
  /** Path below `database/migrations` → file content. */
  migrations?: Record<string, string>;
  /** `package.json#sail`, already validated. */
  config?: SailConfig;
  /**
   * Backend chosen for this run (`--object-storage`). Like
   * `config.objectStorage`, choosing one counts as asking for object storage.
   */
  objectStorage?: ObjectStorageBackend | undefined;
}

function pushEvidence(evidence: ServiceEvidence[], entry: ServiceEvidence) {
  if (
    !evidence.some(
      (existing) =>
        existing.service === entry.service &&
        existing.via === entry.via &&
        existing.detail === entry.detail,
    )
  ) {
    evidence.push(entry);
  }
}

/**
 * Scans an app from already-read file contents. Pure — the IO lives in
 * {@link scanAppConfig} so this stays trivially testable with fixtures.
 *
 * Sources, in order: `package.json` dependencies (existing behavior),
 * `start/env.ts` declarations, then every `config/*.ts`: the first-party
 * files (`database`, `redis`, `mail`, `drive`) pin their service, and any
 * other config (first-party extras or `@adonis-agora/*` packages, which
 * consume named Lucid/Redis/Drive connections rather than env vars directly)
 * contributes active `store: 'lucid'` / `stores.redis(` / `disks.s3(`
 * selections as reinforcing evidence.
 */
export function scanAppFiles(input: AppScanInput): AppScan {
  const evidence: ServiceEvidence[] = [];
  const agora: AgoraSignal[] = [];
  const notes: string[] = [];
  const config: SailConfig = input.config ?? { exclude: [], images: {} };
  const chosenStorage = input.objectStorage ?? config.objectStorage;
  const objectStorage: ObjectStorageBackend = chosenStorage ?? DEFAULT_OBJECT_STORAGE;

  for (const name of detectServicesFromDependencies(input.dependencies, objectStorage)) {
    const hit =
      [
        ...SERVICES[name].detectedBy,
        ...(name === objectStorage ? OBJECT_STORAGE_DEPENDENCIES : []),
      ].find((dep) => dep in input.dependencies) ?? 'dependency';
    pushEvidence(evidence, { service: name, via: 'dependency', detail: `package.json:${hit}` });
  }

  if (chosenStorage) {
    pushEvidence(evidence, {
      service: objectStorage,
      via: 'config',
      detail: input.objectStorage ? '--object-storage' : 'package.json:sail.objectStorage',
    });
  }

  const declaredEnvKeys = input.envTs ? parseEnvTsKeys(input.envTs) : [];
  const requiredEnvKeys = input.envTs ? parseRequiredEnvKeys(stripComments(input.envTs)) : [];
  const usedKeys = new Set<string>();
  // S3 env reads count as object storage evidence only from files that use
  // their s3 disk unconditionally — a disk picked from the environment is the
  // ambiguity below, and its reads say nothing more than the disk does.
  const s3ReadsFrom = new Map<string, string[]>();
  const s3Ambiguous: string[] = [];
  let s3Disk: S3DiskConfig | null = null;

  const configs = input.configs ?? {};

  // `database.ts` first: everything else (agora lucid selections, the
  // pg/mysql tie-break, dep vetoes) depends on the configured client.
  const dbRaw = configs['database.ts'] ?? configs['database.js'] ?? null;
  const dbClient = dbRaw ? parseDbClient(dbRaw) : null;
  if (dbRaw) {
    for (const key of parseEnvGets(stripComments(dbRaw))) {
      usedKeys.add(key);
    }
    const dbFile = 'database.ts' in configs ? 'database.ts' : 'database.js';
    if (dbClient === 'pg') {
      pushEvidence(evidence, { service: 'postgres', via: 'config', detail: `${dbFile}:pg client` });
    } else if (dbClient === 'mysql') {
      pushEvidence(evidence, { service: 'mysql', via: 'config', detail: `${dbFile}:mysql client` });
    } else if (dbClient === 'sqlite') {
      notes.push(`${dbFile} uses SQLite — no database container needed`);
    } else if (dbClient === 'libsql' || dbClient === 'mssql') {
      notes.push(`${dbFile} uses ${dbClient} — sail ships no image for it, skipping`);
    }
  }

  for (const [file, raw] of Object.entries(configs)) {
    if (file === 'database.ts' || file === 'database.js') {
      continue;
    }
    const stripped = stripComments(raw);
    const reads = parseEnvGets(stripped);
    for (const key of reads) {
      usedKeys.add(key);
    }
    s3ReadsFrom.set(file, reads);

    if (file === 'redis.ts' || file === 'redis.js') {
      if (stripped.trim().length > 0) {
        pushEvidence(evidence, { service: 'redis', via: 'config', detail: `${file}:redis config` });
      }
      continue;
    }

    if (file === 'mail.ts' || file === 'mail.js') {
      if (
        /transports\.smtp|(\W|^)smtp\s*:/.test(stripped) ||
        /SMTP_HOST|SMTP_PORT/.test(stripped)
      ) {
        pushEvidence(evidence, {
          service: 'mailpit',
          via: 'config',
          detail: `${file}:smtp mailer`,
        });
      }
      continue;
    }

    if (file === 'drive.ts' || file === 'drive.js') {
      s3Disk = parseS3DiskConfig(stripped);
      if (
        /services\.s3\(|disks\.s3\(|disk\s*:\s*['"]s3['"]/.test(stripped) ||
        /AWS_ACCESS_KEY_ID|S3_BUCKET|S3_ENDPOINT/.test(stripped)
      ) {
        // `default: env.get('DRIVE_DISK')` — the stock shape — leaves the
        // active disk to `.env`, where it is often `fs` in development. Same
        // call as for session/lock stores: say so, do not provision.
        if (selectedFromEnv(stripped) && !/default\s*:\s*['"]s3['"]/.test(stripped)) {
          s3Ambiguous.push(file);
        } else {
          pushEvidence(evidence, {
            service: objectStorage,
            via: 'config',
            detail: `${file}:s3 disk`,
          });
        }
      }
      continue;
    }

    if (FIRST_PARTY_CONFIGS.has(file)) {
      continue;
    }

    // Anything else: an Agora (or custom) package config. Only active,
    // uncommented selections count — the fixtures document alternatives in
    // comments (`// lucid: storage.lucid(...)`), which stripping removes.
    // A defined-but-unselected driver (`stores: { lucid: … }` with
    // `store: 'memory'`) is a note, not evidence: flipping it on is one word,
    // but sail does not provision services nobody selected.
    if (/(^|[^a-zA-Z])(store|default|active)\s*:\s*['"]lucid['"]/.test(stripped)) {
      if (dbClient === 'pg') {
        agora.push({ file, service: 'postgres', detail: 'lucid store selected (pg)' });
      } else if (dbClient === 'mysql') {
        agora.push({ file, service: 'mysql', detail: 'lucid store selected (mysql)' });
      } else if (dbClient === 'sqlite') {
        notes.push(`${file} selects the lucid store on SQLite — no container needed`);
      } else {
        notes.push(
          `${file} selects the lucid store but no pg/mysql connection is configured — add one and re-run install to persist`,
        );
      }
    } else if (/stores\.lucid\(/.test(stripped)) {
      notes.push(
        selectedFromEnv(stripped)
          ? `${file} picks its store from the environment — sail cannot tell whether lucid is the active one`
          : `${file} defines a lucid store but the active store is not lucid — select it and re-run install to persist`,
      );
    }
    if (
      /(^|[^a-zA-Z])(store|default|active)\s*:\s*['"]redis['"]/.test(stripped) ||
      /transports\.redis\(|admissions\.redis\(|drivers\.redis\(|bullmq/.test(stripped)
    ) {
      agora.push({ file, service: 'redis', detail: 'redis transport' });
    } else if (/stores\.redis\(/.test(stripped)) {
      notes.push(
        selectedFromEnv(stripped)
          ? `${file} picks its store from the environment — sail cannot tell whether redis is the active one; pass --services=redis if it is`
          : `${file} defines a redis store but the active store is not redis — select it and re-run install to use it`,
      );
    }
    if (/(^|[^a-zA-Z])disk\s*:\s*['"]s3['"]/.test(stripped)) {
      agora.push({ file, service: objectStorage, detail: 's3 disk' });
    } else if (/disks\.s3\(|services\.s3\(/.test(stripped)) {
      if (selectedFromEnv(stripped) || /(^|[^a-zA-Z])disk\s*:\s*env\.get\(/.test(stripped)) {
        s3Ambiguous.push(file);
      } else {
        agora.push({ file, service: objectStorage, detail: 's3 disk' });
      }
    }
    if (
      /store\s*:\s*['"]memory['"]/.test(stripped) &&
      /lucid/.test(raw) &&
      /stores?\s*:\s*{/.test(stripped)
    ) {
      notes.push(
        `${file} uses the memory store — switch store to 'lucid' to persist (needs a database)`,
      );
    }
  }

  // A `DRIVE_DISK` enum that only admits `s3` settles it; one that admits
  // `s3` among others (`['fs', 's3']`, the stock shape) is the same
  // ambiguity as the env-selected default it feeds.
  if (input.envTs) {
    const driveDiskLine = stripComments(input.envTs)
      .split('\n')
      .find((line) => line.includes('DRIVE_DISK'));
    const allowed = [...(driveDiskLine?.matchAll(/['"]([a-z0-9_-]+)['"]/gi) ?? [])].map(
      (match) => match[1],
    );
    if (allowed.includes('s3')) {
      if (allowed.every((disk) => disk === 's3')) {
        pushEvidence(evidence, {
          service: objectStorage,
          via: 'env',
          detail: 'start/env.ts:DRIVE_DISK is s3',
        });
      } else if (s3Ambiguous.length === 0) {
        s3Ambiguous.push('start/env.ts');
      }
    }
  }

  // Bare `REDIS_*` / `SMTP_*` / `AWS_*` reads outside their config file still
  // imply the service (e.g. a hand-rolled ioredis client).
  if (usedKeys.has('REDIS_HOST') || usedKeys.has('REDIS_PORT')) {
    pushEvidence(evidence, { service: 'redis', via: 'config', detail: 'REDIS_* env reads' });
  }
  if (usedKeys.has('SMTP_HOST') || usedKeys.has('SMTP_PORT')) {
    pushEvidence(evidence, { service: 'mailpit', via: 'config', detail: 'SMTP_* env reads' });
  }
  const s3Reads = [...s3ReadsFrom]
    .filter(([file]) => !s3Ambiguous.includes(file))
    .flatMap(([, reads]) => reads);
  if (
    s3Reads.includes('AWS_ACCESS_KEY_ID') ||
    s3Reads.includes('S3_BUCKET') ||
    s3Reads.includes('S3_ENDPOINT')
  ) {
    pushEvidence(evidence, { service: objectStorage, via: 'config', detail: 'S3 env reads' });
  }

  for (const signal of agora) {
    pushEvidence(evidence, {
      service: signal.service,
      via: 'config',
      detail: `${signal.file}:${signal.detail}`,
    });
  }

  // Config veto: a bare dependency is a weak signal. When the owning config
  // file exists and shows the service is not used, the dep evidence is
  // dropped (with a note) instead of provisioning an idle container. Config
  // and env evidence always survive the veto.
  const vetoDepOnly = (service: SailServiceName, reason: string | null) => {
    const depDetails = evidence
      .filter((entry) => entry.service === service && entry.via === 'dependency')
      .map((entry) => entry.detail.replace('package.json:', ''));
    if (depDetails.length === 0) {
      return;
    }
    if (evidence.some((entry) => entry.service === service && entry.via !== 'dependency')) {
      return;
    }
    for (let index = evidence.length - 1; index >= 0; index--) {
      if (evidence[index]?.service === service) {
        evidence.splice(index, 1);
      }
    }
    // No reason: the caller reports the situation in a note of its own.
    if (reason) {
      notes.push(`package.json lists ${depDetails.join(', ')} but ${reason} — skipping ${service}`);
    }
  };

  if (dbRaw && dbClient && dbClient !== 'pg') {
    vetoDepOnly('postgres', `config/database.ts uses ${dbClient}`);
  }
  if (dbRaw && dbClient && dbClient !== 'mysql') {
    vetoDepOnly('mysql', `config/database.ts uses ${dbClient}`);
  }
  const driveFile = 'drive.ts' in configs ? 'drive.ts' : 'drive.js' in configs ? 'drive.js' : null;
  if (driveFile) {
    vetoDepOnly(
      objectStorage,
      s3Ambiguous.includes(driveFile) ? null : 'config/drive.ts has no s3 disk',
    );
  }
  const objectStorageEvidenced = evidence.some((entry) => entry.service === objectStorage);
  if (s3Ambiguous.length > 0 && !objectStorageEvidenced) {
    const where = s3Ambiguous.map((file) => (file.includes('/') ? file : `config/${file}`));
    notes.push(
      `${where.join(', ')} pick${where.length === 1 ? 's' : ''} the disk from the environment (DRIVE_DISK) — sail cannot tell whether s3 is the active one; pass --object-storage=${objectStorage} if it is`,
    );
  }
  if ('mail.ts' in configs || 'mail.js' in configs) {
    vetoDepOnly('mailpit', 'config/mail.ts has no smtp mailer');
  }

  const merged = mergeServices(
    evidence.map((entry) => entry.service),
    dbClient,
  );
  const { dropped } = merged;
  const excluded = merged.services.filter(
    (name) =>
      config.exclude.includes(name) ||
      (isObjectStorageBackend(name) && config.exclude.includes(OBJECT_STORAGE_EXCLUDE)),
  );
  const services = merged.services.filter((name) => !excluded.includes(name));
  if (excluded.length > 0) {
    notes.push(
      `package.json "sail.exclude" leaves out ${excluded.join(', ')} — pass --services to add it anyway`,
    );
  }

  const s3EnvNames = (s3Disk as S3DiskConfig | null)?.names;
  const usedEnvKeys = [...usedKeys].sort();
  const missingEnvKeys = usedEnvKeys.filter((key) => !declaredEnvKeys.includes(key));

  const unmappedMissing = missingEnvKeys.filter(
    (key) => envValidationFor(key, s3EnvNames) === undefined && !FRAMEWORK_ENV_KEYS.includes(key),
  );
  if (unmappedMissing.length > 0) {
    notes.push(
      `start/env.ts is missing ${unmappedMissing.join(', ')} — sail has no stock validation for these, add them by hand`,
    );
  }

  if (dropped) {
    notes.push(
      `both postgres and mysql drivers are present — keeping ${dropped === 'postgres' ? 'mysql' : 'postgres'} (${dbClient === 'mysql' ? 'config/database.ts says mysql' : 'postgres wins by default'}), pass --services to override`,
    );
  }

  if (services.some(isObjectStorageBackend)) {
    const setup = objectStorageSetupNote(s3Disk);
    if (setup) {
      notes.push(setup);
    }
  }

  const pgvectorMigration = findPgvectorMigration(input.migrations ?? {});
  if (pgvectorMigration && services.includes('postgres')) {
    notes.push(
      `database/migrations/${pgvectorMigration} creates the pgvector extension — postgres runs the pgvector image`,
    );
  }

  return {
    services,
    evidence,
    declaredEnvKeys,
    usedEnvKeys,
    missingEnvKeys,
    dbClient,
    agora,
    notes,
    objectStorage,
    s3Disk,
    s3EnvNames,
    requiredEnvKeys,
    pgvectorMigration,
    config,
  };
}

/**
 * Merges evidenced services into the final list. Postgres and MySQL are
 * mutually exclusive: the configured `database.ts` client wins, otherwise
 * postgres wins (existing `detectServices` behavior).
 */
export function mergeServices(
  evidenced: SailServiceName[],
  dbClient: DbClient,
): { services: SailServiceName[]; dropped: SailServiceName | null } {
  const wanted = new Set(evidenced);
  let dropped: SailServiceName | null = null;
  if (wanted.has('postgres') && wanted.has('mysql')) {
    dropped = dbClient === 'mysql' ? 'postgres' : 'mysql';
    wanted.delete(dropped);
  }
  return { services: SERVICE_NAMES.filter((name) => wanted.has(name)), dropped };
}

/**
 * Reads `package.json`, `start/env.ts` and `config/*.ts` below an app root
 * and scans them. Missing files are treated as absent (empty), never as
 * errors — a fresh checkout may not have them yet.
 */
export async function scanAppConfig(
  appRoot: URL,
  options: {
    /** Backend chosen for this run (`--object-storage`); counts as asking for object storage. */
    objectStorage?: ObjectStorageBackend | undefined;
    /** Exclusions for this run (`--exclude`), on top of `package.json#sail.exclude`. */
    exclude?: SailExclude[] | undefined;
  } = {},
): Promise<AppScan> {
  const appRootPath = fileURLToPath(appRoot);

  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(join(appRootPath, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    dependencies = {};
  }

  let envTs: string | null = null;
  try {
    envTs = await readFile(join(appRootPath, 'start', 'env.ts'), 'utf8');
  } catch {
    envTs = null;
  }

  const configs: Record<string, string> = {};
  try {
    for (const file of await readdir(join(appRootPath, 'config'))) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) {
        continue;
      }
      try {
        configs[file] = await readFile(join(appRootPath, 'config', file), 'utf8');
      } catch {
        // unreadable file — skip it
      }
    }
  } catch {
    // no config dir — fresh checkout
  }

  const [migrations, sailConfig] = await Promise.all([
    readMigrations(join(appRootPath, 'database', 'migrations')),
    readSailConfig(appRootPath),
  ]);

  const config: SailConfig = {
    ...sailConfig.config,
    exclude: [...new Set([...sailConfig.config.exclude, ...(options.exclude ?? [])])],
  };
  const scan = scanAppFiles({
    dependencies,
    envTs,
    configs,
    migrations,
    config,
    objectStorage: options.objectStorage,
  });
  scan.notes.push(...sailConfig.problems);
  return scan;
}

/**
 * Every `.ts` / `.js` / `.sql` file below `database/migrations`, keyed by its
 * path relative to that directory. Missing directory → empty.
 */
async function readMigrations(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch {
    return files;
  }
  await Promise.all(
    entries
      .filter((entry) => /\.(ts|js|mjs|cjs|sql)$/.test(entry))
      .map(async (entry) => {
        try {
          files[entry.split('\\').join('/')] = await readFile(join(directory, entry), 'utf8');
        } catch {
          // a directory named like a file, or unreadable — skip it
        }
      }),
  );
  return files;
}

/**
 * Renders an {@link AppScan} as plain human-readable text: per-service
 * evidence, the env.ts coverage (`declared / used / missing`) and notes.
 * Plain text on purpose — no ANSI — so it stays useful when piped.
 */
export function formatAppScan(scan: AppScan): string {
  const lines = ['CONFIG SCAN (start/env.ts + config/*.ts)'];
  if (scan.evidence.length === 0) {
    lines.push('  no signals — neither dependencies nor configs reference a known service');
  } else {
    const byService = new Map<SailServiceName, string[]>();
    for (const entry of scan.evidence) {
      byService.set(entry.service, [...(byService.get(entry.service) ?? []), entry.detail]);
    }
    for (const [service, details] of byService) {
      lines.push(`  ${service} — ${details.join(', ')}`);
    }
  }
  if (scan.missingEnvKeys.length > 0) {
    lines.push(
      `  start/env.ts declares ${scan.declaredEnvKeys.length} keys, configs use ${scan.usedEnvKeys.length}, missing: ${scan.missingEnvKeys.join(', ')}`,
    );
  } else if (scan.usedEnvKeys.length > 0) {
    lines.push(`  start/env.ts covers all ${scan.usedEnvKeys.length} keys the configs use`);
  }
  for (const note of scan.notes) {
    lines.push(`  note: ${note}`);
  }
  return lines.join('\n');
}
