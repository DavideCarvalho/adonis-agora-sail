import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { buildAgentsMdSection, upsertAgentsMd } from '../src/agents_md.js';
import {
  type AppScan,
  ENV_VALIDATIONS,
  formatAppScan,
  MINIO_SETUP_NOTE,
  scanAppConfig,
} from '../src/app_scan.js';
import { generateComposeFile, mergeComposeFile } from '../src/compose_file.js';
import { DOTENV_EXAMPLE_FILE_NAME, DOTENV_FILE_NAME, readDotEnvKeySets } from '../src/dotenv.js';
import { buildStackInfo, formatStackInfo } from '../src/info.js';
import { isServiceName, SERVICE_NAMES, SERVICES } from '../src/services.js';
import type { SailServiceName } from '../src/types.js';
import {
  AUDIT_EXTRA_PATTERNS_NOTE,
  baseAppEnv,
  detectVarlock,
  ensureSchemaSection,
  SCHEMA_FILE_NAME,
} from '../src/varlock.js';
import { SailBaseCommand } from './sail_base_command.js';

/** Keys sail must not print into the committed `.env.example`. */
const SECRET_LIKE_KEYS = ['DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'REDIS_PASSWORD'];

/**
 * `node ace sail:install [--services=postgres --services=redis]` — generates
 * (or merges into) the app's `compose.yml` and wires the app to reach it.
 *
 * Service selection, in order: explicit `--services` flags win; otherwise the
 * command scans `package.json` + `start/env.ts` + `config/*.ts` (`pg` dep or a
 * `client: 'pg'` in `config/database.ts` → postgres, `config/redis.ts` →
 * redis, … including active `store: 'lucid'` selections in `@adonis-agora/*`
 * configs); when the scan finds nothing and the session is interactive, it
 * offers a multi-select. Inside an AI agent it never prompts — it fails with
 * the exact flags to re-run instead.
 *
 * Wiring, all append-only:
 *
 * - `start/env.ts`: missing connection validations via the codemods
 *   (`DB_HOST`, `DB_PORT`, … with the stock first-party shapes). Keys sail
 *   has no stock shape for (`MAIL_MAILER`, `DRIVE_DISK`) are reported, never
 *   guessed.
 * - `.env` / `.env.example`: main-checkout defaults for keys missing from
 *   both files. Existing values are never overwritten — `EnvEditor.add`
 *   replaces in place, so install only hands it keys that are absent.
 * - `.env.schema` (varlock users): the services' connection keys, same
 *   append-only rule.
 *
 * The generated compose file is worktree-agnostic on purpose: host ports
 * interpolate `${SAIL_*_PORT:-base}` so the committed file is identical
 * everywhere; live per-worktree ports land in `.env.local` via `sail:up` /
 * `sail:sync-env`, and a bare `docker compose up` still works with the
 * defaults. Re-running install only ever appends missing pieces — hand edits
 * are preserved. Docker itself is not required for this command.
 */
/**
 * A logger the codemods can report into without anything reaching stdout.
 * Covers exactly the surface they use — `action`, `await`, `fatal`,
 * `getColors`, `log`, `success`, `warning` — and keeps real colors, since
 * they format strings with them.
 */
function mutedLogger(source: { getColors: () => unknown }) {
  const noop = () => {};
  return {
    action: () => ({ succeeded: noop, failed: noop, skipped: noop, displayDuration: noop }),
    await: noop,
    fatal: noop,
    getColors: () => source.getColors(),
    log: noop,
    success: noop,
    warning: noop,
  };
}

/**
 * File contents, or null when it does not exist. Used to tell "the codemod
 * edited this" from "the codemod reported success and wrote nothing".
 */
async function readIfPresent(appRoot: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(appRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
}

export default class SailInstall extends SailBaseCommand {
  static override commandName = 'sail:install';
  static override description = 'Generate a worktree-aware compose.yml for local dev services';
  static override options: CommandOptions = { startApp: false };

  @flags.array({
    description:
      'Services to enable (postgres, mysql, redis, mailpit, minio). Auto-detected when omitted',
  })
  declare services?: string[];

  override async run(): Promise<void> {
    const context = await this.sailContext();
    const scan = await scanAppConfig(this.app.appRoot);
    const selected = await this.#selectedServices(scan);
    if (!selected) {
      return;
    }

    let action: string;
    try {
      const existing = await readFile(context.composeFilePath, 'utf8');
      const merged = mergeComposeFile(existing, selected);
      await writeFile(context.composeFilePath, merged.content, 'utf8');
      action =
        merged.added.length > 0
          ? `updated (added ${merged.added.join(', ')})`
          : 'already up to date';
    } catch {
      await writeFile(context.composeFilePath, generateComposeFile(selected), 'utf8');
      action = `created with ${selected.join(', ')}`;
    }

    const agentsMdPath = join(fileURLToPath(this.app.appRoot), 'AGENTS.md');
    let previous: string | null = null;
    try {
      previous = await readFile(agentsMdPath, 'utf8');
    } catch {
      previous = null;
    }
    const agentsMd = upsertAgentsMd(previous, buildAgentsMdSection());
    const agentsMdAction =
      agentsMd === previous ? 'unchanged' : previous === null ? 'created' : 'updated';
    if (agentsMd !== previous) {
      await writeFile(agentsMdPath, agentsMd, 'utf8');
    }

    let varlockAction = 'skipped (no varlock detected)';
    let varlockNote: string | undefined;
    const varlock = await detectVarlock(this.app.appRoot);
    if (varlock.inUse) {
      const schemaPath = join(fileURLToPath(this.app.appRoot), SCHEMA_FILE_NAME);
      let schemaPrevious: string | null = null;
      try {
        schemaPrevious = await readFile(schemaPath, 'utf8');
      } catch {
        schemaPrevious = null;
      }
      const schema = ensureSchemaSection(schemaPrevious, selected);
      const changes: string[] = [];
      if (schema.added.length > 0) {
        changes.push(`added ${schema.added.join(', ')}`);
      }
      if (schema.auditPatterns === 'inserted') {
        changes.push('added varlock audit patterns');
      }
      varlockAction =
        schema.content === schemaPrevious
          ? 'unchanged'
          : schemaPrevious === null
            ? `created (declares ${schema.added.join(', ')})`
            : `updated (${changes.join('; ')})`;
      // No `# ---` divider to insert above: sail refuses to add one (it would
      // turn the file's leading comments into root decorators) and reports the
      // lines instead, like MAIL_MAILER / DRIVE_DISK.
      if (schema.auditPatterns === 'manual') {
        varlockNote = AUDIT_EXTRA_PATTERNS_NOTE;
      }
      if (schema.content !== schemaPrevious) {
        await writeFile(schemaPath, schema.content, 'utf8');
      }
    }

    const envWiring = await this.#wireEnv(scan, selected);

    const notes = [...scan.notes];
    if (selected.includes('minio') && !notes.includes(MINIO_SETUP_NOTE)) {
      notes.push(MINIO_SETUP_NOTE);
    }
    if (varlockNote && !notes.includes(varlockNote)) {
      notes.push(varlockNote);
    }

    if (this.wantsJson) {
      this.printJson({
        composeFile: context.composeFilePath,
        compose: action,
        services: selected,
        detection: scan.evidence,
        projectName: context.projectName,
        portOffset: context.portOffset,
        agentsMd: agentsMdAction,
        varlock: varlockAction,
        env: envWiring,
        notes,
      });
      return;
    }

    const info = buildStackInfo(context, selected);
    this.logger.success(`compose.yml ${action} — ${context.composeFilePath}`);
    this.logger.log(formatAppScan(scan));
    this.logger.info(`AGENTS.md ${agentsMdAction}`);
    this.logger.info(`varlock schema ${varlockAction}`);
    this.logger.info(
      `start/env.ts validations ${envWiring.validations.length > 0 ? `added (${envWiring.validations.join(', ')})` : (envWiring.validationsSkipped ?? 'unchanged')}`,
    );
    this.logger.info(
      `.env/.env.example ${envWiring.variables.length > 0 ? `defaults added (${envWiring.variables.join(', ')})` : (envWiring.variablesSkipped ?? 'unchanged')}`,
    );
    for (const note of notes) {
      this.logger.info(`note: ${note}`);
    }
    this.logger.log(formatStackInfo(info));
    this.logger.info('Next: node ace sail:up');
  }

  /**
   * Adds the missing `start/env.ts` validations and `.env`/`.env.example`
   * defaults for the selected services. Only keys absent from the target
   * file are handed to the codemods — existing declarations and values
   * (including hand-tuned ports and passwords) are never overwritten.
   * Codemod failures degrade to a printed snippet instead of failing the
   * install: env wiring must never block the compose file.
   */
  async #wireEnv(
    scan: AppScan,
    selected: SailServiceName[],
  ): Promise<{
    validations: string[];
    variables: string[];
    validationsSkipped?: string | undefined;
    variablesSkipped?: string | undefined;
  }> {
    const appRoot = fileURLToPath(this.app.appRoot);
    const defaults = baseAppEnv(selected);
    const needed = Object.keys(defaults);
    const toValidate = needed.filter(
      (key) => !scan.declaredEnvKeys.includes(key) && key in ENV_VALIDATIONS,
    );

    let dotEnvKeys = { env: new Set<string>(), example: new Set<string>() };
    try {
      dotEnvKeys = await readDotEnvKeySets(appRoot);
    } catch {
      // unreadable — treat every key as missing and let the codemods sort it out
    }
    const toDefine = needed.filter(
      (key) => !dotEnvKeys.env.has(key) && !dotEnvKeys.example.has(key),
    );

    if (toValidate.length === 0 && toDefine.length === 0) {
      return { validations: [], variables: [] };
    }

    let codemods: Awaited<ReturnType<SailBaseCommand['createCodemods']>> | undefined;
    try {
      codemods = await this.createCodemods();
      // The codemods report progress through the command's logger, which is
      // right for a human and fatal under `--json`, where stdout has to stay
      // one parseable document. `useLogger` is their own escape hatch for it.
      if (this.wantsJson) {
        // `useLogger` is typed for a full cliui `Logger`; the codemods only
        // ever call the handful of methods this stub implements.
        codemods.useLogger(mutedLogger(this.logger) as unknown as typeof this.logger);
      }
    } catch {
      const skipped: {
        validations: string[];
        variables: string[];
        validationsSkipped?: string | undefined;
        variablesSkipped?: string | undefined;
      } = {
        validations: [],
        variables: [],
        validationsSkipped: `codemods unavailable — add to start/env.ts by hand: ${toValidate.map((key) => `${key}: ${ENV_VALIDATIONS[key]}`).join('; ')}`,
        variablesSkipped:
          toDefine.length > 0
            ? `codemods unavailable — add to .env by hand: ${toDefine.map((key) => `${key}=${defaults[key]}`).join(' ')}`
            : undefined,
      };
      return skipped;
    }

    const result: {
      validations: string[];
      variables: string[];
      validationsSkipped?: string;
      variablesSkipped?: string;
    } = { validations: [], variables: [] };

    if (toValidate.length > 0) {
      const before = await readIfPresent(appRoot, 'start/env.ts');
      try {
        await codemods.defineEnvValidations({
          leadingComment: 'Variables for @adonis-agora/sail local services',
          variables: Object.fromEntries(
            toValidate.map((key) => [key, ENV_VALIDATIONS[key] as string]),
          ),
        });
      } catch {
        // handled below — the on-disk check is what decides either way
      }
      // The codemods catch their own failures (a missing `Env.create`, an
      // absent code transformer) and report them through the logger instead of
      // throwing, so trusting "it did not throw" is how sail ended up claiming
      // it had edited a file it never touched.
      const after = await readIfPresent(appRoot, 'start/env.ts');
      if (after !== null && after !== before) {
        result.validations = toValidate;
      } else {
        result.validationsSkipped = `not written — add to start/env.ts by hand: ${toValidate.map((key) => `${key}: ${ENV_VALIDATIONS[key]}`).join('; ')}`;
      }
    }

    if (toDefine.length > 0) {
      const before = await Promise.all([
        readIfPresent(appRoot, DOTENV_FILE_NAME),
        readIfPresent(appRoot, DOTENV_EXAMPLE_FILE_NAME),
      ]);
      try {
        await codemods.defineEnvVariables(
          Object.fromEntries(toDefine.map((key) => [key, defaults[key] as string])),
          { omitFromExample: SECRET_LIKE_KEYS.filter((key) => toDefine.includes(key)) },
        );
      } catch {
        // handled below
      }
      const after = await Promise.all([
        readIfPresent(appRoot, DOTENV_FILE_NAME),
        readIfPresent(appRoot, DOTENV_EXAMPLE_FILE_NAME),
      ]);
      if (after.some((content, index) => content !== null && content !== before[index])) {
        result.variables = toDefine;
      } else {
        result.variablesSkipped = `not written — add to .env by hand: ${toDefine.map((key) => `${key}=${defaults[key]}`).join(' ')}`;
      }
    }

    return result;
  }

  async #selectedServices(scan: AppScan): Promise<SailServiceName[] | undefined> {
    if (this.services && this.services.length > 0) {
      const unknown = this.services.filter((service) => !isServiceName(service));
      if (unknown.length > 0) {
        this.failJsonAware(
          `Unknown service(s): ${unknown.join(', ')}`,
          `Valid services: ${SERVICE_NAMES.join(', ')}`,
        );
        return undefined;
      }
      return this.services.filter(isServiceName);
    }

    if (scan.services.length > 0) {
      return scan.services;
    }

    if (!this.canPrompt) {
      this.failJsonAware(
        'Could not detect any service from package.json or config/*.ts',
        `Re-run with explicit services, e.g. node ace sail:install --services=postgres --services=redis (valid: ${SERVICE_NAMES.join(', ')})`,
      );
      return undefined;
    }

    try {
      const picked = await this.prompt.multiple(
        'Select the services to run locally',
        SERVICE_NAMES.map((name) => ({ name, message: `${name} — ${SERVICES[name].summary}` })),
      );
      if (picked.length === 0) {
        this.logger.warning('No services selected — nothing to do.');
        return undefined;
      }
      return picked as SailServiceName[];
    } catch {
      this.failJsonAware(
        'Service selection was aborted',
        `Re-run with explicit services, e.g. node ace sail:install --services=postgres (valid: ${SERVICE_NAMES.join(', ')})`,
      );
      return undefined;
    }
  }
}
