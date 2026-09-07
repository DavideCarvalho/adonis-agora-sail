import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  baseAppEnv,
  buildSailEnvBlock,
  buildSchemaSection,
  detectVarlock,
  ensureGitignoreEntry,
  ensureSchemaSection,
  isEncryptedEnvContent,
  sailEnvKeys,
  syncSailLocalEnv,
  upsertSailEnvBlock,
} from '../src/varlock.js';

describe('detectVarlock', () => {
  it('detects via .env.schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-schema-'));
    await writeFile(join(dir, '.env.schema'), '# @tag(test)\nAPP_ENV=development\n', 'utf8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }), 'utf8');

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection.inUse).toBe(true);
    expect(detection.via).toBe('schema');
    expect(detection.schemaPath).toBe(join(dir, '.env.schema'));
  });

  it('detects via the varlock dependency (even without a schema file yet)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-dep-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'shop', devDependencies: { varlock: '^1.0.0' } }),
      'utf8',
    );

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection).toMatchObject({ inUse: true, via: 'dependency', schemaPath: null });
  });

  it('reports false with neither signal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-nope-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }), 'utf8');

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection).toMatchObject({ inUse: false, via: null, schemaPath: null });
  });
});

describe('sailEnvKeys / baseAppEnv', () => {
  it('unions keys across services without duplicates', () => {
    expect(sailEnvKeys(['postgres', 'redis'])).toEqual([
      'DB_HOST',
      'DB_PORT',
      'DB_USER',
      'DB_PASSWORD',
      'DB_DATABASE',
      'REDIS_HOST',
      'REDIS_PORT',
    ]);
  });

  it('uses main-checkout ports as defaults', () => {
    expect(baseAppEnv(['postgres', 'redis'])).toMatchObject({
      DB_PORT: '5432',
      REDIS_PORT: '6379',
    });
  });
});

