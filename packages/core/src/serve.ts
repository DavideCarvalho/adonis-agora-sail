import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sailHomeDir } from './proxy.js';
import { isPortOpen as probePort } from './share.js';

/** How long `sail:serve` waits, by default, for the app to answer on its port. */
export const SERVE_READY_TIMEOUT_MS = 120_000;

/** How long `stop` waits after SIGTERM before it sends SIGKILL. */
export const SERVE_STOP_GRACE_MS = 10_000;

/**
 * What `sail:serve` remembers about the app process it started for one
 * worktree. One file per compose project (`appName` or `appName-<worktree>`),
 * under `~/.sail/serve/` — outside the app, so nothing lands in the repo and
 * every worktree of every app has its own entry.
 */
export interface ServeState {
  /** Compose project name — the key of this entry. */
  projectName: string;
  /** Absolute app root the process was started in. */
  appRoot: string;
  /** Process id — also the process group id: the app is started detached. */
  pid: number;
  /** Port the app was told to listen on (`PORT`). */
  port: number;
  /** `http://127.0.0.1:<port>`. */
  local: string;
  /** `serve` mode the process runs in. */
  mode: ServeMode;
  /** Combined stdout/stderr of the process. */
  logFile: string;
  /** ISO timestamp of the start. */
  startedAt: string;
  /** Free-form label of who started it (`--by`, or `$SAIL_SERVE_BY`), for shared setups. */
  startedBy: string | null;
}

/** `hmr` → `node ace serve --hmr`; `watch` → `--watch`; `plain` → no flag. */
export type ServeMode = 'hmr' | 'watch' | 'plain';

export interface ServePaths {
  dir: string;
  stateFile: string;
  logFile: string;
  /** Held while one caller decides whether to start, so concurrent callers never double-start. */
  lockFile: string;
}

/** `~/.sail/serve/<project>.json` and `.log`. */
export function servePaths(projectName: string, home: string = sailHomeDir()): ServePaths {
  const dir = join(home, 'serve');
  return {
    dir,
    stateFile: join(dir, `${projectName}.json`),
    logFile: join(dir, `${projectName}.log`),
    lockFile: join(dir, `${projectName}.lock`),
  };
}

/** The `node ace serve` arguments for a mode. */
export function serveArgs(mode: ServeMode): string[] {
  if (mode === 'hmr') {
    return ['ace', 'serve', '--hmr'];
  }
  if (mode === 'watch') {
    return ['ace', 'serve', '--watch'];
  }
  return ['ace', 'serve'];
}

export async function readServeState(paths: ServePaths): Promise<ServeState | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.stateFile, 'utf8')) as ServeState;
    // pid 0/1 would make `kill(-pid)` signal our own group or everything: never trust them.
    return Number.isInteger(parsed.pid) && parsed.pid > 1 && isValidPort(parsed.port)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function writeServeState(paths: ServePaths, state: ServeState): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function clearServeState(paths: ServePaths): Promise<void> {
  await rm(paths.stateFile, { force: true });
}

/** A TCP port a process can listen on. */
export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Takes the per-project lock (`<project>.lock`, created exclusively), waiting
 * up to `timeoutMs` for another holder. A lock whose holder process is gone is
 * stale and taken over. Resolves with the release function; rejects on timeout.
 */
