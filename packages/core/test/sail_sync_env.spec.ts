import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import SailSyncEnv from '../commands/sail_sync_env.js';
import { createTestApp, jsonOutput, output } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

const ENCRYPTED = 'DB_PASSWORD=varlock(local:Zm9vYmFy)\n';

function read(path: string, file: string) {
  return readFile(join(path, file), 'utf8');
}

describe('sail:sync-env', () => {
  it('writes the managed block into .env.local and .env.test.local', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailSyncEnv, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    for (const file of ['.env.local', '.env.test.local']) {
      const contents = await read(path, file);
      expect(contents).toContain('# sail:start');
      expect(contents).toContain('DB_PORT=5432');
      expect(contents).toContain('DB_PASSWORD=password');
      expect(contents).toContain('# sail:end');
    }
    expect(output(kernel)).toContain('.env.local created, .env.test.local created');
  });

  it('preserves everything outside the sail markers', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    await writeFile(join(path, '.env.local'), 'APP_KEY=hand-written\n', 'utf8');
    const command = await kernel.create(SailSyncEnv, ['--no-json']);
    await command.exec();

    const contents = await read(path, '.env.local');
    expect(contents.startsWith('APP_KEY=hand-written\n')).toBe(true);
    expect(contents).toContain('DB_HOST=127.0.0.1');
    expect(output(kernel)).toContain('.env.local updated');
  });

  it('git-ignores both local env files', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailSyncEnv, ['--json']);
    await command.exec();

    expect(await read(path, '.gitignore')).toBe('.env.local\n.env.test.local\n');
    expect(jsonOutput(kernel)).toMatchObject({ gitignore: 'updated' });
  });

  it('leaves an already-ignored .gitignore untouched', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    await writeFile(
      join(path, '.gitignore'),
      'node_modules\n.env.local\n/.env.test.local\n',
      'utf8',
    );
    const command = await kernel.create(SailSyncEnv, ['--json']);
    await command.exec();

    expect(await read(path, '.gitignore')).toBe('node_modules\n.env.local\n/.env.test.local\n');
    expect(jsonOutput(kernel)).toMatchObject({ gitignore: 'unchanged' });
  });

  it('re-runs without changing a byte', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    await (await kernel.create(SailSyncEnv, ['--no-json'])).exec();
    const first = await Promise.all([read(path, '.env.local'), read(path, '.env.test.local')]);

    const second = await kernel.create(SailSyncEnv, ['--no-json']);
    await second.exec();

    expect(second.exitCode).toBe(0);
    expect(await read(path, '.env.local')).toBe(first[0]);
    expect(await read(path, '.env.test.local')).toBe(first[1]);
    expect(output(kernel)).toContain('.env.local unchanged, .env.test.local unchanged');
  });

  it('fails with the install hint when no service is enabled', async () => {
    const { kernel, path } = await createTestApp();
    const command = await kernel.create(SailSyncEnv, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('No sail services enabled for this app');
    expect(output(kernel)).toContain('node ace sail:install');
    await expect(read(path, '.env.local')).rejects.toThrow();
  });

  it('skips an encrypted .env.local and exits 1', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    await writeFile(join(path, '.env.local'), ENCRYPTED, 'utf8');
    const command = await kernel.create(SailSyncEnv, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(await read(path, '.env.local')).toBe(ENCRYPTED);
    expect(output(kernel)).toContain('.env.local looks encrypted — ports NOT synced there');
    // The unencrypted sibling is still synced: only the ciphertext is off limits.
    expect(await read(path, '.env.test.local')).toContain('DB_PORT=5432');
  });

  it('exits 1 for an encrypted .env.local under --json too', async () => {
    // Regression: the JSON path used to return before the exit code was set,
    // so agents read success while humans got a failure for the same state.
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    await writeFile(join(path, '.env.local'), ENCRYPTED, 'utf8');
    const command = await kernel.create(SailSyncEnv, ['--json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(await read(path, '.env.local')).toBe(ENCRYPTED);
    expect(jsonOutput(kernel)).toMatchObject({
      files: [
        { file: '.env.local', action: 'skipped-encrypted' },
        { file: '.env.test.local', action: 'created' },
      ],
    });
  });

  it('reports a skipped file as skipped, not synced, under --json', async () => {
    // The payload has to agree with the exit code: a run that left a file
    // alone did not do what it was asked, and it exits 1.
    const { kernel } = await createTestApp({
      'compose.yml': composeFile,
      '.env.local': 'DB_PASSWORD=varlock(local:ABC123)\n',
    });
    const command = await kernel.create(SailSyncEnv, ['--json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toMatchObject({
      status: 'skipped',
      files: expect.arrayContaining([{ file: '.env.local', action: 'skipped-encrypted' }]),
    });
  });

  it('prints the synced files, keys and varlock detection under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailSyncEnv, ['--json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      status: 'synced',
      files: [
        { file: '.env.local', action: 'created' },
        { file: '.env.test.local', action: 'created' },
      ],
      gitignore: 'updated',
      keys: ['DB_DATABASE', 'DB_HOST', 'DB_PASSWORD', 'DB_PORT', 'DB_USER'],
      varlock: { inUse: false, schemaPath: null, via: null },
    });
  });
});
