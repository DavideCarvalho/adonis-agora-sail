import { describe, expect, it } from 'vitest';

import {
  ENV_VALIDATIONS,
  formatAppScan,
  mergeServices,
  parseDbClient,
  parseEnvGets,
  parseEnvTsKeys,
  scanAppFiles,
  stripComments,
  stripLineComment,
} from '../src/app_scan.js';

const PG_DATABASE_TS = `
import env from '#start/env'
export default defineConfig({
  connection: 'postgres',
  connections: {
    postgres: {
      client: 'pg',
      connection: { host: env.get('DB_HOST'), port: env.get('DB_PORT') },
    },
  },
})
`;

describe('stripComments', () => {
  it('removes block, full-line and trailing comments but keeps code and urls', () => {
    const content = stripComments(
      `/* header */\n// lucid: storage.lucid()\nstore: 'memory', // default\nurl: 'http://x'\n`,
    );
    expect(content).not.toContain('lucid');
    expect(content).not.toContain('default');
    expect(content).toContain(`store: 'memory'`);
    expect(content).toContain('http://x');
  });

  it('keeps // inside quoted strings', () => {
    expect(stripLineComment(`key: 'a//b', // comment`)).toBe(`key: 'a//b', `);
  });
});

describe('parseEnvTsKeys', () => {
  it('reads KEY: declarations and ignores comments', () => {
    expect(
      parseEnvTsKeys(
        `export default await Env.create(url, {\n  DB_HOST: Env.schema.string(),\n  // DB_PORT: Env.schema.number(),\n  DB_PORT: Env.schema.number(),\n})`,
      ),
    ).toEqual(['DB_HOST', 'DB_PORT']);
  });
});

describe('parseEnvGets', () => {
  it('reads env.get and process.env keys', () => {
    expect(parseEnvGets(`host: env.get('DB_HOST'), port: Number(process.env.DB_PORT)`)).toEqual([
      'DB_HOST',
      'DB_PORT',
    ]);
  });
});

describe('parseDbClient', () => {
  it('reads client and connection names', () => {
    expect(parseDbClient(`{ client: 'pg' }`)).toBe('pg');
    expect(parseDbClient(`{ client: 'mysql2' }`)).toBe('mysql');
    expect(parseDbClient(`{ client: 'better-sqlite3' }`)).toBe('sqlite');
    expect(parseDbClient(`{ connection: 'postgres' }`)).toBe('pg');
    expect(parseDbClient(`{ connection: 'sqlite' }`)).toBe('sqlite');
    expect(parseDbClient(`{}`)).toBeNull();
  });

  it('ignores commented-out clients', () => {
    expect(parseDbClient(`{\n// client: 'pg',\nclient: 'better-sqlite3',\n}`)).toBe('sqlite');
  });
});

describe('mergeServices', () => {
  it('keeps service order and drops nothing without conflict', () => {
    expect(mergeServices(['redis', 'postgres'], 'pg')).toEqual({
      services: ['postgres', 'redis'],
      dropped: null,
    });
  });

  it('lets the configured database client win the pg/mysql tie', () => {
    expect(mergeServices(['postgres', 'mysql'], 'mysql').services).toEqual(['mysql']);
    expect(mergeServices(['postgres', 'mysql'], null).services).toEqual(['postgres']);
  });
});

