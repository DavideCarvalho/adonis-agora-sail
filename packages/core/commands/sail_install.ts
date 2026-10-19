import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { buildAgentsMdSection, updateAgentsMd } from '../src/agents_md.js';
import {
  type AppScan,
  envValidationFor,
  formatAppScan,
  objectStorageSetupNote,
  scanAppConfig,
} from '../src/app_scan.js';
import {
  generateComposeFile,
  mergeComposeFile,
  serviceImageInComposeFile,
  servicesInComposeFile,
} from '../src/compose_file.js';
import {
  DOTENV_EXAMPLE_FILE_NAME,
  DOTENV_FILE_NAME,
  ensureTrailingNewline,
  readDotEnvKeySets,
} from '../src/dotenv.js';
import { isPgvectorImage, officialPostgresMajor, resolveServiceImages } from '../src/images.js';
import { appEnvOptionsFromScan, buildStackInfo, formatStackInfo } from '../src/info.js';
import {
  isSailExclude,
  OBJECT_STORAGE_EXCLUDE,
  type SailExclude,
  updateSailConfig,
} from '../src/sail_config.js';
import {
  isObjectStorageBackend,
  isServiceName,
  OBJECT_STORAGE_BACKENDS,
  SERVICE_NAMES,
  SERVICES,
} from '../src/services.js';
import type { ObjectStorageBackend, SailServiceName } from '../src/types.js';
import {
  AUDIT_EXTRA_PATTERNS_NOTE,
  baseAppEnv,
  detectVarlock,
  ensureSchemaSection,
  SCHEMA_FILE_NAME,
} from '../src/varlock.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * Keys sail must not print into the committed `.env.example` — matched by
 * shape, since the app's s3 disk may call its secret `S3_SECRET_KEY`.
 */
const SECRET_LIKE_KEY = /PASSWORD|SECRET/;

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
async function readIfPresent(...pathSegments: string[]): Promise<string | null> {
  try {
    return await readFile(join(...pathSegments), 'utf8');
  } catch {
    return null;
  }
}

export default class SailInstall extends SailBaseCommand {
  static override commandName = 'sail:install';
  static override description = 'Generate a worktree-aware compose.yml for local dev services';
  static override options: CommandOptions = { startApp: false };

  @flags.array({
    description: `Services to enable (${SERVICE_NAMES.join(', ')}). Auto-detected when omitted`,
  })
  declare services?: string[];

  @flags.string({
    description: `Object storage backend (${OBJECT_STORAGE_BACKENDS.join(', ')}) — also asks for object storage. Saved to package.json "sail.objectStorage"`,
  })
  declare objectStorage?: string;

  @flags.array({
    description: `Services auto-detection must leave out (a service name, or "${OBJECT_STORAGE_EXCLUDE}"). Saved to package.json "sail.exclude"`,
  })
  declare exclude?: string[];

  override async run(): Promise<void> {
    const context = await this.sailContext();
    const appRoot = fileURLToPath(this.app.appRoot);

    const preferences = this.#preferences();
    if (!preferences) {
      return;
    }
    const scan = await scanAppConfig(this.app.appRoot, preferences);
    const configAction =
      preferences.objectStorage || preferences.exclude.length > 0
        ? await updateSailConfig(appRoot, preferences)
        : 'unchanged';

    const existingCompose = await readIfPresent(context.composeFilePath);
    const picked = await this.#selectedServices(scan);
    if (!picked) {
      return;
    }
    const notes = [...scan.notes];
    const selected = this.#reconcileObjectStorage(
      picked,
      existingCompose,
      preferences.objectStorage ?? (this.services?.length ? undefined : scan.config.objectStorage),
      notes,
    );
    if (!selected) {
      return;
    }
    const envOptions = appEnvOptionsFromScan(scan);
    const images = resolveServiceImages(scan.config, scan.pgvectorMigration !== null);

    let action: string;
    if (existingCompose !== null) {
      const merged = mergeComposeFile(existingCompose, selected, { images });
      await writeFile(context.composeFilePath, merged.content, 'utf8');
      action =
        merged.added.length > 0
          ? `updated (added ${merged.added.join(', ')})`
          : 'already up to date';
      notes.push(...this.#imageNotes(merged.content, scan, merged.added));
    } else {
      await writeFile(context.composeFilePath, generateComposeFile(selected, { images }), 'utf8');
      action = `created with ${selected.join(', ')}`;
    }

    const agentsMdPath = join(appRoot, 'AGENTS.md');
    const previous = await readIfPresent(agentsMdPath);
    const agentsMd = updateAgentsMd(previous, buildAgentsMdSection());
    const agentsMdAction =
      agentsMd.action === 'kept'
        ? 'kept (edited by hand — delete the section, markers included, to get the stock text back)'
        : agentsMd.action === 'appended'
          ? 'updated'
          : agentsMd.action;
    if (agentsMd.content !== previous) {
      await writeFile(agentsMdPath, agentsMd.content, 'utf8');
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
      const schema = ensureSchemaSection(schemaPrevious, selected, envOptions);
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

    const setupNote = selected.some(isObjectStorageBackend)
      ? objectStorageSetupNote(scan.s3Disk)
      : null;
    if (setupNote && !notes.includes(setupNote)) {
      notes.push(setupNote);
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
        config: configAction,
        varlock: varlockAction,
        env: envWiring,
        notes,
      });
      return;
    }

