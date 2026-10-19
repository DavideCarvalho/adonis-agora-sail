import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import SailInstall from '../commands/sail_install.js';
import { createTestApp, jsonOutput, logs, output } from './helpers/ace.js';

/**
 * The codemods behind `start/env.ts` are ts-morph based: they only run when
 * the app root has a tsconfig that includes the file.
 */
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', module: 'NodeNext' },
  include: ['**/*.ts'],
});

const ENV_TS = `import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
})
`;

function packageJson(dependencies: Record<string, string> = {}, devDependencies = {}): string {
  return JSON.stringify({ name: 'shop', dependencies, devDependencies });
}

/** Writes fixtures below the app root, nested paths included. */
async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

/** Every file below the app root, keyed by relative path. */
async function snapshot(root: string, directory = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await snapshot(root, path));
    } else {
      files[relative(root, path)] = await readFile(path, 'utf8');
    }
  }
  return files;
}

async function install(
  kernel: Awaited<ReturnType<typeof createTestApp>>['kernel'],
  args: string[],
) {
  const command = await kernel.create(SailInstall, args);
  await command.exec();
  return command;
}

describe('sail:install', () => {
  describe('service detection', () => {
    it('enables the services the package.json dependencies imply', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({ pg: '^8', ioredis: '^5', '@adonisjs/mail': '^9' }),
      });

      const command = await install(kernel, ['--no-json']);

      expect(command.exitCode).toBe(0);
      const compose = await readFile(join(path, 'compose.yml'), 'utf8');
      expect(compose).toContain('postgres:');
      expect(compose).toContain('redis:');
      expect(compose).toContain('mailpit:');
      expect(output(kernel)).toContain('postgres — package.json:pg');
    });

    it('prefers explicitly requested services over the detected ones', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({ pg: '^8', ioredis: '^5' }),
      });

      await install(kernel, ['--no-json', '--services=mysql']);

      const compose = await readFile(join(path, 'compose.yml'), 'utf8');
      expect(compose).toContain('mysql:');
      expect(compose).not.toContain('postgres:');
      expect(compose).not.toContain('redis:');
    });

    it('reads the database client from config/database.ts when no driver is a dependency', async () => {
      const { kernel, path } = await createTestApp();
      await writeFiles(path, {
        'config/database.ts': `export default defineConfig({
  connections: { mysql: { client: 'mysql2', connection: { host: env.get('DB_HOST') } } },
})
`,
      });

      await install(kernel, ['--no-json']);

      expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('mysql:');
      expect(output(kernel)).toContain('mysql — database.ts:mysql client');
    });

    it('pins redis, mailpit and object storage from their config files', async () => {
      const { kernel, path } = await createTestApp();
      await writeFiles(path, {
        'config/redis.ts': `export default defineConfig({
  connections: { main: { host: env.get('REDIS_HOST') } },
})
`,
        'config/mail.ts': `export default defineConfig({
  mailers: { smtp: transports.smtp({ host: env.get('SMTP_HOST') }) },
})
`,
        'config/drive.ts': `export default defineConfig({
  services: { s3: services.s3({ bucket: env.get('S3_BUCKET') }) },
})
`,
      });

      await install(kernel, ['--no-json']);

      const compose = await readFile(join(path, 'compose.yml'), 'utf8');
      expect(compose).toContain('redis:');
      expect(compose).toContain('mailpit:');
      expect(compose).toContain('rustfs:');
      expect(output(kernel)).toContain('mailpit — mail.ts:smtp mailer');
      expect(output(kernel)).toContain('rustfs — drive.ts:s3 disk');
    });

    it('counts an active lucid store in an Agora config as evidence for the configured client', async () => {
      const { kernel, path } = await createTestApp();
      await writeFiles(path, {
        'config/database.ts': `export default defineConfig({
  connections: { postgres: { client: 'pg' } },
})
`,
        'config/telescope.ts': `export default defineConfig({
  store: 'lucid',
  // store: 'memory',
})
`,
      });

      await install(kernel, ['--no-json']);

      expect(output(kernel)).toContain('telescope.ts:lucid store selected (pg)');
      expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('postgres:');
    });

    it('fails on unknown service names and lists the valid ones', async () => {
      const { kernel } = await createTestApp();

      const command = await install(kernel, ['--no-json', '--services=mongo']);

      expect(command.exitCode).toBe(1);
      expect(output(kernel)).toContain('Unknown service(s): mongo');
      expect(output(kernel)).toContain(
        'Valid services: postgres, mysql, redis, mailpit, rustfs, seaweedfs, garage, minio',
      );
    });

    it('fails with the exact re-run when nothing is detected and it cannot prompt', async () => {
      const { kernel, path } = await createTestApp();

      const command = await install(kernel, ['--no-json']);

      expect(command.exitCode).toBe(1);
      expect(output(kernel)).toContain(
        'Could not detect any service from package.json or config/*.ts',
      );
      expect(output(kernel)).toContain(
        'Re-run with explicit services, e.g. node ace sail:install --services=postgres --services=redis (valid: postgres, mysql, redis, mailpit, rustfs, seaweedfs, garage, minio)',
      );
      await expect(readFile(join(path, 'compose.yml'), 'utf8')).rejects.toThrow();
    });
  });

  describe('compose file', () => {
    it('generates host ports as worktree-agnostic interpolations', async () => {
      const { kernel, path } = await createTestApp();

      await install(kernel, ['--no-json', '--services=postgres']);

      const compose = await readFile(join(path, 'compose.yml'), 'utf8');
      expect(compose).toContain('# Managed by @adonis-agora/sail');
      expect(compose).toContain('- ${SAIL_POSTGRES_PORT:-5432}:5432');
      expect(compose).toContain('sail-postgres:/var/lib/postgresql/data');
      expect(output(kernel)).toContain('compose.yml created with postgres');
    });

    it('does not duplicate a service when re-run', async () => {
      const { kernel, path } = await createTestApp();

      await install(kernel, ['--no-json', '--services=postgres']);
      const first = await readFile(join(path, 'compose.yml'), 'utf8');
      const command = await install(kernel, ['--no-json', '--services=postgres']);
      const second = await readFile(join(path, 'compose.yml'), 'utf8');

      expect(command.exitCode).toBe(0);
      expect(second).toBe(first);
      expect(second.match(/^ {2}postgres:$/gm)).toHaveLength(1);
      expect(output(kernel)).toContain('compose.yml already up to date');
    });

    it('appends only the services missing from an existing compose file', async () => {
      const { kernel, path } = await createTestApp();

      await install(kernel, ['--no-json', '--services=postgres']);
      await install(kernel, ['--no-json', '--services=postgres', '--services=redis']);

      const compose = await readFile(join(path, 'compose.yml'), 'utf8');
      expect(compose.match(/^ {2}postgres:$/gm)).toHaveLength(1);
      expect(compose).toContain('redis:');
      expect(output(kernel)).toContain('compose.yml updated (added redis)');
    });
  });

  describe('app wiring', () => {
    it('adds the missing connection validations to start/env.ts', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      await writeFiles(path, { 'tsconfig.json': TSCONFIG, 'start/env.ts': ENV_TS });

      await install(kernel, ['--no-json']);

      const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
      expect(envTs).toContain('Variables for @adonis-agora/sail local services');
      expect(envTs).toContain("DB_HOST: Env.schema.string({ format: 'host' })");
      expect(envTs).toContain('DB_PORT: Env.schema.number()');
      expect(envTs).toContain('DB_PASSWORD: Env.schema.string.optional()');
      expect(envTs).toContain('PORT: Env.schema.number()');
      expect(output(kernel)).toContain(
        'start/env.ts validations added (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE)',
      );
    });

    it('leaves a validation the app already declares alone', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      await writeFiles(path, {
        'tsconfig.json': TSCONFIG,
        'start/env.ts': ENV_TS.replace(
          '  PORT: Env.schema.number(),',
          "  PORT: Env.schema.number(),\n  DB_HOST: Env.schema.string({ format: 'host' }),",
        ),
      });

      await install(kernel, ['--no-json']);

      const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
      expect(envTs.match(/DB_HOST:/g)).toHaveLength(1);
      expect(output(kernel)).toContain(
        'start/env.ts validations added (DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE)',
      );
    });

    it('writes the defaults for keys missing from both .env and .env.example', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      await writeFiles(path, {
        'tsconfig.json': TSCONFIG,
        '.env': 'PORT=3333\n',
        '.env.example': 'PORT=3333\n',
      });

      await install(kernel, ['--no-json']);

      const dotEnv = await readFile(join(path, '.env'), 'utf8');
      expect(dotEnv).toContain('PORT=3333');
      expect(dotEnv).toContain('DB_HOST=127.0.0.1');
      expect(dotEnv).toContain('DB_PORT=5432');
      expect(dotEnv).toContain('DB_PASSWORD=password');
      // the committed example keeps the key but never the secret's value
      expect(await readFile(join(path, '.env.example'), 'utf8')).toContain('DB_PASSWORD=\n');
    });

    it('never overwrites a value the app already set', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      await writeFiles(path, {
        'tsconfig.json': TSCONFIG,
        '.env': 'DB_PORT=15432\nDB_PASSWORD=hand-tuned\n',
      });

      await install(kernel, ['--no-json']);

      const dotEnv = await readFile(join(path, '.env'), 'utf8');
      expect(dotEnv).toContain('DB_PORT=15432');
      expect(dotEnv).toContain('DB_PASSWORD=hand-tuned');
      expect(dotEnv).toContain('DB_DATABASE=app');
      expect(output(kernel)).toContain(
        '.env/.env.example defaults added (DB_HOST, DB_USER, DB_DATABASE)',
      );
    });

    it('adds the AGENTS.md section once, between its markers', async () => {
      const { kernel, path } = await createTestApp();

      await install(kernel, ['--no-json', '--services=redis']);
      await install(kernel, ['--no-json', '--services=redis']);

      const agentsMd = await readFile(join(path, 'AGENTS.md'), 'utf8');
      expect(agentsMd.match(/<!-- sail:start checksum=[0-9a-f]+ -->/g)).toHaveLength(1);
      expect(agentsMd).toContain('## Sail (local dev services)');
      expect(agentsMd).toContain('node ace sail:info --json');
      expect(agentsMd.trimEnd().endsWith('<!-- sail:end -->')).toBe(true);
      expect(output(kernel)).toContain('AGENTS.md created');
      expect(output(kernel)).toContain('AGENTS.md unchanged');
    });

    it('keeps the rest of an existing AGENTS.md', async () => {
      const { kernel, path } = await createTestApp();
      await writeFiles(path, { 'AGENTS.md': '# House rules\n\nRun the tests.\n' });

      await install(kernel, ['--no-json', '--services=redis']);

      const agentsMd = await readFile(join(path, 'AGENTS.md'), 'utf8');
      expect(agentsMd).toContain('# House rules');
      expect(agentsMd).toContain('<!-- sail:start checksum=');
      expect(output(kernel)).toContain('AGENTS.md updated');
    });
  });

  describe('varlock', () => {
    it('skips the schema when varlock is not in use', async () => {
      const { kernel, path } = await createTestApp();

      await install(kernel, ['--no-json', '--services=redis']);

      expect(output(kernel)).toContain('varlock schema skipped (no varlock detected)');
      await expect(readFile(join(path, '.env.schema'), 'utf8')).rejects.toThrow();
    });

    it('creates the schema with the audit patterns when varlock is a dependency', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({}, { varlock: '^1' }),
      });

      await install(kernel, ['--no-json', '--services=redis']);

      const schema = await readFile(join(path, '.env.schema'), 'utf8');
      expect(schema).toContain('@auditExtraPatterns');
      expect(schema).toContain('# ---');
      expect(schema).toContain('# sail:schema:start');
      expect(schema).toContain('# @tag(sail)');
      expect(schema).toContain('# @type=number');
      expect(schema).toContain('REDIS_HOST=127.0.0.1');
      expect(schema).toContain('REDIS_PORT=6379');
      expect(schema).toContain('REDIS_PASSWORD=\n');
      expect(output(kernel)).toContain(
        'varlock schema created (declares REDIS_HOST, REDIS_PORT, REDIS_PASSWORD)',
      );
    });

    it('appends only the missing keys to an existing schema', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({}, { varlock: '^1' }),
        '.env.schema': "# @auditExtraPatterns(regex('mine'))\n# ---\n\nREDIS_HOST=10.0.0.1\n",
      });

      await install(kernel, ['--no-json', '--services=redis']);

      const schema = await readFile(join(path, '.env.schema'), 'utf8');
      expect(schema).toContain('REDIS_HOST=10.0.0.1');
      expect(schema).not.toContain('REDIS_HOST=127.0.0.1');
      expect(schema).toContain('REDIS_PORT=6379');
      expect(output(kernel)).toContain('varlock schema updated (added REDIS_PORT, REDIS_PASSWORD)');
    });

    it('reports the audit patterns instead of inserting them when the schema has no root divider', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({}, { varlock: '^1' }),
        '.env.schema': '# my notes\nPORT=3333\n',
      });

      await install(kernel, ['--no-json', '--services=redis']);

      const schema = await readFile(join(path, '.env.schema'), 'utf8');
      expect(schema).not.toContain('@auditExtraPatterns');
      expect(schema).toContain('# my notes');
      expect(schema).toContain('REDIS_HOST=127.0.0.1');
      expect(output(kernel)).toContain(
        'note: varlock audit: .env.schema has no `# ---` root divider',
      );
    });
  });

  describe('notes', () => {
    it('reports MAIL_MAILER and DRIVE_DISK instead of guessing their validation', async () => {
      const { kernel, path } = await createTestApp();
      await writeFiles(path, {
        'config/mail.ts': `export default defineConfig({
  default: env.get('MAIL_MAILER'),
  mailers: { smtp: transports.smtp({ host: env.get('SMTP_HOST') }) },
})
`,
        'config/drive.ts': `export default defineConfig({
  default: env.get('DRIVE_DISK'),
  services: { s3: services.s3({ bucket: env.get('S3_BUCKET') }) },
})
`,
      });

      await install(kernel, ['--no-json']);

      expect(output(kernel)).toContain(
        'note: start/env.ts is missing DRIVE_DISK, MAIL_MAILER — sail has no stock validation for these, add them by hand',
      );
      // No start/env.ts and no code transformer here, so the validations are
      // honestly reported as not written — with the snippet to paste.
      expect(output(kernel)).toContain('not written — add to start/env.ts by hand: SMTP_HOST');
    });

    it('reports the s3 disk settings a local backend needs whenever object storage is selected', async () => {
      const { kernel } = await createTestApp();

      await install(kernel, ['--no-json', '--services=minio']);

      expect(output(kernel)).toContain(
        "note: Object storage: add `endpoint: env.get('S3_ENDPOINT')` and `forcePathStyle: true` to the s3 disk in config/drive.ts — the local backend needs both",
      );
    });

    it('asks only for what the s3 disk is missing, and nothing once it has both', async () => {
      const partial = await createTestApp();
      await writeFiles(partial.path, {
        'config/drive.ts': `export default defineConfig({
  default: 's3',
  services: { s3: services.s3({ endpoint: env.get('S3_URL'), bucket: env.get('S3_BUCKET') }) },
})
`,
      });
      await install(partial.kernel, ['--no-json']);
      expect(output(partial.kernel)).toContain(
        'note: Object storage: add `forcePathStyle: true` to the s3 disk in config/drive.ts — the local backend needs it',
      );

      const complete = await createTestApp();
      await writeFiles(complete.path, {
        'config/drive.ts': `export default defineConfig({
  default: 's3',
  services: { s3: services.s3({ endpoint: env.get('S3_URL'), forcePathStyle: true }) },
})
`,
      });
      await install(complete.kernel, ['--no-json']);
      expect(output(complete.kernel)).not.toContain('Object storage: add');
    });

    it('degrades to a printed snippet when it cannot edit .env', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      // a directory where the file should be: the env editor throws, and env
      // wiring must never take the compose file down with it
      await mkdir(join(path, '.env'));

      const command = await install(kernel, ['--no-json']);

      expect(command.exitCode).toBe(0);
      expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('postgres:');
      expect(output(kernel)).toContain(
        'not written — add to .env by hand: DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=sail DB_PASSWORD=password DB_DATABASE=app',
      );
    });
  });

  describe('idempotency', () => {
    it('changes nothing on a second run', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({ pg: '^8', ioredis: '^5' }, { varlock: '^1' }),
      });
      await writeFiles(path, {
        'tsconfig.json': TSCONFIG,
        'start/env.ts': ENV_TS,
        '.env': 'PORT=3333\n',
        '.env.example': 'PORT=3333\n',
        'AGENTS.md': '# House rules\n',
      });

      await install(kernel, ['--no-json']);
      const afterFirst = await snapshot(path);
      const command = await install(kernel, ['--no-json']);
      const afterSecond = await snapshot(path);

      expect(command.exitCode).toBe(0);
      expect(afterSecond).toEqual(afterFirst);
      expect(output(kernel)).toContain('compose.yml already up to date');
      expect(output(kernel)).toContain('AGENTS.md unchanged');
      expect(output(kernel)).toContain('varlock schema unchanged');
      expect(output(kernel)).toContain('start/env.ts validations unchanged');
      expect(output(kernel)).toContain('.env/.env.example unchanged');
    });

    it('leaves a start/env.ts it cannot parse untouched', async () => {
      const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
      await writeFiles(path, {
        'tsconfig.json': TSCONFIG,
        'start/env.ts': 'export default {}\n',
        '.env': 'PORT=3333\n',
      });

      await install(kernel, ['--no-json']);

      expect(await readFile(join(path, 'start', 'env.ts'), 'utf8')).toBe('export default {}\n');
      expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('postgres:');
      expect(await readFile(join(path, '.env'), 'utf8')).toContain('DB_HOST=127.0.0.1');
    });
  });

  describe('--json', () => {
    it('prints one report document', async () => {
      const { kernel, path } = await createTestApp({
        'package.json': packageJson({ ioredis: '^5' }),
      });
      // every key already declared and defined: nothing for the codemods to do
      await writeFiles(path, {
        'start/env.ts': ENV_TS.replace(
          '  PORT: Env.schema.number(),',
          "  PORT: Env.schema.number(),\n  REDIS_HOST: Env.schema.string({ format: 'host' }),\n  REDIS_PORT: Env.schema.number(),\n  REDIS_PASSWORD: Env.schema.string.optional(),",
        ),
        '.env': 'REDIS_HOST=127.0.0.1\nREDIS_PORT=6379\nREDIS_PASSWORD=\n',
      });

      const command = await install(kernel, ['--json']);

      expect(command.exitCode).toBe(0);
      expect(jsonOutput(kernel)).toMatchObject({
        composeFile: join(path, 'compose.yml'),
        compose: 'created with redis',
        services: ['redis'],
        detection: [{ service: 'redis', via: 'dependency', detail: 'package.json:ioredis' }],
        projectName: 'shop',
        portOffset: 0,
        agentsMd: 'created',
        varlock: 'skipped (no varlock detected)',
        env: { validations: [], variables: [] },
        notes: [],
      });
    });

    it('reports a refusal as an error document', async () => {
      const { kernel } = await createTestApp();

      const command = await install(kernel, ['--json', '--services=mongo']);

      expect(command.exitCode).toBe(1);
      expect(jsonOutput(kernel)).toEqual({
        error: 'Unknown service(s): mongo',
        hint: 'Valid services: postgres, mysql, redis, mailpit, rustfs, seaweedfs, garage, minio',
      });
    });
  });
});

