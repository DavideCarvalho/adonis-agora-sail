import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import SailShare from '../commands/sail_share.js';
import { computeWorktreePortOffset } from '../src/ports.js';
import type { SailContext } from '../src/types.js';
import { createTestApp, jsonOutput, logs, output } from './helpers/ace.js';

const share = vi.hoisted(() => ({ cloudflaredAvailable: true, openPorts: [] as number[] }));

/**
 * Only the two functions that reach outside the process are replaced: the
 * port arithmetic under test (`resolveSharePort`, `selectShareTarget`) and the
 * URL scraping stay real.
 */
vi.mock('../src/share.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/share.js')>();

  return {
    ...actual,
    checkCloudflared: () =>
      Promise.resolve(
        share.cloudflaredAvailable
          ? null
          : `cloudflared is not installed or not on PATH. ${actual.CLOUDFLARED_INSTALL_HINT}`,
      ),
    isPortOpen: (port: number) => Promise.resolve(share.openPorts.includes(port)),
  };
});

const tunnel = vi.hoisted(() => ({
  spawns: [] as { command: string; args: string[] }[],
  output: 'INF |  https://calm-fox-1234.trycloudflare.com  |\n',
  exitCode: 0,
}));

/**
 * Only `spawn` is replaced — `execFile` stays real, because worktree
 * detection shells out through it.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');

  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      tunnel.spawns.push({ command, args });

      const child: any = new Emitter();
      child.stdout = new Emitter();
      child.stderr = new Emitter();
      child.kill = () => true;

      // The log line and the exit have to land in separate macrotasks: the
      // command only listens for `close` after the URL scan has resolved.
      setTimeout(() => {
        if (tunnel.output) {
          child.stderr.emit('data', Buffer.from(tunnel.output));
        }
        setTimeout(() => child.emit('close', tunnel.exitCode), 0);
      }, 0);

      return child;
    },
  };
});

/** A context as if the app were checked out in a linked worktree. */
function worktreeContext(name: string): SailContext {
  return {
    appName: 'shop',
    projectName: `shop-${name}`,
    worktree: { name, slug: name, hash: 'abcdef123456', path: `/tmp/${name}` },
    portOffset: computeWorktreePortOffset(name),
    composeFilePath: '/tmp/compose.yml',
  };
}

const OFFSET = computeWorktreePortOffset('feature-x');

describe('sail:share', () => {
  // The command forwards the tunnel's own logs to stderr; captured so the
  // suite stays quiet and so one test can assert they went there.
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    share.cloudflaredAvailable = true;
    share.openPorts = [];
    tunnel.spawns = [];
    tunnel.output = 'INF |  https://calm-fox-1234.trycloudflare.com  |\n';
    tunnel.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shares the worktree serve port derived from the dot-env PORT', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });
    share.openPorts = [4000 + OFFSET];

    const command = await kernel.create(SailShare, ['--json']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      url: 'https://calm-fox-1234.trycloudflare.com',
      local: `http://127.0.0.1:${4000 + OFFSET}`,
      port: 4000 + OFFSET,
      basePort: 4000,
      portOffset: OFFSET,
      resolvedFrom: 'worktree',
    });
    expect(tunnel.spawns).toEqual([
      { command: 'cloudflared', args: ['tunnel', '--url', `http://127.0.0.1:${4000 + OFFSET}`] },
    ]);
    expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes('trycloudflare.com'))).toBe(
      true,
    );
  });

  it('reads PORT from the first dot-env file in loader priority', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n', '.env.local': 'PORT=5000\n' });
    share.openPorts = [5000];

    const command = await kernel.create(SailShare, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({
      local: 'http://127.0.0.1:5000',
      basePort: 5000,
      portOffset: 0,
      resolvedFrom: 'worktree',
    });
  });

  it('shares the port given by --port instead of the resolved one', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });
    share.openPorts = [4100];

    const command = await kernel.create(SailShare, ['--json', '--port', '4100']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({
      local: 'http://127.0.0.1:4100',
      port: 4100,
      basePort: 4100,
      portOffset: 0,
    });
  });

  it('fails with the install hint when cloudflared is missing', async () => {
    share.cloudflaredAvailable = false;
    const { kernel } = await createTestApp();

    const command = await kernel.create(SailShare, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('cloudflared is not installed or not on PATH');
    expect(output(kernel)).toContain('brew install cloudflare/cloudflare/cloudflared');
    expect(tunnel.spawns).toEqual([]);
  });

  it('falls back to the base PORT when only that one answers in a worktree', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });
    share.openPorts = [4000];

    const command = await kernel.create(SailShare, ['--no-json']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain(`worktree port :${4000 + OFFSET} is closed`);
    expect(output(kernel)).toContain('base PORT :4000 answers');
    expect(tunnel.spawns).toEqual([
      { command: 'cloudflared', args: ['tunnel', '--url', 'http://127.0.0.1:4000'] },
    ]);
  });

  it('warns but still shares the worktree port when nothing is listening', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });

    const command = await kernel.create(SailShare, ['--no-json']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain(`Nothing is listening on :${4000 + OFFSET}`);
    expect(output(kernel)).toContain('continuing anyway');
    expect(tunnel.spawns).toEqual([
      {
        command: 'cloudflared',
        args: ['tunnel', '--url', `http://127.0.0.1:${4000 + OFFSET}`],
      },
    ]);
  });

  it('carries the base-fallback notice inside the single JSON document (regression)', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });
    share.openPorts = [4000];

    const command = await kernel.create(SailShare, ['--json']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(logs(kernel)).toHaveLength(1);
    expect(jsonOutput(kernel)).toMatchObject({
      local: 'http://127.0.0.1:4000',
      port: 4000,
      basePort: 4000,
      portOffset: OFFSET,
      resolvedFrom: 'base-fallback',
      notice: expect.stringContaining('base PORT :4000 answers'),
    });
  });

  it('carries the unverified warning inside the single JSON document (regression)', async () => {
    const { kernel } = await createTestApp({ '.env': 'PORT=4000\n' });

    const command = await kernel.create(SailShare, ['--json']);
    vi.spyOn(command, 'sailContext').mockResolvedValue(worktreeContext('feature-x'));
    await command.exec();

    expect(logs(kernel)).toHaveLength(1);
    expect(jsonOutput(kernel)).toMatchObject({
      port: 4000 + OFFSET,
      resolvedFrom: 'unverified',
      warning: expect.stringContaining(`Nothing is listening on :${4000 + OFFSET}`),
    });
  });

  it('fails when cloudflared never prints a tunnel URL', async () => {
    tunnel.output = '';
    const { kernel } = await createTestApp();
    share.openPorts = [3333];

    const command = await kernel.create(SailShare, ['--json']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toEqual({
      error: 'cloudflared did not print a tunnel URL in time',
      hint: 'Check your network and re-run (tunnel logs above, on stderr)',
    });
  });

  it('propagates the exit code of the tunnel process', async () => {
    tunnel.exitCode = 2;
    const { kernel } = await createTestApp();
    share.openPorts = [3333];

    const command = await kernel.create(SailShare, ['--json']);
    await command.exec();

    expect(command.exitCode).toBe(2);
    expect(jsonOutput(kernel)).toMatchObject({ url: 'https://calm-fox-1234.trycloudflare.com' });
  });

  it('defaults to port 3333 when no dot-env PORT is set', async () => {
    const { kernel } = await createTestApp();
    share.openPorts = [3333];

    const command = await kernel.create(SailShare, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({
      local: 'http://127.0.0.1:3333',
      basePort: 3333,
      portOffset: 0,
    });
  });
});