export async function acquireServeLock(
  paths: ServePaths,
  options: {
    timeoutMs: number;
    alive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<() => Promise<void>> {
  const alive = options.alive ?? isProcessAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  await mkdir(paths.dir, { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  for (;;) {
    try {
      const handle = await open(paths.lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
      await handle.close();
      return async () => {
        try {
          const held = JSON.parse(await readFile(paths.lockFile, 'utf8')) as { token?: string };
          if (held.token === token) {
            await rm(paths.lockFile, { force: true });
          }
        } catch {
          // already released
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    let holder: number | null = null;
    try {
      holder = (JSON.parse(await readFile(paths.lockFile, 'utf8')) as { pid?: number }).pid ?? null;
    } catch {
      // half-written or just released: retry
    }
    if (holder !== null && !alive(holder)) {
      await rm(paths.lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`another sail:serve is still starting this app (lock ${paths.lockFile})`);
    }
    await sleep(200);
  }
}

/** Whether a process id is alive (signal 0 probes without signalling). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ServeHealth = 'running' | 'starting' | 'dead';

/**
 * `running`: the recorded process is alive and answers on its port.
 * `starting`: alive, port still closed (booting, or wedged — the caller decides).
 * `dead`: gone; the state file is stale.
 */
export async function serveHealth(
  state: ServeState,
  probes: { alive?: (pid: number) => boolean; portOpen?: (port: number) => Promise<boolean> } = {},
): Promise<ServeHealth> {
  const alive = probes.alive ?? isProcessAlive;
  const portOpen = probes.portOpen ?? probePort;
  if (!alive(state.pid)) {
    return 'dead';
  }
  return (await portOpen(state.port)) ? 'running' : 'starting';
}

export interface StartServeOptions {
  appRoot: string;
  projectName: string;
  port: number;
  mode: ServeMode;
  startedBy: string | null;
  paths: ServePaths;
  /** Extra environment on top of `process.env` (`PORT` is always set from `port`). */
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  now?: () => Date;
}

/**
 * Starts `node ace serve` detached in its own process group, with stdout and
 * stderr appended to the log file, and records it. `PORT` is set explicitly:
 * the port is the one sail resolved (dot-env `PORT` plus the worktree offset),
 * whatever `serve` itself would have picked — so the process never depends on
 * a core with or without the worktree-port patch. Returns as soon as the
 * process is spawned; waiting for the port is the caller's call.
 */
export async function startServe(options: StartServeOptions): Promise<ServeState> {
  const spawn = options.spawn ?? nodeSpawn;
  await mkdir(options.paths.dir, { recursive: true });
  // Truncated per start: the log (and any failure tail quoted from it) is this process's alone.
  const log = await open(options.paths.logFile, 'w');
  try {
    const child = spawn(process.execPath, serveArgs(options.mode), {
      cwd: options.appRoot,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, ...options.env, PORT: String(options.port) },
    });
    if (child.pid === undefined) {
      throw new Error('node ace serve did not start (no pid)');
    }
    child.unref();
    const state: ServeState = {
      projectName: options.projectName,
      appRoot: options.appRoot,
      pid: child.pid,
      port: options.port,
      local: `http://127.0.0.1:${options.port}`,
      mode: options.mode,
      logFile: options.paths.logFile,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      startedBy: options.startedBy,
    };
    await writeServeState(options.paths, state);
    return state;
  } finally {
    await log.close();
  }
}

/**
 * Polls until the app answers on its port, the process dies, or the timeout
 * passes. Resolves with the final health.
 */
export async function waitForServe(
  state: ServeState,
  timeoutMs: number,
  probes: Parameters<typeof serveHealth>[1] & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<ServeHealth> {
  const sleep = probes.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await serveHealth(state, probes);
    if (health !== 'starting' || Date.now() >= deadline) {
      return health;
    }
    await sleep(500);
  }
}

/**
 * Stops the whole process group (`serve` forks the app and, with `--hmr`, a
 * Vite server): SIGTERM, then SIGKILL after the grace period. Clears the state
 * file when it still describes this process.
 */
export async function stopServe(
  state: ServeState,
  paths: ServePaths,
  options: {
    graceMs?: number;
    alive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ stopped: boolean; forced: boolean }> {
  const alive = options.alive ?? isProcessAlive;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      kill(-state.pid, signal);
    } catch {
      try {
        kill(state.pid, signal);
      } catch {
        // already gone
      }
    }
  };

  let forced = false;
  const wasAlive = alive(state.pid);
  if (wasAlive) {
    signalGroup('SIGTERM');
    const deadline = Date.now() + (options.graceMs ?? SERVE_STOP_GRACE_MS);
    while (alive(state.pid) && Date.now() < deadline) {
      await sleep(250);
    }
    if (alive(state.pid)) {
      signalGroup('SIGKILL');
      forced = true;
      // Let the kernel reap it and release the port before anyone re-probes (e.g. --restart).
      const killDeadline = Date.now() + 2000;
      while (alive(state.pid) && Date.now() < killDeadline) {
        await sleep(100);
      }
    }
  }
  // Only clear the entry this call was about: a newer one written meanwhile is someone else's.
  const recorded = await readServeState(paths);
  if (!recorded || recorded.pid === state.pid) {
    await clearServeState(paths);
  }
  return { stopped: wasAlive, forced };
}

/** Last lines of the serve log, for failure messages. */
export async function serveLogTail(paths: ServePaths, max = 15): Promise<string> {
  try {
    const lines = (await readFile(paths.logFile, 'utf8')).split('\n').filter((l) => l.trim());
    return lines.slice(-max).join('\n');
  } catch {
    return '';
  }
}