describe('sail:install --json', () => {
  it('emits one message, and it is the report', async () => {
    // The codemods report through the command's logger, so a run that has
    // work to do used to interleave their progress lines with the payload.
    // One logged message is the whole contract: stdout stays parseable.
    const { kernel } = await createTestApp({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { pg: '^8' } }),
    });
    const command = await kernel.create(SailInstall, ['--json']);
    await command.exec();

    expect(logs(kernel)).toHaveLength(1);
    expect(jsonOutput(kernel)).toMatchObject({ services: ['postgres'] });
  });
});

describe('sail:install — object storage', () => {
  const STOCK_DRIVE = `export default defineConfig({
  default: env.get('DRIVE_DISK'),
  services: {
    fs: services.fs({ location: app.makePath('storage') }),
    s3: services.s3({
      credentials: {
        accessKeyId: env.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: env.get('AWS_SECRET_ACCESS_KEY'),
      },
      region: env.get('AWS_REGION'),
      bucket: env.get('S3_BUCKET'),
    }),
  },
})
`;

  it('does not provision object storage for a disk picked from the environment', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': packageJson({ pg: '^8', '@adonisjs/drive': '^3' }),
    });
    await writeFiles(path, { 'config/drive.ts': STOCK_DRIVE });

    await install(kernel, ['--no-json']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('postgres:');
    expect(compose).not.toContain('rustfs:');
    expect(output(kernel)).toContain(
      'note: config/drive.ts picks the disk from the environment (DRIVE_DISK) — sail cannot tell whether s3 is the active one; pass --object-storage=rustfs if it is',
    );
  });

  it('provisions the backend --object-storage names and records it in package.json', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': `${JSON.stringify({ name: 'shop', dependencies: { '@adonisjs/drive': '^3' } }, null, 4)}\n`,
    });
    await writeFiles(path, { 'config/drive.ts': STOCK_DRIVE });

    const command = await install(kernel, ['--no-json', '--object-storage=seaweedfs']);

    expect(command.exitCode).toBe(0);
    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('seaweedfs:');
    expect(compose).toContain('chrislusf/seaweedfs');
    const pkg = await readFile(join(path, 'package.json'), 'utf8');
    // indentation and the final newline are kept
    expect(pkg).toContain('    "sail": {\n        "objectStorage": "seaweedfs"\n    }');
    expect(pkg.endsWith('}\n')).toBe(true);
  });

  it('fails on an unknown backend, naming the valid ones', async () => {
    const { kernel } = await createTestApp();

    const command = await install(kernel, ['--json', '--object-storage=ceph']);

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toEqual({
      error: 'Unknown object storage backend: ceph',
      hint: 'Valid backends: rustfs, seaweedfs, garage, minio',
    });
  });

  it('writes Garage with its inline config, single-node bootstrap and longer credentials', async () => {
    const { kernel, path } = await createTestApp();

    await install(kernel, ['--no-json', '--services=garage']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('dxflrs/garage:');
    expect(compose).toContain('- --single-node');
    expect(compose).toContain('- --default-bucket');
    expect(compose).toContain('GARAGE_DEFAULT_BUCKET: local');
    expect(compose).toContain('source: sail-garage-toml');
    expect(compose).toContain('target: /etc/garage.toml');
    expect(compose).toMatch(/configs:\n {2}sail-garage-toml:\n {4}content: \|/);
    expect(compose).toContain('s3_region = "us-east-1"');
    expect(compose).toContain('replication_factor = 1');
  });

  it('keeps the backend compose.yml already runs and explains how to switch', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': packageJson({ '@adonisjs/drive': '^3' }),
    });
    await install(kernel, ['--no-json', '--services=minio']);

    await install(kernel, ['--no-json', '--object-storage=rustfs']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('minio:');
    expect(compose).not.toContain('rustfs:');
    expect(output(kernel)).toContain(
      'note: compose.yml already runs minio for object storage — to switch to rustfs, remove the minio service and its sail-minio volume from compose.yml',
    );
  });

  it('flags the MinIO image that can no longer be pulled', async () => {
    const { kernel, path } = await createTestApp();
    await writeFiles(path, {
      'compose.yml': 'services:\n  minio:\n    image: minio/minio:latest\n',
    });

    await install(kernel, ['--no-json', '--services=minio']);

    expect(output(kernel)).toContain(
      'note: compose.yml runs minio/minio:latest, which MinIO no longer publishes',
    );
  });

  it('adds optional validations, so a production boot without the keys still works', async () => {
    const { kernel, path } = await createTestApp();
    await writeFiles(path, { 'tsconfig.json': TSCONFIG, 'start/env.ts': ENV_TS });

    await install(kernel, ['--no-json', '--services=rustfs']);

    const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
    expect(envTs).toContain('AWS_ACCESS_KEY_ID: Env.schema.string.optional()');
    expect(envTs).toContain('AWS_SECRET_ACCESS_KEY: Env.schema.string.optional()');
    expect(envTs).toContain('AWS_REGION: Env.schema.string.optional()');
    expect(envTs).toContain('S3_BUCKET: Env.schema.string.optional()');
    expect(envTs).not.toMatch(/AWS_[A-Z_]+: Env\.schema\.string\(\)/);
  });

  it('never adds AWS_* when the s3 disk reads differently named keys', async () => {
    const { kernel, path } = await createTestApp();
    await writeFiles(path, {
      'tsconfig.json': TSCONFIG,
      'start/env.ts': ENV_TS.replace(
        '  PORT: Env.schema.number(),',
        '  PORT: Env.schema.number(),\n  S3_ACCESS_KEY: Env.schema.string(),',
      ),
      '.env': 'PORT=3333\n',
      'config/drive.ts': `export default defineConfig({
  default: 's3',
  services: {
    s3: services.s3({
      credentials: {
        accessKeyId: env.get('S3_ACCESS_KEY'),
        secretAccessKey: env.get('S3_SECRET_KEY'),
      },
      region: env.get('S3_REGION'),
      bucket: env.get('S3_BUCKET'),
      endpoint: env.get('S3_ENDPOINT'),
      forcePathStyle: true,
    }),
  },
})
`,
    });

    await install(kernel, ['--no-json']);

    const envTs = await readFile(join(path, 'start', 'env.ts'), 'utf8');
    expect(envTs).not.toContain('AWS_');
    // The keys it does read get the stock shapes — optional — and the one
    // the app already declares is left alone.
    expect(envTs).toContain('S3_SECRET_KEY: Env.schema.string.optional()');
    expect(envTs).toContain('S3_REGION: Env.schema.string.optional()');
    expect(envTs.match(/S3_ACCESS_KEY:/g)).toHaveLength(1);
    const dotEnv = await readFile(join(path, '.env'), 'utf8');
    expect(dotEnv).not.toContain('AWS_');
    expect(dotEnv).toContain('S3_ACCESS_KEY=sail');
    expect(dotEnv).toContain('S3_SECRET_KEY=password');
    // a secret under the app's own name is still kept out of the example
    expect(output(kernel)).not.toContain('start/env.ts is missing');
  });
});

