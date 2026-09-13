import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectServicesFromDependencies } from './detect.js';
import { SERVICE_NAMES, SERVICES } from './services.js';
import type { SailServiceName } from './types.js';

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
 * Setup hint shown whenever minio is selected: stock `drive.stub` has no
 * endpoint var, so MinIO needs a one-line passthrough plus a bucket.
 */
export const MINIO_SETUP_NOTE =
  "MinIO: add `endpoint: env.get('S3_ENDPOINT')` to the s3 disk in config/drive.ts and create the 'local' bucket in the MinIO console";

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
  /** Human hints: sqlite, memory stores, MinIO endpoint, unmapped missing keys… */
  notes: string[];
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
  AWS_ACCESS_KEY_ID: 'Env.schema.string()',
  AWS_SECRET_ACCESS_KEY: 'Env.schema.string()',
  AWS_REGION: 'Env.schema.string()',
  S3_BUCKET: 'Env.schema.string()',
  S3_ENDPOINT: "Env.schema.string({ format: 'url', tld: false })",
};

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

  for (const name of detectServicesFromDependencies(input.dependencies)) {
    const hit = SERVICES[name].detectedBy.find((dep) => dep in input.dependencies) ?? 'dependency';
    pushEvidence(evidence, { service: name, via: 'dependency', detail: `package.json:${hit}` });
  }

  const declaredEnvKeys = input.envTs ? parseEnvTsKeys(input.envTs) : [];
  const usedKeys = new Set<string>();

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
    for (const key of parseEnvGets(stripped)) {
      usedKeys.add(key);
    }

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
      if (
        /services\.s3\(|disks\.s3\(|disk\s*:\s*['"]s3['"]/.test(stripped) ||
        /AWS_ACCESS_KEY_ID|S3_BUCKET|S3_ENDPOINT/.test(stripped)
      ) {
        pushEvidence(evidence, { service: 'minio', via: 'config', detail: `${file}:s3 disk` });
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
    if (/disks\.s3\(|services\.s3\(|disk\s*:\s*['"]s3['"]/.test(stripped)) {
      agora.push({ file, service: 'minio', detail: 's3 disk' });
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

  // `DRIVE_DISK` enums that admit `s3` mean the app can point at MinIO.
  if (input.envTs) {
    const driveDiskLine = stripComments(input.envTs)
      .split('\n')
      .find((line) => line.includes('DRIVE_DISK'));
    if (driveDiskLine?.includes("'s3'") || driveDiskLine?.includes('"s3"')) {
      pushEvidence(evidence, {
        service: 'minio',
        via: 'env',
        detail: 'start/env.ts:DRIVE_DISK allows s3',
      });
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
  if (
    usedKeys.has('AWS_ACCESS_KEY_ID') ||
    usedKeys.has('S3_BUCKET') ||
    usedKeys.has('S3_ENDPOINT')
  ) {
    pushEvidence(evidence, { service: 'minio', via: 'config', detail: 'S3 env reads' });
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
  const vetoDepOnly = (service: SailServiceName, reason: string) => {
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
    notes.push(`package.json lists ${depDetails.join(', ')} but ${reason} — skipping ${service}`);
  };

  if (dbRaw && dbClient && dbClient !== 'pg') {
    vetoDepOnly('postgres', `config/database.ts uses ${dbClient}`);
  }
  if (dbRaw && dbClient && dbClient !== 'mysql') {
    vetoDepOnly('mysql', `config/database.ts uses ${dbClient}`);
  }
  if ('drive.ts' in configs || 'drive.js' in configs) {
    vetoDepOnly('minio', 'config/drive.ts has no s3 disk');
  }
  if ('mail.ts' in configs || 'mail.js' in configs) {
    vetoDepOnly('mailpit', 'config/mail.ts has no smtp mailer');
  }

  const { services, dropped } = mergeServices(
    evidence.map((entry) => entry.service),
    dbClient,
  );

  const usedEnvKeys = [...usedKeys].sort();
  const missingEnvKeys = usedEnvKeys.filter((key) => !declaredEnvKeys.includes(key));

  const unmappedMissing = missingEnvKeys.filter(
    (key) => !(key in ENV_VALIDATIONS) && !FRAMEWORK_ENV_KEYS.includes(key),
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

  if (services.includes('minio')) {
    notes.push(MINIO_SETUP_NOTE);
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
export async function scanAppConfig(appRoot: URL): Promise<AppScan> {
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

  return scanAppFiles({ dependencies, envTs, configs });
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
