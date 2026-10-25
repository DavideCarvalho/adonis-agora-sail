import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireServeLock,
  clearServeState,
  isProcessAlive,
  isValidPort,
  readServeState,
  type ServeState,
  serveArgs,
  serveHealth,
  serveLogTail,
  servePaths,
  startServe,
  stopServe,
  waitForServe,
  writeServeState,
} from '../src/serve.js';

/** A port nothing listens on: bind 0, read it, release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function sailHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sail-serve-home-'));
}

function state(overrides: Partial<ServeState> = {}): ServeState {
  return {
    projectName: 'shop-feature',
    appRoot: '/apps/shop',
    pid: 4242,
    port: 3456,
    local: 'http://127.0.0.1:3456',
    mode: 'hmr',
    logFile: '/tmp/shop-feature.log',
    startedAt: '2026-10-25T12:00:00.000Z',
    startedBy: null,
    ...overrides,
  };
}

const started: ServeState[] = [];
afterEach(async () => {
  for (const entry of started.splice(0)) {
    await stopServe(entry, servePaths(entry.projectName, join(entry.logFile, '..', '..')), {
      graceMs: 2000,
    });
  }
});

describe('servePaths / serveArgs', () => {
  it('keys state and log by compose project under <home>/serve', () => {
    expect(servePaths('shop-feature', '/h')).toEqual({
      dir: '/h/serve',
      stateFile: '/h/serve/shop-feature.json',
      logFile: '/h/serve/shop-feature.log',
      lockFile: '/h/serve/shop-feature.lock',
    });
  });

  it('maps each mode to its serve flags', () => {
    expect(serveArgs('hmr')).toEqual(['ace', 'serve', '--hmr']);
    expect(serveArgs('watch')).toEqual(['ace', 'serve', '--watch']);
    expect(serveArgs('plain')).toEqual(['ace', 'serve']);
  });
});

describe('serve state file', () => {
  it('round-trips, and reads a missing or broken file as null', async () => {
    const paths = servePaths('shop', await sailHome());
    expect(await readServeState(paths)).toBeNull();

    await writeServeState(paths, state());
    expect(await readServeState(paths)).toEqual(state());

    await writeFile(paths.stateFile, '{not json', 'utf8');
    expect(await readServeState(paths)).toBeNull();

    await clearServeState(paths);
    expect(await readServeState(paths)).toBeNull();
  });
});

describe('serveHealth / waitForServe', () => {
  it('is dead when the pid is gone, starting while the port is closed, running once it answers', async () => {
    expect(await serveHealth(state(), { alive: () => false, portOpen: async () => true })).toBe(
      'dead',
    );
    expect(await serveHealth(state(), { alive: () => true, portOpen: async () => false })).toBe(
      'starting',
    );
    expect(await serveHealth(state(), { alive: () => true, portOpen: async () => true })).toBe(
      'running',
    );
  });

  it('polls until the port opens', async () => {
    let probes = 0;
    const health = await waitForServe(state(), 10_000, {
      alive: () => true,
      portOpen: async () => ++probes >= 3,
      sleep: async () => {},
    });
    expect(health).toBe('running');
    expect(probes).toBe(3);
  });

  it('gives up as starting when the timeout passes', async () => {
    expect(await waitForServe(state(), 0, { alive: () => true, portOpen: async () => false })).toBe(
      'starting',
    );
  });

  it('reports this process as alive and a bogus pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('stopServe', () => {
  it('signals the process group, escalates to SIGKILL after the grace period and clears the state', async () => {
    const paths = servePaths('shop', await sailHome());
    await writeServeState(paths, state());
    const signals: [number, string][] = [];

    const result = await stopServe(state(), paths, {
      graceMs: 0,
      alive: () => true,
      kill: (pid, signal) => void signals.push([pid, signal]),
      sleep: async () => {},
    });

    expect(signals).toEqual([
      [-4242, 'SIGINT'],
      [-4242, 'SIGKILL'],
    ]);
    expect(result).toEqual({ stopped: true, forced: true });
    expect(await readServeState(paths)).toBeNull();
  });

  it('only clears the state of a process that is already gone', async () => {
    const paths = servePaths('shop', await sailHome());
    await writeServeState(paths, state());
    const signals: string[] = [];

    const result = await stopServe(state(), paths, {
      alive: () => false,
      kill: (_pid, signal) => void signals.push(signal),
    });

    expect(signals).toEqual([]);
    expect(result).toEqual({ stopped: false, forced: false });
    expect(await readServeState(paths)).toBeNull();
  });
});

describe('startServe', () => {
  it('spawns `node ace serve` detached in the app, with PORT forced and the caller env on top', async () => {
    const paths = servePaths('shop-feature', await sailHome());
    const calls: { command: string; args: string[]; options: any }[] = [];
    const fakeSpawn: any = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      const child: any = new EventEmitter();
      child.pid = 9999;
      child.unref = () => {};
      return child;
    };

    const result = await startServe({
      appRoot: '/apps/shop',
      projectName: 'shop-feature',
      port: 4123,
      mode: 'hmr',
      startedBy: 'theo',
      paths,
      env: { VITE_API_URL: 'https://preview.example', PORT: '1' },
      spawn: fakeSpawn,
      now: () => new Date('2026-10-25T12:00:00.000Z'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args).toEqual(['ace', 'serve', '--hmr']);
    expect(calls[0]?.options.cwd).toBe('/apps/shop');
    expect(calls[0]?.options.detached).toBe(true);
    expect(calls[0]?.options.env.PORT).toBe('4123');
    expect(calls[0]?.options.env.VITE_API_URL).toBe('https://preview.example');
    expect(result).toMatchObject({
      pid: 9999,
      port: 4123,
      local: 'http://127.0.0.1:4123',
      startedBy: 'theo',
    });
    expect(JSON.parse(await readFile(paths.stateFile, 'utf8'))).toEqual(result);
  });

  it('runs a real detached app that answers on PORT, and stopServe takes the whole group down', async () => {
    const home = await sailHome();
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-serve-app-'));
    // Stand-in for `ace`: forks a child (like serve does) and answers HTTP on PORT.
    await writeFile(
      join(appRoot, 'ace'),
      [
        "const { fork } = require('node:child_process');",
        "if (process.argv[2] === 'child') {",
        "  require('node:http').createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
        '} else {',
        "  fork(__filename, ['child']); console.log('serving', process.argv.slice(2).join(' '));",
        '}',
      ].join('\n'),
      'utf8',
    );
    const port = await freePort();
    const paths = servePaths('real-app', home);

    const entry = await startServe({
      appRoot,
      projectName: 'real-app',
      port,
      mode: 'hmr',
      startedBy: null,
      paths,
    });
    started.push(entry);

    expect(await waitForServe(entry, 15_000)).toBe('running');
    expect(await serveLogTail(paths)).toContain('serving serve --hmr');

    const result = await stopServe(entry, paths, { graceMs: 5000 });
    started.splice(0);
    expect(result.stopped).toBe(true);
    expect(isProcessAlive(entry.pid)).toBe(false);
    expect(await serveHealth(entry)).toBe('dead');
  });
});

describe('state validation', () => {
  it('rejects entries whose pid could signal a whole group, or whose port is not a port', async () => {
    const paths = servePaths('shop', await sailHome());
    for (const bad of [
      { pid: 0 },
      { pid: 1 },
      { pid: -5 },
      { port: 0 },
      { port: 70_000 },
      { pid: 1.5 },
    ]) {
      await writeServeState(paths, state(bad));
      expect(await readServeState(paths)).toBeNull();
    }
    expect(isValidPort(3333)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65_536)).toBe(false);
  });
});

describe('acquireServeLock', () => {
  it('is exclusive: a second caller waits until the first releases', async () => {
    const paths = servePaths('shop', await sailHome());
    const releaseFirst = await acquireServeLock(paths, { timeoutMs: 1000 });
    let secondHeld = false;
    const second = acquireServeLock(paths, { timeoutMs: 5000 }).then((release) => {
      secondHeld = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(secondHeld).toBe(false);
    await releaseFirst();
    const releaseSecond = await second;
    expect(secondHeld).toBe(true);
    await releaseSecond();
  });

  it('times out while a live holder keeps it', async () => {
    const paths = servePaths('shop', await sailHome());
    const release = await acquireServeLock(paths, { timeoutMs: 1000 });
    await expect(acquireServeLock(paths, { timeoutMs: 300 })).rejects.toThrow(/still starting/);
    await release();
  });

  it('takes over a lock whose holder process is gone', async () => {
    const paths = servePaths('shop', await sailHome());
    await acquireServeLock(paths, { timeoutMs: 1000 }); // never released
    const release = await acquireServeLock(paths, { timeoutMs: 1000, alive: () => false });
    await release();
  });

  it('release only removes its own lock', async () => {
    const paths = servePaths('shop', await sailHome());
    const stale = await acquireServeLock(paths, { timeoutMs: 1000 });
    const fresh = await acquireServeLock(paths, { timeoutMs: 1000, alive: () => false });
    await stale();
    await expect(acquireServeLock(paths, { timeoutMs: 200 })).rejects.toThrow();
    await fresh();
  });
});

describe('stopServe and newer entries', () => {
  it('leaves an entry written by someone else in place', async () => {
    const paths = servePaths('shop', await sailHome());
    await writeServeState(paths, state({ pid: 5555 }));

    await stopServe(state({ pid: 4242 }), paths, { alive: () => false });

    expect((await readServeState(paths))?.pid).toBe(5555);
  });

  it('waits for the process to be reaped after SIGKILL', async () => {
    const paths = servePaths('shop', await sailHome());
    let killed = false;
    let checksAfterKill = 0;
    await stopServe(state(), paths, {
      graceMs: 0,
      alive: () => {
        if (!killed) return true;
        return ++checksAfterKill < 3;
      },
      kill: (_pid, signal) => {
        if (signal === 'SIGKILL') killed = true;
      },
      sleep: async () => {},
    });
    expect(checksAfterKill).toBe(3);
  });
});

describe('startServe log', () => {
  it('truncates the log on every start', async () => {
    const paths = servePaths('shop', await sailHome());
    const fakeSpawn: any = () => Object.assign(new EventEmitter(), { pid: 7777, unref() {} });
    await writeFile(paths.logFile.replace('shop.log', '.keep'), '').catch(() => {});
    await startServe({
      appRoot: '/a',
      projectName: 'shop',
      port: 4000,
      mode: 'hmr',
      startedBy: null,
      paths,
      spawn: fakeSpawn,
    });
    await writeFile(paths.logFile, 'old run crashed\n', 'utf8');
    await startServe({
      appRoot: '/a',
      projectName: 'shop',
      port: 4000,
      mode: 'hmr',
      startedBy: null,
      paths,
      spawn: fakeSpawn,
    });
    expect(await readFile(paths.logFile, 'utf8')).toBe('');
  });
});

describe('serveLogTail', () => {
  it('strips colour and surfaces the cause lines over the plain tail', async () => {
    const paths = servePaths('shop', await sailHome());
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.logFile,
      [
        '\u001b[2m[ info ]\u001b[22m starting HTTP server...',
        '\u001b[31mEnvValidationException\u001b[39m: Validation failed for one or more environment variables',
        '- Missing environment variable "APP_KEY"',
        '   17 ┃    APP_KEY: Env.schema.string(),',
        '[ info ] watching file system for changes...',
      ].join('\n'),
      'utf8',
    );

    expect(await serveLogTail(paths)).toBe(
      [
        'EnvValidationException: Validation failed for one or more environment variables',
        '- Missing environment variable "APP_KEY"',
      ].join('\n'),
    );
  });

  it('falls back to the last lines when nothing names a cause', async () => {
    const paths = servePaths('shop', await sailHome());
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.logFile, ['one', 'two', 'three'].join('\n'), 'utf8');

    expect(await serveLogTail(paths, 2)).toBe('two\nthree');
  });
});
