import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveHostPorts } from './ports.js';
import { SERVICES } from './services.js';
import type { SailServiceDefinition, SailServiceName } from './types.js';

export const SCHEMA_FILE_NAME = '.env.schema';
export const LOCAL_ENV_FILE_NAME = '.env.local';
export const GITIGNORE_FILE_NAME = '.gitignore';

/** Markers wrapping the sail-managed section inside `.env.schema`. */
export const SAIL_SCHEMA_START = '# sail:schema:start';
export const SAIL_SCHEMA_END = '# sail:schema:end';

/** Markers wrapping the sail-managed block inside `.env.local`. */
export const SAIL_ENV_START = '# sail:start';
export const SAIL_ENV_END = '# sail:end';

/**
 * The divider separating a varlock schema's root section (file-level
 * decorators) from its items. Decorators below it attach to the item that
 * follows, so sail only ever writes root decorators above it.
 */
export const SCHEMA_ROOT_DIVIDER = '# ---';

/**
 * Root decorators teaching `varlock audit`'s code scanner how an AdonisJS app
 * reads env. The built-in patterns only see bare `process.env.X`-style
 * identifiers, which an Adonis app never writes — without these, every key in
 * the schema is reported as unreferenced.
 *
 * Two calls (they merge additively, like `@auditIgnorePaths`) so each idiom
 * keeps its own explanation. The **first capture group is the env key**; the
 * `regex('...')` form is mandatory because a bare `/.../` decorator arg cannot
 * contain spaces, commas or parens. No `fileTypes=[...]`: omitting it covers
 * the extensions the scanner already reads, `.ts` and `.js` included. No
 * `^`/`$` anchors either — the scan runs without the `m` flag.
 */
export const AUDIT_EXTRA_PATTERNS_LINES: readonly string[] = [
  '# env.get(\'KEY\') / env.get("KEY") — how config/*.ts and app code read env',
  String.raw`# @auditExtraPatterns(regex('env\.get\(\s*\'([A-Z][A-Z0-9_]*)\''), regex('env\.get\(\s*"([A-Z][A-Z0-9_]*)"'))`,
  '# KEY: Env.schema.…() — start/env.ts declarations, for keys only the framework reads',
  String.raw`# @auditExtraPatterns(regex('([A-Z][A-Z0-9_]*)\s*:\s*Env\.schema\.'))`,
];

/**
 * Reported (never applied) when the schema has no `# ---` divider: inserting
 * one would silently turn the file's leading comments into root decorators,
 * so the operator gets the lines and the place to put them instead.
 */
export const AUDIT_EXTRA_PATTERNS_NOTE = [
  `varlock audit: ${SCHEMA_FILE_NAME} has no \`${SCHEMA_ROOT_DIVIDER}\` root divider, so sail did not add the Adonis env access patterns — adding the divider itself would reinterpret your leading comments as root decorators. Add \`${SCHEMA_ROOT_DIVIDER}\` above the first item, then these lines just above it:`,
  ...AUDIT_EXTRA_PATTERNS_LINES,
].join('\n');

/** How `ensureSchemaSection` handled the `@auditExtraPatterns` decorators. */
export type AuditPatternsAction = 'created' | 'inserted' | 'present' | 'manual';

/**
 * True when the schema already declares `@auditExtraPatterns` anywhere —
 * sail's own line or a hand-written one. Either way sail keeps its hands off:
 * calls merge additively, so a second copy would double every scan.
 */
export function hasAuditExtraPatterns(content: string): boolean {
  return content.includes('@auditExtraPatterns');
}