describe('sail:install — exclusions', () => {
  it('records --exclude in package.json, and a plain re-run leaves the service out', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': packageJson({ pg: '^8', '@adonisjs/mail': '^9' }),
    });

    await install(kernel, ['--no-json', '--exclude=mailpit']);
    const first = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(first).toContain('postgres:');
    expect(first).not.toContain('mailpit:');
    expect(JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).sail).toEqual({
      exclude: ['mailpit'],
    });

    await install(kernel, ['--no-json']);

    expect(await readFile(join(path, 'compose.yml'), 'utf8')).toBe(first);
    expect(output(kernel)).toContain(
      'note: package.json "sail.exclude" leaves out mailpit — pass --services to add it anyway',
    );
  });

  it('excludes the whole object storage slot with "object-storage"', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': JSON.stringify({
        name: 'shop',
        dependencies: { pg: '^8', '@aws-sdk/client-s3': '^3' },
        sail: { exclude: ['object-storage'] },
      }),
    });

    await install(kernel, ['--no-json']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('postgres:');
    expect(compose).not.toMatch(/rustfs:|minio:|garage:|seaweedfs:/);
  });

  it('still adds an excluded service named in --services', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': JSON.stringify({ name: 'shop', sail: { exclude: ['redis'] } }),
    });

    await install(kernel, ['--no-json', '--services=redis']);

    expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('redis:');
  });

  it('rejects an unknown service to exclude', async () => {
    const { kernel } = await createTestApp();

    const command = await install(kernel, ['--json', '--exclude=mongo']);

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toMatchObject({ error: 'Unknown service(s) to exclude: mongo' });
  });
});

