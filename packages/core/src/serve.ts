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
}

/** `~/.sail/serve/<project>.json` and `.log`. */
export function servePaths(projectName: string, home: string = sailHomeDir()): ServePaths {
  const dir = join(home, 'serve');
  return {
    dir,
    stateFile: join(dir, `${projectName}.json`),
    logFile: join(dir, `${projectName}.log`),
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
    return typeof parsed.pid === 'number' && typeof parsed.port === 'number' ? parsed : null;
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
  const log = await open(options.paths.logFile, 'a');
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
 * Vite server): SIGTERM, then SIGKILL after the grace period. Always clears
 * the state file.
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
    }
  }
  await clearServeState(paths);
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