describe('scanAppFiles', () => {
  it('merges dependency and config evidence with details', () => {
    const scan = scanAppFiles({
      dependencies: { pg: '^8.0.0' },
      envTs: `export default await Env.create(url, { DB_HOST: Env.schema.string(), DB_PORT: Env.schema.number() })`,
      configs: { 'database.ts': PG_DATABASE_TS },
    });
    expect(scan.services).toEqual(['postgres']);
    expect(scan.evidence).toContainEqual({
      service: 'postgres',
      via: 'dependency',
      detail: 'package.json:pg',
    });
    expect(scan.evidence).toContainEqual({
      service: 'postgres',
      via: 'config',
      detail: 'database.ts:pg client',
    });
    expect(scan.missingEnvKeys).toEqual([]);
  });

  it('detects redis/mail/minio from their config files alone', () => {
    const scan = scanAppFiles({
      dependencies: {},
      configs: {
        'redis.ts': `export default defineConfig({ connection: 'main' })`,
        'mail.ts': `mailers: { smtp: transports.smtp({ host: env.get('SMTP_HOST') }) }`,
        'drive.ts': `s3: services.s3({ bucket: env.get('S3_BUCKET') })`,
      },
    });
    expect(scan.services).toEqual(['redis', 'mailpit', 'minio']);
    expect(scan.missingEnvKeys).toEqual(['S3_BUCKET', 'SMTP_HOST']);
  });

  it('notes sqlite instead of provisioning a database', () => {
    const scan = scanAppFiles({
      dependencies: { '@adonisjs/lucid': '^22.0.0' },
      configs: { 'database.ts': `{ client: 'better-sqlite3' }` },
    });
    expect(scan.services).toEqual([]);
    expect(scan.notes.join('\n')).toContain('SQLite');
  });

  it('counts selected agora lucid stores but not defined-only drivers', () => {
    const scan = scanAppFiles({
      dependencies: { pg: '^8.0.0' },
      configs: {
        'database.ts': PG_DATABASE_TS,
        'telescope.ts': `export default defineConfig({\n  store: 'lucid',\n  stores: { lucid: storage.lucid() },\n})`,
        'media.ts': `export default defineConfig({\n  // disk: 's3',\n  store: 'memory',\n  stores: { memory: stores.memory(), // lucid: stores.lucid(),\n } })`,
      },
    });
    expect(scan.agora).toContainEqual({
      file: 'telescope.ts',
      service: 'postgres',
      detail: 'lucid store selected (pg)',
    });
    expect(scan.agora.some((signal) => signal.file === 'media.ts')).toBe(false);
    expect(scan.notes.join('\n')).toContain(`media.ts uses the memory store`);
  });

  it('maps a selected lucid store onto the configured mysql connection', () => {
    const scan = scanAppFiles({
      dependencies: {},
      configs: {
        'database.ts': `{ connection: 'mysql', connections: { mysql: { client: 'mysql2' } } }`,
        'authz.ts': `export default defineConfig({ default: 'lucid' })`,
      },
    });
    expect(scan.services).toEqual(['mysql']);
    expect(scan.evidence).toContainEqual({
      service: 'mysql',
      via: 'config',
      detail: 'authz.ts:lucid store selected (mysql)',
    });
  });

  it('needs no container when the lucid store sits on SQLite', () => {
    const scan = scanAppFiles({
      dependencies: {},
      configs: {
        'database.ts': `{ client: 'better-sqlite3' }`,
        'authz.ts': `export default defineConfig({ default: 'lucid' })`,
      },
    });
    expect(scan.services).toEqual([]);
    expect(scan.notes.join('\n')).toContain('authz.ts selects the lucid store on SQLite');
  });

  it('vetoes dependency-only services the config contradicts', () => {
    const pgSqlite = scanAppFiles({
      dependencies: { pg: '^8.0.0' },
      configs: { 'database.ts': `{ client: 'better-sqlite3' }` },
    });
    expect(pgSqlite.services).toEqual([]);
    expect(pgSqlite.notes.join('\n')).toContain('skipping postgres');

    const driveFs = scanAppFiles({
      dependencies: { '@adonisjs/drive': '^4.0.0' },
      configs: { 'drive.ts': `default: env.get('DRIVE_DISK'), services: { fs: services.fs() }` },
    });
    expect(driveFs.services).toEqual([]);
    expect(driveFs.notes.join('\n')).toContain('skipping minio');

    const mailResend = scanAppFiles({
      dependencies: { '@adonisjs/mail': '^10.0.0' },
      configs: { 'mail.ts': `mailers: { resend: transports.resend() }` },
    });
    expect(mailResend.services).toEqual([]);
    expect(mailResend.notes.join('\n')).toContain('skipping mailpit');
  });

  it('keeps dependency evidence when the owning config is absent', () => {
    const scan = scanAppFiles({
      dependencies: { '@adonisjs/drive': '^4.0.0' },
      configs: {},
    });
    expect(scan.services).toEqual(['minio']);
  });

  it('reads DRIVE_DISK s3 enums as minio evidence', () => {
    const scan = scanAppFiles({
      dependencies: {},
      envTs: `export default await Env.create(url, { DRIVE_DISK: Env.schema.enum(['fs', 's3'] as const) })`,
      configs: {},
    });
    expect(scan.services).toEqual(['minio']);
    expect(scan.evidence).toContainEqual({
      service: 'minio',
      via: 'env',
      detail: 'start/env.ts:DRIVE_DISK allows s3',
    });
  });

  it('flags unmapped missing keys as hand-written notes', () => {
    const scan = scanAppFiles({
      dependencies: {},
      configs: { 'mail.ts': `default: env.get('MAIL_MAILER')` },
    });
    expect(scan.missingEnvKeys).toEqual(['MAIL_MAILER']);
    expect(scan.notes.join('\n')).toContain('MAIL_MAILER');
  });
});

describe('ENV_VALIDATIONS', () => {
  it('covers every sail-managed connection key', async () => {
    const { sailEnvKeys } = await import('../src/varlock.js');
    const { SERVICE_NAMES } = await import('../src/services.js');
    for (const key of sailEnvKeys(SERVICE_NAMES)) {
      expect(ENV_VALIDATIONS[key], key).toBeDefined();
    }
  });
});

describe('formatAppScan', () => {
  it('renders evidence, coverage and notes as plain text', () => {
    const text = formatAppScan(
      scanAppFiles({
        dependencies: { pg: '^8.0.0' },
        envTs: `export default await Env.create(url, {})`,
        configs: { 'database.ts': PG_DATABASE_TS },
      }),
    );
    expect(text).toContain('postgres — package.json:pg, database.ts:pg client');
    expect(text).toContain('missing: DB_HOST, DB_PORT');
  });
});