describe('sail:install — postgres image', () => {
  it('runs pgvector when a migration creates the vector extension', async () => {
    const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
    await writeFiles(path, {
      'database/migrations/1700000000000_create_embeddings_table.ts': `export default class extends BaseSchema {
  async up() {
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS "vector"')
  }
}
`,
    });

    await install(kernel, ['--no-json']);

    const compose = await readFile(join(path, 'compose.yml'), 'utf8');
    expect(compose).toContain('image: pgvector/pgvector:pg17');
    expect(output(kernel)).toContain(
      'database/migrations/1700000000000_create_embeddings_table.ts creates the pgvector extension',
    );
  });

  it('keeps the configured major when switching to pgvector', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': JSON.stringify({
        name: 'shop',
        dependencies: { pg: '^8' },
        sail: { images: { postgres: 'postgres:16' } },
      }),
    });
    await writeFiles(path, {
      'database/migrations/nested/0001_vector.sql': 'create extension vector;\n',
    });

    await install(kernel, ['--no-json']);

    expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain(
      'image: pgvector/pgvector:pg16',
    );
  });

  it('uses the image package.json configures', async () => {
    const { kernel, path } = await createTestApp({
      'package.json': JSON.stringify({
        name: 'shop',
        dependencies: { pg: '^8' },
        sail: { images: { postgres: 'postgis/postgis:17-3.5' } },
      }),
    });

    await install(kernel, ['--no-json']);

    expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain(
      'image: postgis/postgis:17-3.5',
    );
  });

  it('tells how to switch an existing postgres service it will not rewrite', async () => {
    const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
    await install(kernel, ['--no-json']);
    await writeFiles(path, {
      'database/migrations/0002_vector.ts':
        "this.schema.raw('create extension if not exists vector')",
    });

    await install(kernel, ['--no-json']);

    expect(await readFile(join(path, 'compose.yml'), 'utf8')).toContain('image: postgres:17');
    expect(output(kernel)).toContain(
      'compose.yml runs postgres:17 — set its image to pgvector/pgvector:pg17',
    );
  });
});

