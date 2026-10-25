import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import SailServe from '../commands/sail_serve.js';
import { readServeState, servePaths, stopServe } from '../src/serve.js';
import { isPortOpen } from '../src/share.js';
import { createTestApp, jsonOutput } from './helpers/ace.js';

/**
 * End to end against a real process: the throwaway app's `ace` is a stand-in
 * that forks a child (as `serve` does) and answers HTTP on `PORT` — so start,
 * reuse, status and stop all run against something that really listens and
 * really dies. Only `$SAIL_HOME` is redirected, so no test touches ~/.sail.
 */
const ACE_THAT_SERVES = [
  "const { fork } = require('node:child_process');",
  "if (process.argv[2] === 'child') {",
  "  require('node:http').createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
  '} else {',
  "  fork(__filename, ['child']); console.log('serve', process.argv.slice(3).join(' '), 'by', process.env.SAIL_SERVE_BY);",
  '}',
].join('\n');

const ACE_THAT_CRASHES = "console.error('E_MISSING_ENV_VALUE: APP_KEY'); process.exit(1);";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let previousHome: string | undefined;
let blockers: Server[] = [];

beforeEach(async () => {
  previousHome = process.env.SAIL_HOME;
  process.env.SAIL_HOME = await mkdtemp(join(tmpdir(), 'sail-serve-cmd-home-'));
});

afterEach(async () => {
  // Never leave a background app behind, whatever the test did.
  const home = process.env.SAIL_HOME as string;
  const paths = servePaths('shop', home);
  const leftover = await readServeState(paths);
  if (leftover) {
    await stopServe(leftover, paths, { graceMs: 2000 });
  }
  for (const server of blockers) {
    server.close();
  }
  blockers = [];
  if (previousHome === undefined) {
    delete process.env.SAIL_HOME;
  } else {
    process.env.SAIL_HOME = previousHome;
  }
});

async function app(ace = ACE_THAT_SERVES) {
  const port = await freePort();
  const { kernel, path } = await createTestApp({ ace, '.env': `PORT=${port}\n` });
  const run = async (...args: string[]) => {
    const command = await kernel.create(SailServe, ['--json', ...args]);
    kernel.ui.logger.flushLogs();
    await command.exec();
    return { exitCode: command.exitCode, json: jsonOutput(kernel) as Record<string, any> };
  };
  return { port, path, run };
}

describe('sail:serve', () => {
  it('starts the app detached on the resolved port, then reuses it', async () => {
    const { port, run } = await app();

    const first = await run('--by', 'theo');
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({
      running: true,
      reused: false,
      port,
      local: `http://127.0.0.1:${port}`,
      mode: 'hmr',
      startedBy: 'theo',
      projectName: 'shop',
    });
    expect(await isPortOpen(port)).toBe(true);

    const second = await run('--by', 'quinn');
    expect(second.exitCode).toBe(0);
    expect(second.json).toMatchObject({
      running: true,
      reused: true,
      pid: first.json.pid,
      startedBy: 'theo',
    });
  });

  it('reports status without starting anything', async () => {
    const { run } = await app();

    expect((await run('--status')).json).toEqual({ running: false, projectName: 'shop' });

    const started = await run();
    const status = await run('--status');
    expect(status.json).toMatchObject({ running: true, health: 'running', pid: started.json.pid });
  });

  it('stops the whole process group and frees the port', async () => {
    const { port, run } = await app();
    await run();

    const stopped = await run('--stop');
    expect(stopped.json).toEqual({ projectName: 'shop', stopped: true, forced: false });
    expect(await isPortOpen(port)).toBe(false);
    expect((await run('--stop')).json).toEqual({
      projectName: 'shop',
      stopped: false,
      forced: false,
    });
  });

  it('restarts into a new process', async () => {
    const { run } = await app();
    const first = await run();

    const restarted = await run('--restart');
    expect(restarted.exitCode).toBe(0);
    expect(restarted.json).toMatchObject({ running: true, reused: false });
    expect(restarted.json.pid).not.toBe(first.json.pid);
  });

  it('passes the serve mode through', async () => {
    const { run } = await app();

    expect((await run('--watch')).json).toMatchObject({ mode: 'watch' });
  });

  it('refuses a port held by a process it did not start', async () => {
    const { port, run } = await app();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    blockers.push(blocker);

    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toBe(
      `Port ${port} is already in use by a process sail:serve did not start`,
    );
  });

  it('fails with the log tail when the app dies before answering', async () => {
    const { run } = await app(ACE_THAT_CRASHES);

    const result = await run('--wait', '10');
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toMatch(/exited before answering/);
    expect(result.json.hint).toContain('E_MISSING_ENV_VALUE: APP_KEY');
    expect(await readServeState(servePaths('shop'))).toBeNull();
  });

  it('rejects more than one mode flag', async () => {
    const { run } = await app();

    const result = await run('--stop', '--restart');
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toBe('Choose one of --status, --stop or --restart');
  });
});
