import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import SailInfo from '../commands/sail_info.js';
import { createTestApp, jsonOutput, output } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

describe('sail:info', () => {
  it('reports the stack for the current worktree', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailInfo, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('postgres');
  });

  it('fails with the fix when nothing is enabled', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailInfo, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('No sail services enabled for this app');
  });

  it('prints one JSON document under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailInfo, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({ appName: 'shop', portOffset: 0 });
  });

  it('prints bare KEY=value lines under --env', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailInfo, ['--env', '--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    // Meant for `eval $(node ace sail:info --env)`: sorted keys, nothing else.
    expect(output(kernel)).toBe(
      [
        'DB_DATABASE=app',
        'DB_HOST=127.0.0.1',
        'DB_PASSWORD=password',
        'DB_PORT=5432',
        'DB_USER=sail',
      ].join('\n'),
    );
  });

  it('lets --env win over --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailInfo, ['--env', '--json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('DB_PORT=5432');
    expect(output(kernel)).not.toContain('{');
  });

  it('points at varlock when the app has a .env.schema', async () => {
    const { kernel } = await createTestApp({
      'compose.yml': composeFile,
      '.env.schema': '# ---\nDB_PORT=5432\n',
    });
    const command = await kernel.create(SailInfo, ['--no-json']);
    await command.exec();

    expect(output(kernel)).toContain('varlock detected — boot with `varlock run --');
  });

  it('tells you to just boot the app when varlock is not in use', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailInfo, ['--no-json']);
    await command.exec();

    expect(output(kernel)).toContain('.env.local is synced by sail:up / sail:sync-env');
    expect(output(kernel)).not.toContain('varlock detected');
  });

  it('carries the scan and the varlock detection in the JSON payload', async () => {
    const { kernel } = await createTestApp({
      'compose.yml': composeFile,
      '.env.schema': '# ---\nDB_PORT=5432\n',
    });
    const command = await kernel.create(SailInfo, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({
      scan: { services: [], evidence: [] },
      varlock: { inUse: true, via: 'schema' },
    });
  });

  it('summarizes the config scan under the stack', async () => {
    const { kernel, path } = await createTestApp({
      'compose.yml': composeFile,
      'package.json': JSON.stringify({ name: 'shop', dependencies: { pg: '^8.16.0' } }),
    });
    await mkdir(join(path, 'config'));
    await writeFile(
      join(path, 'config', 'database.ts'),
      "export default { connections: { postgres: { client: 'pg', connection: { host: env.get('DB_HOST'), port: env.get('DB_PORT') } } } }\n",
      'utf8',
    );
    const command = await kernel.create(SailInfo, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('CONFIG SCAN (start/env.ts + config/*.ts)');
    expect(output(kernel)).toContain('postgres — package.json:pg, database.ts:pg client');
    expect(output(kernel)).toContain(
      'start/env.ts declares 0 keys, configs use 2, missing: DB_HOST, DB_PORT',
    );
  });
});