describe('sail:install — AGENTS.md', () => {
  it('leaves a translated section alone on re-runs', async () => {
    const { kernel, path } = await createTestApp();
    await install(kernel, ['--no-json', '--services=redis']);
    const generated = await readFile(join(path, 'AGENTS.md'), 'utf8');
    const translated = generated.replace(
      '## Sail (local dev services)',
      '## Sail (serviços locais de desenvolvimento)',
    );
    await writeFile(join(path, 'AGENTS.md'), translated, 'utf8');

    await install(kernel, ['--no-json', '--services=redis']);

    expect(await readFile(join(path, 'AGENTS.md'), 'utf8')).toBe(translated);
    expect(output(kernel)).toContain('AGENTS.md kept (edited by hand');
  });

  it('upgrades a 0.4 section that still holds the stock text', async () => {
    const { kernel, path } = await createTestApp();
    await install(kernel, ['--no-json', '--services=redis']);
    const current = await readFile(join(path, 'AGENTS.md'), 'utf8');
    const legacy = current.replace(/<!-- sail:start checksum=[0-9a-f]+ -->/, '<!-- sail:start -->');
    await writeFile(join(path, 'AGENTS.md'), legacy, 'utf8');

    await install(kernel, ['--no-json', '--services=redis']);

    expect(await readFile(join(path, 'AGENTS.md'), 'utf8')).toBe(current);
  });
});

describe('sail:install — .env newlines', () => {
  it('ends .env and .env.example with a newline, even when they did not', async () => {
    const { kernel, path } = await createTestApp({ 'package.json': packageJson({ pg: '^8' }) });
    await writeFiles(path, {
      'tsconfig.json': TSCONFIG,
      '.env': 'PORT=3333',
      '.env.example': 'PORT=3333',
    });

    await install(kernel, ['--no-json']);

    for (const file of ['.env', '.env.example']) {
      const content = await readFile(join(path, file), 'utf8');
      expect(content.startsWith('PORT=3333\nDB_HOST=127.0.0.1\n'), file).toBe(true);
      expect(content.endsWith('\n'), file).toBe(true);
      expect(content.endsWith('\n\n'), file).toBe(false);
    }
  });
});
