import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWorktreePortOffset } from '../src/ports.js';
import {
  isPortOpen,
  parseDotEnvPort,
  parseTunnelUrl,
  resolveSharePort,
  selectShareTarget,
} from '../src/share.js';

describe('parseTunnelUrl', () => {
  it('extracts the trycloudflare URL from tunnel logs', () => {
    expect(
      parseTunnelUrl('2026-09-07 INF + https://bright-dog-123.trycloudflare.com | Tunnel ready\n'),
    ).toBe('https://bright-dog-123.trycloudflare.com');
  });

  it('returns null until the tunnel registers', () => {
    expect(parseTunnelUrl('2026-09-07 INF Starting tunnel\n')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
  });
});

describe('parseDotEnvPort', () => {
  it('reads PORT tolerating export prefixes and quotes, last one wins', () => {
    expect(parseDotEnvPort('PORT=3333\n')).toBe(3333);
    expect(parseDotEnvPort(`export PORT="4000"\n`)).toBe(4000);
    expect(parseDotEnvPort(`PORT=3333\nPORT='5000'\n`)).toBe(5000);
  });

  it('ignores absent or insane values', () => {
    expect(parseDotEnvPort('HOST=localhost\n')).toBeNull();
    expect(parseDotEnvPort('PORT=abc\n')).toBeNull();
    expect(parseDotEnvPort('PORT=99999\n')).toBeNull();
    expect(parseDotEnvPort('PORT=\n')).toBeNull();
  });
});

describe('resolveSharePort', () => {
  it('falls back to 3333 with no dot-env files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-share-empty-'));
    await expect(resolveSharePort(dir, { nodeEnv: '' })).resolves.toEqual({
      port: 3333,
      basePort: 3333,
      offset: 0,
    });
  });

  it('follows loader priority and adds the worktree offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-share-prio-'));
    await writeFile(join(dir, '.env'), 'PORT=3333\n', 'utf8');
    await writeFile(join(dir, '.env.local'), 'PORT=4000\n', 'utf8');

    const offset = computeWorktreePortOffset('feature-login');
    await expect(
      resolveSharePort(dir, { nodeEnv: 'development', worktreeName: 'feature-login' }),
    ).resolves.toEqual({ port: 4000 + offset, basePort: 4000, offset });
  });

  it('skips .env.local under test, like the Adonis loader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-share-test-'));
    await writeFile(join(dir, '.env'), 'PORT=3333\n', 'utf8');
    await writeFile(join(dir, '.env.local'), 'PORT=4000\n', 'utf8');

    await expect(resolveSharePort(dir, { nodeEnv: 'test' })).resolves.toMatchObject({
      port: 3333,
      basePort: 3333,
    });
  });

  it('lets an explicit --port win over everything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-share-flag-'));
    await writeFile(join(dir, '.env'), 'PORT=3333\n', 'utf8');

    await expect(
      resolveSharePort(dir, { port: 8080, nodeEnv: 'development', worktreeName: 'x' }),
    ).resolves.toEqual({ port: 8080, basePort: 8080, offset: 0 });
  });
});

describe('selectShareTarget', () => {
  it('prefers the answering worktree port', () => {
    expect(selectShareTarget(4103, 3335, 768, true, true)).toEqual({
      target: 4103,
      resolvedFrom: 'worktree',
    });
  });

  it('falls back to the answering base port (core without worktree-port)', () => {
    expect(selectShareTarget(4103, 3335, 768, false, true)).toEqual({
      target: 3335,
      resolvedFrom: 'base-fallback',
    });
  });

  it('targets the worktree port unverified when nothing answers', () => {
    expect(selectShareTarget(4103, 3335, 768, false, false)).toEqual({
      target: 4103,
      resolvedFrom: 'unverified',
    });
  });

  it('never falls back in the main checkout', () => {
    expect(selectShareTarget(3335, 3335, 0, false, true)).toEqual({
      target: 3335,
      resolvedFrom: 'unverified',
    });
  });
});

describe('isPortOpen', () => {
  it('reports closed ports as closed', async () => {
    await expect(isPortOpen(1)).resolves.toBe(false);
  });

  it('reports a listening socket as open', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(isPortOpen(port)).resolves.toBe(true);
    server.close();
  });
});
