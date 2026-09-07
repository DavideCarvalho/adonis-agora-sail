import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dotenvKeysPresent,
  readDotEnvKeySets,
  syncSailLocalEnvs,
  upsertDotEnvKeys,
} from '../src/dotenv.js';

describe('dotenvKeysPresent', () => {
  it('reads KEY= lines and ignores comments', () => {
    expect(dotenvKeysPresent('# comment\nDB_HOST=127.0.0.1\n\nEMPTY=\n')).toEqual(
      new Set(['DB_HOST', 'EMPTY']),
    );
  });
});

describe('upsertDotEnvKeys', () => {
  it('creates the body when there is none', () => {
    expect(upsertDotEnvKeys(null, { DB_PORT: '5432' })).toBe('DB_PORT=5432\n');
  });

  it('replaces values in place and preserves comments and order', () => {
    const next = upsertDotEnvKeys('# db\nDB_HOST=remote\nDB_PORT=5432\nAPP_KEY=x\n', {
      DB_PORT: '5555',
    });
    expect(next).toBe('# db\nDB_HOST=remote\nDB_PORT=5555\nAPP_KEY=x\n');
  });

  it('appends missing keys at the end', () => {
    expect(upsertDotEnvKeys('APP_KEY=x\n', { DB_PORT: '5432' })).toBe('APP_KEY=x\nDB_PORT=5432\n');
  });

  it('returns the input unchanged when every value already matches', () => {
    const existing = 'DB_PORT=5432\n';
    expect(upsertDotEnvKeys(existing, { DB_PORT: '5432' })).toBe(existing);
  });

  it('is a no-op for an empty value set', () => {
    expect(upsertDotEnvKeys('DB_PORT=5432\n', {})).toBe('DB_PORT=5432\n');
  });
});

describe('readDotEnvKeySets', () => {
  it('reads both files, tolerating absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-dotenv-keys-'));
    await writeFile(join(dir, '.env'), 'DB_PORT=5432\n', 'utf8');

    const sets = await readDotEnvKeySets(dir);
    expect(sets.env).toEqual(new Set(['DB_PORT']));
    expect(sets.example).toEqual(new Set());
  });
});

describe('syncSailLocalEnvs', () => {
  it('writes the managed block to .env.local and .env.test.local and git-ignores both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-local-sync-'));

    const result = await syncSailLocalEnvs(dir, { DB_PORT: '5555' });
    expect(result.files).toEqual([
      { file: '.env.local', action: 'created' },
      { file: '.env.test.local', action: 'created' },
    ]);
    expect(result.gitignore).toBe('updated');

    for (const file of ['.env.local', '.env.test.local']) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content).toContain('# sail:start');
      expect(content).toContain('DB_PORT=5555');
    }
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env.local');
    expect(gitignore).toContain('.env.test.local');
  });

  it('is a no-op when ports did not change and preserves user content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-local-idem-'));
    await writeFile(join(dir, '.env.local'), 'APP_KEY=secret\n', 'utf8');
    await syncSailLocalEnvs(dir, { DB_PORT: '5555' });

    const result = await syncSailLocalEnvs(dir, { DB_PORT: '5555' });
    expect(result.files).toEqual([
      { file: '.env.local', action: 'unchanged' },
      { file: '.env.test.local', action: 'unchanged' },
    ]);
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toContain('APP_KEY=secret');
  });

  it('skips encrypted files per file instead of corrupting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-local-enc-'));
    await writeFile(join(dir, '.env.local'), 'SECRET=varlock(local:ABC123...)\n', 'utf8');

    const result = await syncSailLocalEnvs(dir, { DB_PORT: '5555' });
    expect(result.files).toEqual([
      { file: '.env.local', action: 'skipped-encrypted' },
      { file: '.env.test.local', action: 'created' },
    ]);
    expect(await readFile(join(dir, '.env.local'), 'utf8')).not.toContain('DB_PORT');
  });
});