/** Index of the root/items divider line, or -1 when the schema has none. */
function dividerLineIndex(lines: string[]): number {
  return lines.findIndex((line) => /^#\s*-{3,}$/.test(line.trim()));
}

/**
 * Adds the audit patterns to an existing schema body, immediately above its
 * `# ---` divider. Three outcomes, all non-destructive: `present` (the file
 * already declares `@auditExtraPatterns`, left byte-identical), `inserted`,
 * or `manual` — no divider to insert above, so the body is returned unchanged
 * and the caller reports `AUDIT_EXTRA_PATTERNS_NOTE`.
 */
export function ensureAuditExtraPatterns(existing: string): {
  content: string;
  action: Exclude<AuditPatternsAction, 'created'>;
} {
  if (hasAuditExtraPatterns(existing)) {
    return { content: existing, action: 'present' };
  }

  const lines = existing.split('\n');
  const divider = dividerLineIndex(lines);
  if (divider === -1) {
    return { content: existing, action: 'manual' };
  }

  lines.splice(divider, 0, ...AUDIT_EXTRA_PATTERNS_LINES);
  return { content: lines.join('\n'), action: 'inserted' };
}

export interface VarlockDetection {
  /** True when the app uses varlock: `.env.schema` exists or `varlock` is a dependency. */
  inUse: boolean;
  /** Absolute path to `.env.schema`, or null when only the dependency was found. */
  schemaPath: string | null;
  via: 'schema' | 'dependency' | null;
}

/**
 * Detects whether the app uses varlock. Both signals count: a committed
 * `.env.schema`, or the `varlock` package in dependencies/devDependencies
 * (covers teams mid-migration whose schema is not written yet).
 */
export async function detectVarlock(appRoot: URL): Promise<VarlockDetection> {
  const appRootPath = fileURLToPath(appRoot);
  const schemaPath = join(appRootPath, SCHEMA_FILE_NAME);

  let hasSchema = false;
  try {
    await readFile(schemaPath, 'utf8');
    hasSchema = true;
  } catch {
    hasSchema = false;
  }

  let hasDependency = false;
  try {
    const pkg = JSON.parse(await readFile(join(appRootPath, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    hasDependency =
      'varlock' in (pkg.dependencies ?? {}) || 'varlock' in (pkg.devDependencies ?? {});
  } catch {
    hasDependency = false;
  }

  return {
    inUse: hasSchema || hasDependency,
    schemaPath: hasSchema ? schemaPath : null,
    via: hasSchema ? 'schema' : hasDependency ? 'dependency' : null,
  };
}

/**
 * Union of the env keys the given services need the app to set, in service
 * order. Values never depend on ports — only the keys are read here.
 */
export function sailEnvKeys(services: SailServiceName[]): string[] {
  const keys: string[] = [];
  for (const name of services) {
    for (const key of Object.keys(SERVICES[name].appEnv({}))) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * The app env for the main checkout (offset 0): schema defaults and the
 * values `sail:sync-env` writes there. Worktrees resolve the same keys with
 * the worktree offset applied.
 */
export function baseAppEnv(services: SailServiceName[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of services) {
    Object.assign(env, SERVICES[name].appEnv(resolveHostPorts(SERVICES[name].ports, 0)));
  }
  return env;
}

function schemaItemBlock(
  service: SailServiceDefinition,
  key: string,
  value: string,
  withHeader: boolean,
): string {
  const lines = withHeader ? [`# ${service.name} — ${service.summary}`] : [];
  lines.push('# @tag(sail)');
  // Connection coordinates (hosts, ports, bucket names, regions, endpoints)
  // are loopback dev addresses, not secrets: mark them @public so varlock's
  // log redaction does not turn every `127.0.0.1` in terminal output into
  // `lo▒▒▒▒▒`. Credentials (anything the service would reject an impostor
  // with) stay sensitive by default.
  if (!/PASSWORD|SECRET|_KEY/.test(key)) {
    lines.push('# @public');
  }
  if (key.endsWith('_PORT')) {
    lines.push('# @type=number');
  }
  lines.push(`${key}=${value}`);
  return lines.join('\n');
}

/**
 * Builds the sail-managed schema section for the given services: one typed,
 * `@tag(sail)`-tagged item per env key, defaulting to the main-checkout
 * values. The defaults are worktree-agnostic on purpose — live per-worktree
 * ports are written to `.env.local`, which overrides them.
 */
export function buildSchemaSection(services: SailServiceName[]): string {
  const defaults = baseAppEnv(services);
  const blocks: string[] = [];
  for (const name of services) {
    const service = SERVICES[name];
    let first = true;
    for (const key of Object.keys(service.appEnv({}))) {
      blocks.push(schemaItemBlock(service, key, defaults[key] ?? '', first));
      first = false;
    }
  }
  return [
    SAIL_SCHEMA_START,
    '# Managed by @adonis-agora/sail (`node ace sail:install`). Values below are',
    '# main-checkout defaults; live per-worktree ports are written to .env.local.',
    ...blocks,
    SAIL_SCHEMA_END,
  ].join('\n');
}

function presentEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

export interface SchemaSectionResult {
  content: string;
  /** Env keys newly declared by this run. */
  added: string[];
  /** What happened to the `@auditExtraPatterns` root decorators. */
  auditPatterns: AuditPatternsAction;
}

/**
 * Ensures `.env.schema` declares every env key the services need, plus the
 * `@auditExtraPatterns` root decorators that make `varlock audit` see Adonis'
 * env access. Creates a full schema (root section, divider, managed item
 * block) when there is none; otherwise appends only the missing items (inside
 * the managed marker block, creating it when absent) and never touches keys
 * the team already declares — their types and docs win.
 */
export function ensureSchemaSection(
  existing: string | null,
  services: SailServiceName[],
): SchemaSectionResult {
  if (!existing || existing.trim().length === 0) {
    const header = [
      '# Managed by @adonis-agora/sail (`node ace sail:install`).',
      '# Declares the service connection schema with main-checkout defaults.',
      '',
      ...AUDIT_EXTRA_PATTERNS_LINES,
      SCHEMA_ROOT_DIVIDER,
      '',
    ].join('\n');
    const content = `${header}${buildSchemaSection(services)}\n`;
    return { content, added: sailEnvKeys(services), auditPatterns: 'created' };
  }

  const audited = ensureAuditExtraPatterns(existing);
  const body = audited.content;
  const present = presentEnvKeys(body);
  const missing = sailEnvKeys(services).filter((key) => !present.has(key));
  if (missing.length === 0) {
    return { content: body, added: [], auditPatterns: audited.action };
  }

  const defaults = baseAppEnv(services);
  const missingSet = new Set(missing);
  const blocks: string[] = [];
  for (const name of services) {
    const service = SERVICES[name];
    let first = true;
    for (const key of Object.keys(service.appEnv({}))) {
      if (missingSet.has(key)) {
        blocks.push(schemaItemBlock(service, key, defaults[key] ?? '', first));
      }
      first = false;
    }
  }

  const start = body.indexOf(SAIL_SCHEMA_START);
  const end = body.indexOf(SAIL_SCHEMA_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, end).replace(/\n+$/, '\n');
    return {
      content: `${before}${blocks.join('\n')}\n${body.slice(end)}`,
      added: missing,
      auditPatterns: audited.action,
    };
  }

  const separator = body.endsWith('\n') ? '' : '\n';
  return {
    content: `${body}${separator}\n${[SAIL_SCHEMA_START, ...blocks, SAIL_SCHEMA_END].join('\n')}\n`,
    added: missing,
    auditPatterns: audited.action,
  };
}

/**
 * Builds the sail-managed `.env.local` block: the stack's resolved app env
 * (offset applied) as sorted `KEY=value` lines between markers. The block
 * carries the services' fixed dev credentials (`DB_PASSWORD`,
 * `AWS_SECRET_ACCESS_KEY`) next to the ports, which is why the file it lands
 * in is kept git-ignored.
 */
export function buildSailEnvBlock(appEnv: Record<string, string>): string {
  const lines = Object.entries(appEnv)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return [
    SAIL_ENV_START,
    '# Managed by @adonis-agora/sail — per-worktree service ports. Do not edit;',
    '# re-run `node ace sail:sync-env` to refresh.',
    ...lines,
    SAIL_ENV_END,
  ].join('\n');
}

/**
 * Replaces the sail-managed block in a `.env.local` body, or appends it when
 * the markers are absent. Everything outside the markers is preserved, so
 * re-running is a no-op when ports did not change.
 */
export function upsertSailEnvBlock(existing: string | null, block: string): string {
  if (!existing || existing.trim().length === 0) {
    return `${block}\n`;
  }

  const start = existing.indexOf(SAIL_ENV_START);
  const end = existing.indexOf(SAIL_ENV_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + SAIL_ENV_END.length)}`;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

/**
 * Heuristic for an encrypted `.env.local` (ciphertext entries look like
 * `KEY=varlock(local:...)`): sail must not append plaintext there. Callers
 * skip the sync with a warning when this returns true.
 */
export function isEncryptedEnvContent(content: string): boolean {
  return content.includes('varlock(');
}

/**
 * Ensures a `.gitignore` body ignores the given entry (default
 * `.env.local`), creating the body when missing. Exact-line match, so
 * similarly-named entries (e.g. `.env.local.example`) do not count.
 */
export function ensureGitignoreEntry(
  existing: string | null,
  entry: string = LOCAL_ENV_FILE_NAME,
): { content: string; changed: boolean } {
  if (!existing || existing.trim().length === 0) {
    return { content: `${entry}\n`, changed: true };
  }
  const ignored = existing
    .split('\n')
    .some((line) => line.trim() === entry || line.trim() === `/${entry}`);
  if (ignored) {
    return { content: existing, changed: false };
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  return { content: `${existing}${separator}${entry}\n`, changed: true };
}

export interface SailEnvSyncResult {
  action: 'created' | 'updated' | 'unchanged' | 'skipped-encrypted';
  gitignore: 'updated' | 'unchanged';
  localFilePath: string;
}

/**
 * Syncs the stack's resolved app env into the sail-managed block of
 * `.env.local` (creating the file when missing) and ensures the file is
 * git-ignored. Skips — without failing — when `.env.local` is encrypted:
 * appending plaintext next to ciphertext would corrupt it, so the operator
 * gets a warning pointing at `sail:info --env` instead.
 */
export async function syncSailLocalEnv(
  appRootPath: string,
  appEnv: Record<string, string>,
): Promise<SailEnvSyncResult> {
  const localFilePath = join(appRootPath, LOCAL_ENV_FILE_NAME);

  let previous: string | null = null;
  try {
    previous = await readFile(localFilePath, 'utf8');
  } catch {
    previous = null;
  }

  const gitignorePath = join(appRootPath, GITIGNORE_FILE_NAME);
  let gitignorePrevious: string | null = null;
  try {
    gitignorePrevious = await readFile(gitignorePath, 'utf8');
  } catch {
    gitignorePrevious = null;
  }
  const gitignore = ensureGitignoreEntry(gitignorePrevious);
  let gitignoreAction: SailEnvSyncResult['gitignore'] = 'unchanged';
  if (gitignore.changed) {
    await writeFile(gitignorePath, gitignore.content, 'utf8');
    gitignoreAction = 'updated';
  }

  if (previous && isEncryptedEnvContent(previous)) {
    return { action: 'skipped-encrypted', gitignore: gitignoreAction, localFilePath };
  }

  const next = upsertSailEnvBlock(previous, buildSailEnvBlock(appEnv));
  if (next === previous) {
    return { action: 'unchanged', gitignore: gitignoreAction, localFilePath };
  }
  await writeFile(localFilePath, next, 'utf8');
  return {
    action: previous === null ? 'created' : 'updated',
    gitignore: gitignoreAction,
    localFilePath,
  };
}
