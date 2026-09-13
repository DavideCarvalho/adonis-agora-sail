import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories';
import { describe, expect, it } from 'vitest';

import SailInstall from '../commands/sail_install.js';
import { type AppScan, scanAppConfig } from '../src/app_scan.js';
import { logs } from './helpers/ace.js';

/**
 * Detection reads whole application trees, so these fixtures are directories
 * of real files rather than the inline strings `app_scan.spec.ts` uses — see
 * `fixtures/apps/README.md` for where each tree came from.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apps');

/**
 * The app-root tsconfig the AdonisJS codemods need before they will touch
 * `start/env.ts`. A real app's `extends: "@adonisjs/tsconfig/…"` cannot
 * resolve in a temp directory with no `node_modules`, so the copy gets a
 * self-contained equivalent — nothing sail reads, purely what ts-morph needs.
 */
const APP_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ESNext' },
    include: ['**/*'],
  },
  null,
  2,
)}\n`;

function fixtureRoot(name: string): URL {
  return pathToFileURL(`${join(FIXTURES, name)}/`);
}

/**
 * Copies a fixture tree into a throwaway root. The shared `createTestApp`
 * writes flat files; an app is nested (`start/`, `config/`) and `sail:install`
 * writes back into the tree, so every scenario needs its own copy.
 *
 * The trees commit `.env.example` only (see the fixtures README), so the copy
 * also performs the `cp .env.example .env` every AdonisJS setup starts with —
 * `withDotEnv: false` skips it to exercise a checkout that has not.
 */
async function materializeApp(name: string, withDotEnv = true): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `sail-app-${name}-`));
  await cp(join(FIXTURES, name), path, { recursive: true });
  await writeFile(join(path, 'tsconfig.json'), APP_TSCONFIG, 'utf8');
  if (withDotEnv) {
    await cp(join(path, '.env.example'), join(path, '.env'));
  }
  return path;
}

interface InstallRun {
  exitCode: number;
  payload: Record<string, unknown>;
}

/**
 * Runs `sail:install --json` against a materialized app on a fresh kernel, so
 * a second run starts from an empty log. The codemods log their own progress
 * lines next to the command's JSON, hence the pick rather than a whole-output
 * parse.
 */
async function install(path: string, argv: string[] = []): Promise<InstallRun> {
  const kernel = await new AceFactory().make(pathToFileURL(`${path}/`));
  kernel.ui.switchMode('raw');

  const command = await kernel.create(SailInstall, ['--json', ...argv]);
  await command.exec();

  const printed = logs(kernel);
  const document = printed.find((line) => line.startsWith('{'));
  if (!document) {
    throw new Error(`expected a JSON document on stdout, got:\n${printed.join('\n')}`);
  }

  return {
    exitCode: command.exitCode ?? 0,
    payload: JSON.parse(document) as Record<string, unknown>,
  };
}

const TOUCHED_FILES = ['compose.yml', 'AGENTS.md', '.env', '.env.example', 'start/env.ts'];

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function snapshot(path: string): Promise<(string | null)[]> {
  return Promise.all(TOUCHED_FILES.map((file) => readOrNull(join(path, file))));
}

function detailsFor(scan: AppScan, service: string): string[] {
  return scan.evidence.filter((entry) => entry.service === service).map((entry) => entry.detail);
}

describe('starter-kit app', () => {
  it('detects postgres, mailpit and minio from the stock configs', async () => {
    const scan = await scanAppConfig(fixtureRoot('starter-kit'));

    expect(scan.services).toEqual(['postgres', 'mailpit', 'minio']);
    expect(scan.dbClient).toBe('pg');
    expect(detailsFor(scan, 'postgres')).toEqual(['package.json:pg', 'database.ts:pg client']);
    expect(detailsFor(scan, 'mailpit')).toEqual([
      'package.json:@adonisjs/mail',
      'mail.ts:smtp mailer',
      'SMTP_* env reads',
    ]);
    expect(detailsFor(scan, 'minio')).toEqual([
      'package.json:@adonisjs/drive',
      'drive.ts:s3 disk',
      'start/env.ts:DRIVE_DISK allows s3',
      'S3 env reads',
    ]);
  });

  it('ignores the env keys inside the mail stub commented-out auth block', async () => {
    const scan = await scanAppConfig(fixtureRoot('starter-kit'));

    expect(scan.usedEnvKeys).toContain('SMTP_HOST');
    expect(scan.usedEnvKeys).not.toContain('SMTP_USERNAME');
    expect(scan.usedEnvKeys).not.toContain('SMTP_PASSWORD');
  });

  it('stays quiet about APP_NAME, which the framework reads and no starter declares', async () => {
    const scan = await scanAppConfig(fixtureRoot('starter-kit'));

    // The stock config/logger.ts reads it and no stock start/env.ts declares
    // it, so a note here would fire on every AdonisJS app ever installed and
    // send the user to "fix" a file that is already correct.
    expect(scan.missingEnvKeys).toEqual(['APP_NAME']);
    expect(scan.notes.join('\n')).not.toContain('APP_NAME');
  });

  it('installs the three services it detected', async () => {
    const path = await materializeApp('starter-kit');
    const { exitCode, payload } = await install(path);

    expect(exitCode).toBe(0);
    expect(payload.services).toEqual(['postgres', 'mailpit', 'minio']);
    expect(payload.compose).toBe('created with postgres, mailpit, minio');
    expect(payload.agentsMd).toBe('created');
    expect(payload.varlock).toBe('skipped (no varlock detected)');

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('postgres:');
    expect(compose).toContain('mailpit:');
    expect(compose).toContain('minio:');
    expect(compose).not.toContain('redis:');

    const agentsMd = await readFile(join(path, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('<!-- sail:start -->');
    expect(agentsMd).toContain('node ace sail:up');
  });

  it('adds only the env validation the stock scaffolds never wrote', async () => {
    const path = await materializeApp('starter-kit');
    const { payload } = await install(path);

    // The lucid/mail/drive configure hooks already declared DB_*, SMTP_* and
    // AWS_*/S3_BUCKET; the MinIO endpoint has no stock scaffold, so it is the
    // one key sail introduces.
    expect(payload.env).toMatchObject({ validations: ['S3_ENDPOINT'] });

    const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
    expect(envTs).toContain('Variables for @adonis-agora/sail local services');
    expect(envTs).toContain("S3_ENDPOINT: Env.schema.string({ format: 'url', tld: false })");
    // Append-only: the scaffolded declarations are still there, once each.
    expect(envTs.match(/DB_HOST:/g)).toHaveLength(1);
    expect(envTs).toContain("DRIVE_DISK: Env.schema.enum(['fs', 's3'] as const)");
  });

  it('fills the .env keys neither .env nor .env.example define', async () => {
    const path = await materializeApp('starter-kit');
    const { payload } = await install(path);

    // .env.example carries the DB_* block the lucid preset wrote, so those are
    // left alone; everything else the selected services need is new.
    expect(payload.env).toMatchObject({
      variables: [
        'SMTP_HOST',
        'SMTP_PORT',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_REGION',
        'S3_BUCKET',
        'S3_ENDPOINT',
      ],
    });

    const dotEnv = await readFile(join(path, '.env'), 'utf8');
    expect(dotEnv).toContain('SMTP_PORT=1025');
    expect(dotEnv).toContain('S3_ENDPOINT=http://localhost:9000');
    // The DB_* block the preset wrote keeps its own values.
    expect(dotEnv).toContain('DB_PORT=5432');
    expect(dotEnv).toContain('DB_USER=postgres');

    // Secrets are written to .env but kept out of the committed example.
    const example = await readFile(join(path, '.env.example'), 'utf8');
    expect(dotEnv).toContain('AWS_SECRET_ACCESS_KEY=password');
    expect(example).toContain('AWS_SECRET_ACCESS_KEY=');
    expect(example).not.toContain('AWS_SECRET_ACCESS_KEY=password');
  });

  it('writes the defaults to .env.example only when the checkout has no .env', async () => {
    const path = await materializeApp('starter-kit', false);
    const { payload } = await install(path);

    // AdonisJS' EnvEditor updates the dotenv files that exist and creates
    // none, so a checkout that never ran `cp .env.example .env` gets the
    // defaults in the committed example and no .env at all.
    expect(payload.env).toMatchObject({ variables: expect.arrayContaining(['S3_ENDPOINT']) });
    expect(await readOrNull(join(path, '.env'))).toBeNull();
    expect(await readFile(join(path, '.env.example'), 'utf8')).toContain(
      'S3_ENDPOINT=http://localhost:9000',
    );
  });

  it('changes nothing on a second install', async () => {
    const path = await materializeApp('starter-kit');
    await install(path);
    const before = await snapshot(path);

    const { exitCode, payload } = await install(path);

    expect(exitCode).toBe(0);
    expect(payload.compose).toBe('already up to date');
    expect(payload.agentsMd).toBe('unchanged');
    expect(payload.env).toMatchObject({ validations: [], variables: [] });
    expect(await snapshot(path)).toEqual(before);
  });
});

describe('agora-stack app', () => {
  it('detects all four services across first-party and Agora configs', async () => {
    const scan = await scanAppConfig(fixtureRoot('agora-stack'));

    expect(scan.services).toEqual(['postgres', 'redis', 'mailpit', 'minio']);
    expect(scan.dbClient).toBe('pg');
  });

  it('reads the pg client out of three connections sharing a hoisted object', async () => {
    const scan = await scanAppConfig(fixtureRoot('agora-stack'));

    expect(detailsFor(scan, 'postgres')).toContain('database.ts:pg client');
    // The env reads live on the hoisted `const connection`, not inside the
    // connection literal the `client:` sits in.
    expect(scan.usedEnvKeys).toEqual(
      expect.arrayContaining(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']),
    );
  });

  it('treats every active lucid selection in an Agora config as evidence for postgres', async () => {
    const scan = await scanAppConfig(fixtureRoot('agora-stack'));

    expect(scan.agora).toEqual([
      { file: 'authz.ts', service: 'postgres', detail: 'lucid store selected (pg)' },
      { file: 'durable.ts', service: 'postgres', detail: 'lucid store selected (pg)' },
      { file: 'media.ts', service: 'postgres', detail: 'lucid store selected (pg)' },
      { file: 'media.ts', service: 'minio', detail: 's3 disk' },
      { file: 'telescope.ts', service: 'postgres', detail: 'lucid store selected (pg)' },
    ]);
  });

  it('says it cannot resolve a store chosen through env, rather than calling it unselected', async () => {
    const scan = await scanAppConfig(fixtureRoot('agora-stack'));

    // `default: env.get('LOCK_STORE')` lives in .env, not in the file, so no
    // reading of the source settles it — and "select it and re-run" is advice
    // for something the user has very likely already done.
    expect(scan.notes).toContain(
      'lock.ts picks its store from the environment — sail cannot tell whether redis is the active one; pass --services=redis if it is',
    );
    expect(scan.notes.join('\n')).not.toContain('the active store is not redis');
    expect(detailsFor(scan, 'redis')).toContain('redis.ts:redis config');
  });

  it('installs the four services it detected', async () => {
    const path = await materializeApp('agora-stack');
    const { exitCode, payload } = await install(path);

    expect(exitCode).toBe(0);
    expect(payload.services).toEqual(['postgres', 'redis', 'mailpit', 'minio']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    for (const service of ['postgres:', 'redis:', 'mailpit:', 'minio:']) {
      expect(compose).toContain(service);
    }
  });

  it('introduces S3_ENDPOINT because the app names its MinIO endpoint MINIO_URL', async () => {
    const path = await materializeApp('agora-stack');
    const { payload } = await install(path);

    expect(payload.env).toMatchObject({
      validations: ['S3_ENDPOINT'],
      variables: [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_REGION',
        'S3_BUCKET',
        'S3_ENDPOINT',
      ],
    });
    expect(payload.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("add `endpoint: env.get('S3_ENDPOINT')`")]),
    );

    const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
    expect(envTs).toContain("S3_ENDPOINT: Env.schema.string({ format: 'url', tld: false })");
    // The app's own declarations survive the edit untouched.
    expect(envTs).toContain('MINIO_URL: Env.schema.string.optional()');
    expect(envTs).toContain("TRANSMIT_TRANSPORT: Env.schema.enum.optional(['memory', 'redis']");
  });

  it('leaves the DB, redis and SMTP values the app already has', async () => {
    const path = await materializeApp('agora-stack');
    await install(path);

    const dotEnv = await readFile(join(path, '.env'), 'utf8');
    expect(dotEnv).toContain('S3_BUCKET=local');
    // Hand-tuned values win: sail never hands the editor a key that is
    // already defined, so the app's own SMTP port survives mailpit's 1025.
    expect(dotEnv).toContain('SMTP_PORT=587');
    expect(dotEnv).toContain('DB_DATABASE=entretextos');
    expect(dotEnv.match(/REDIS_PORT=/g)).toHaveLength(1);

    const example = await readFile(join(path, '.env.example'), 'utf8');
    expect(example).toContain('DB_DATABASE=entretextos');
    expect(example).toContain('S3_ENDPOINT=http://localhost:9000');
  });

  it('changes nothing on a second install', async () => {
    const path = await materializeApp('agora-stack');
    await install(path);
    const before = await snapshot(path);

    const { payload } = await install(path);

    expect(payload.compose).toBe('already up to date');
    expect(payload.agentsMd).toBe('unchanged');
    expect(payload.env).toMatchObject({ validations: [], variables: [] });
    expect(await snapshot(path)).toEqual(before);
  });
});

describe('sqlite-only app', () => {
  it('provisions nothing despite configs full of lucid, drive and store words', async () => {
    const scan = await scanAppConfig(fixtureRoot('sqlite-only'));

    expect(scan.services).toEqual([]);
    expect(scan.evidence).toEqual([]);
    expect(scan.dbClient).toBe('sqlite');
  });

  it('explains each thing it declined to provision', async () => {
    const scan = await scanAppConfig(fixtureRoot('sqlite-only'));

    expect(scan.notes).toEqual(
      expect.arrayContaining([
        'database.ts uses SQLite — no database container needed',
        'authz.ts selects the lucid store on SQLite — no container needed',
        'package.json lists @adonisjs/drive but config/drive.ts has no s3 disk — skipping minio',
      ]),
    );
  });

  it('never reads a commented-out driver as an active selection', async () => {
    const scan = await scanAppConfig(fixtureRoot('sqlite-only'));

    // config/telescope.ts carries `// lucid: storage.lucid({ connection: 'pg' })`
    // and config/media.ts a whole commented-out resumable-uploads block.
    expect(scan.agora).toEqual([]);
    expect(scan.notes).toContain(
      "telescope.ts uses the memory store — switch store to 'lucid' to persist (needs a database)",
    );
  });

  it('refuses to install and leaves the tree untouched', async () => {
    const path = await materializeApp('sqlite-only');
    const before = await snapshot(path);
    const { exitCode, payload } = await install(path);

    expect(exitCode).toBe(1);
    expect(payload.error).toContain('Could not detect any service');
    expect(payload.hint).toContain('--services=postgres');

    expect(await snapshot(path)).toEqual(before);
    expect(await readOrNull(join(path, 'compose.yml'))).toBeNull();
    expect(await readOrNull(join(path, 'AGENTS.md'))).toBeNull();
  });

  it('installs what it is told to when the services are named explicitly', async () => {
    const path = await materializeApp('sqlite-only');
    const { exitCode, payload } = await install(path, ['--services=redis']);

    expect(exitCode).toBe(0);
    expect(payload.services).toEqual(['redis']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('redis:');
    expect(compose).not.toContain('postgres:');
  });
});