describe('buildSchemaSection', () => {
  it('declares typed, tagged items with base defaults', () => {
    const section = buildSchemaSection(['redis']);
    expect(section).toContain('# sail:schema:start');
    expect(section).toContain('# sail:schema:end');
    expect(section).toContain('# @tag(sail)');
    expect(section).toContain('# @type=number');
    expect(section).toContain('REDIS_PORT=6379');
    expect(section).toContain('REDIS_HOST=127.0.0.1');
  });

  it('marks coordinates @public and keeps credentials sensitive', () => {
    const section = buildSchemaSection(['postgres', 'minio']);
    // Hosts, ports, buckets, regions, endpoints are loopback dev addresses —
    // public, so log redaction leaves them readable.
    expect(section).toMatch(/# @public\nDB_HOST=127\.0\.0\.1/);
    expect(section).toMatch(/# @public\n# @type=number\nDB_PORT=5432/);
    expect(section).toMatch(/# @public\nS3_BUCKET=local/);
    // Credentials stay sensitive by default (no @public on their block).
    const passwordBlock = section.split('\n').findIndex((line) => line === 'DB_PASSWORD=password');
    expect(passwordBlock).toBeGreaterThan(0);
    expect(section.split('\n')[passwordBlock - 1]).not.toBe('# @public');
    expect(section).not.toMatch(/# @public\nAWS_SECRET_ACCESS_KEY/);
  });
});

describe('ensureSchemaSection', () => {
  it('creates a minimal schema when there is none', () => {
    const { content, added } = ensureSchemaSection(null, ['redis']);
    expect(added).toEqual(['REDIS_HOST', 'REDIS_PORT']);
    expect(content).toContain('REDIS_PORT=6379');
    expect(content).toContain('# sail:schema:start');
  });

  it('appends only missing keys and preserves user declarations', () => {
    const existing = '# @type=string\nDB_HOST=db.internal\n';
    const { content, added } = ensureSchemaSection(existing, ['postgres']);
    expect(added).toEqual(['DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(content).toContain('DB_HOST=db.internal');
    expect(content).toContain('DB_PORT=5432');
    expect(content.match(/^DB_HOST=/gm)).toHaveLength(1);
  });

  it('is a no-op when every key is already declared', () => {
    const { content } = ensureSchemaSection(null, ['redis']);
    expect(ensureSchemaSection(content, ['redis']).added).toEqual([]);
    expect(ensureSchemaSection(content, ['redis']).content).toBe(content);
  });

  it('inserts later services into the existing marker block', () => {
    const { content: once } = ensureSchemaSection(null, ['redis']);
    const { content: twice, added } = ensureSchemaSection(once, ['redis', 'postgres']);
    expect(added).toEqual(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(twice.match(/# sail:schema:start/g)).toHaveLength(1);
    expect(twice).toContain('DB_PORT=5432');
  });
});

describe('buildSailEnvBlock / upsertSailEnvBlock', () => {
  const block = buildSailEnvBlock({ DB_PORT: '5555', DB_HOST: '127.0.0.1' });

  it('renders sorted KEY=value lines between markers', () => {
    expect(block).toBe(
      [
        '# sail:start',
        '# Managed by @adonis-agora/sail — per-worktree service ports. Do not edit;',
        '# re-run `node ace sail:sync-env` to refresh.',
        'DB_HOST=127.0.0.1',
        'DB_PORT=5555',
        '# sail:end',
      ].join('\n'),
    );
  });

  it('creates the file body when there is none', () => {
    expect(upsertSailEnvBlock(null, block)).toBe(`${block}\n`);
  });

  it('replaces the block in place and preserves everything else', () => {
    const existing = `# user stuff\nAPP_ENV=development\n\n${block}\n`;
    const refreshed = buildSailEnvBlock({ DB_PORT: '5556', DB_HOST: '127.0.0.1' });
    const next = upsertSailEnvBlock(existing, refreshed);
    expect(next).toContain('APP_ENV=development');
    expect(next).toContain('DB_PORT=5556');
    expect(next).not.toContain('DB_PORT=5555');
    expect(next.match(/# sail:start/g)).toHaveLength(1);
  });
});

describe('isEncryptedEnvContent', () => {
  it('flags ciphertext entries and passes plaintext through', () => {
    expect(isEncryptedEnvContent('SECRET=varlock(local:ABC123...)\n')).toBe(true);
    expect(isEncryptedEnvContent('DB_PORT=5555\n')).toBe(false);
  });
});

describe('ensureGitignoreEntry', () => {
  it('creates the body when missing and appends otherwise', () => {
    expect(ensureGitignoreEntry(null)).toEqual({ content: '.env.local\n', changed: true });
    expect(ensureGitignoreEntry('node_modules\n')).toEqual({
      content: 'node_modules\n.env.local\n',
      changed: true,
    });
  });

  it('leaves existing entries alone', () => {
    expect(ensureGitignoreEntry('.env.local\n').changed).toBe(false);
    expect(ensureGitignoreEntry('/.env.local\n').changed).toBe(false);
    // similarly-named entries do not count
    expect(ensureGitignoreEntry('.env.local.example\n').changed).toBe(true);
  });
});

describe('syncSailLocalEnv', () => {
  it('creates .env.local and .gitignore on a fresh checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-fresh-'));

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('created');
    expect(result.gitignore).toBe('updated');
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toContain('DB_PORT=5432');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.env.local');
  });

  it('is a no-op when ports did not change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-idem-'));
    await syncSailLocalEnv(dir, { DB_PORT: '5432' });

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('unchanged');
  });

  it('skips encrypted files instead of corrupting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-enc-'));
    await writeFile(join(dir, '.env.local'), 'SECRET=varlock(local:ABC123...)\n', 'utf8');

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('skipped-encrypted');
    expect(await readFile(join(dir, '.env.local'), 'utf8')).not.toContain('DB_PORT');
  });
});