    const info = buildStackInfo(context, selected, envOptions);
    this.logger.success(`compose.yml ${action} — ${context.composeFilePath}`);
    this.logger.log(formatAppScan(scan));
    this.logger.info(`AGENTS.md ${agentsMdAction}`);
    if (configAction === 'updated') {
      this.logger.info('package.json "sail" preferences updated');
    }
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
    const defaults = baseAppEnv(selected, appEnvOptionsFromScan(scan));
    const needed = Object.keys(defaults);
    const validationOf = (key: string) => envValidationFor(key, scan.s3EnvNames);
    const toValidate = needed.filter(
      (key) => !scan.declaredEnvKeys.includes(key) && validationOf(key) !== undefined,
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
        validationsSkipped: `codemods unavailable — add to start/env.ts by hand: ${toValidate.map((key) => `${key}: ${validationOf(key)}`).join('; ')}`,
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
            toValidate.map((key) => [key, validationOf(key) as string]),
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
        result.validationsSkipped = `not written — add to start/env.ts by hand: ${toValidate.map((key) => `${key}: ${validationOf(key)}`).join('; ')}`;
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
          { omitFromExample: toDefine.filter((key) => SECRET_LIKE_KEY.test(key)) },
        );
      } catch {
        // handled below
      }
      const after = await Promise.all([
        readIfPresent(appRoot, DOTENV_FILE_NAME),
        readIfPresent(appRoot, DOTENV_EXAMPLE_FILE_NAME),
      ]);
      // The codemods' editor joins lines without a final newline, so the
      // next `echo KEY=value >> .env` would glue onto the last key sail
      // wrote. Only files the codemod actually changed are touched.
      await Promise.all(
        [DOTENV_FILE_NAME, DOTENV_EXAMPLE_FILE_NAME].map(async (file, index) => {
          const content = after[index];
          if (content && content !== before[index]) {
            const terminated = ensureTrailingNewline(content);
            if (terminated !== content) {
              await writeFile(join(appRoot, file), terminated, 'utf8');
              after[index] = terminated;
            }
          }
        }),
      );
      if (after.some((content, index) => content !== null && content !== before[index])) {
        result.variables = toDefine;
      } else {
        result.variablesSkipped = `not written — add to .env by hand: ${toDefine.map((key) => `${key}=${defaults[key]}`).join(' ')}`;
      }
    }

    return result;
  }

  /**
   * Validates `--object-storage` / `--exclude`. Undefined (after failing the
   * command) when either names something sail does not know.
   */
  #preferences():
    | { objectStorage: ObjectStorageBackend | undefined; exclude: SailExclude[] }
    | undefined {
    if (this.objectStorage !== undefined && !isObjectStorageBackend(this.objectStorage)) {
      this.failJsonAware(
        `Unknown object storage backend: ${this.objectStorage}`,
        `Valid backends: ${OBJECT_STORAGE_BACKENDS.join(', ')}`,
      );
      return undefined;
    }
    const unknown = (this.exclude ?? []).filter((entry) => !isSailExclude(entry));
    if (unknown.length > 0) {
      this.failJsonAware(
        `Unknown service(s) to exclude: ${unknown.join(', ')}`,
        `Valid: ${[...SERVICE_NAMES, OBJECT_STORAGE_EXCLUDE].join(', ')}`,
      );
      return undefined;
    }
    return {
      objectStorage: this.objectStorage,
      exclude: (this.exclude ?? []).filter(isSailExclude),
    };
  }

  /**
   * One object storage backend per stack. When compose.yml already runs one,
   * that one stays — sail never deletes a service, and two backends would
   * fight over the same env keys. Asking for a different one explicitly
   * (`--object-storage`, `sail.objectStorage`, `--services`) gets the steps
   * to switch instead. Undefined (after failing) when `--services` names two.
   */
  #reconcileObjectStorage(
    selected: SailServiceName[],
    existingCompose: string | null,
    wanted: ObjectStorageBackend | undefined,
    notes: string[],
  ): SailServiceName[] | undefined {
    const backends = selected.filter(isObjectStorageBackend);
    if (backends.length > 1) {
      this.failJsonAware(
        `Pick one object storage backend, not ${backends.join(' and ')}`,
        `e.g. node ace sail:install --object-storage=${backends[0]}`,
      );
      return undefined;
    }
    const present = existingCompose
      ? servicesInComposeFile(existingCompose).find(isObjectStorageBackend)
      : undefined;
    const requested = backends[0];
    if (!present || !requested || requested === present) {
      return selected;
    }
    if (wanted === requested || this.services?.includes(requested)) {
      notes.push(
        `compose.yml already runs ${present} for object storage — to switch to ${requested}, remove the ${present} service and its sail-${present} volume from compose.yml (\`node ace sail:down\` first), then re-run install`,
      );
    }
    return selected.map((name) => (name === requested ? present : name));
  }

  /**
   * Hints about images sail cannot change in an existing compose file: a
   * pgvector migration on plain Postgres, and MinIO's withdrawn image.
   */
  #imageNotes(compose: string, scan: AppScan, added: SailServiceName[]): string[] {
    const notes: string[] = [];
    const postgres = added.includes('postgres')
      ? null
      : serviceImageInComposeFile(compose, 'postgres');
    if (postgres && scan.pgvectorMigration && !isPgvectorImage(postgres)) {
      const major = officialPostgresMajor(postgres);
      notes.push(
        `database/migrations/${scan.pgvectorMigration} creates the pgvector extension, but compose.yml runs ${postgres} — set its image to ${major ? `pgvector/pgvector:pg${major}` : 'a pgvector build of the same major'} (same data layout, the volume keeps working)`,
      );
    }
    const minio = added.includes('minio') ? null : serviceImageInComposeFile(compose, 'minio');
    if (minio && /^(?:docker\.io\/)?minio\/minio(?::|$)/.test(minio)) {
      notes.push(
        `compose.yml runs ${minio}, which MinIO no longer publishes — a machine without it cached cannot pull it. Switch the image to ${SERVICES.minio.image}, or move to another backend (see --object-storage)`,
      );
    }
    return notes;
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
