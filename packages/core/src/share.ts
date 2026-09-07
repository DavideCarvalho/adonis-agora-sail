import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { computeWorktreePortOffset } from './ports.js';

export const DEFAULT_APP_PORT = 3333;

/** How long `--json` waits for cloudflared to print the tunnel URL. */
export const SHARE_URL_TIMEOUT_MS = 60_000;

export const CLOUDFLARED_INSTALL_HINT =
  'Install cloudflared (`brew install cloudflare/cloudflare/cloudflared`, or `npm i -D cloudflared`) and re-run';

const execFileAsync = promisify(execFile);

/**
 * Extracts a cloudflared quick-tunnel URL (`https://<label>.trycloudflare.com`)
 * from tunnel log output. Null until the tunnel registers.
 */
export function parseTunnelUrl(output: string): string | null {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(output);
  return match ? match[0] : null;
}

/**
 * Raw `PORT` value from a dot-env body (last one wins, like dotenv),
 * tolerating `export` prefixes and quotes. Null when absent or not a sane
 * port — callers fall back to {@link DEFAULT_APP_PORT}.
 */
export function parseDotEnvPort(content: string): number | null {
  let found: number | null = null;
  for (const match of content.matchAll(/^\s*(?:export\s+)?PORT\s*=\s*(.+?)\s*$/gm)) {
    const raw = (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
    const parsed = Number(raw);
    if (raw.length > 0 && Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      found = parsed;
    }
  }
  return found;
}

/**
 * Resolves the local port the app serves on, mirroring `serve` exactly (see
 * `@adonisjs/core` `getBasePort` + `computeWorktreePort`): first `PORT`
 * found following the dot-env loader priority (`.env.<env>.local`,
 * `.env.local` except under `test`, `.env.<env>`, `.env`), else 3333 — plus
 * the deterministic worktree offset (0 in the main checkout). An explicit
 * `--port` overrides everything.
 */
export async function resolveSharePort(
  appRootPath: string,
  options: {
    port?: number | undefined;
    nodeEnv?: string | undefined;
    worktreeName?: string | null | undefined;
  } = {},
): Promise<{ port: number; basePort: number; offset: number }> {
  if (options.port) {
    return { port: options.port, basePort: options.port, offset: 0 };
  }

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const candidates = [
    ...(nodeEnv ? [`.env.${nodeEnv}.local`] : []),
    ...(!nodeEnv || !['test', 'testing'].includes(nodeEnv) ? ['.env.local'] : []),
    ...(nodeEnv ? [`.env.${nodeEnv}`] : []),
    '.env',
  ];

  let basePort = DEFAULT_APP_PORT;
  for (const file of candidates) {
    try {
      const found = parseDotEnvPort(await readFile(join(appRootPath, file), 'utf8'));
      if (found !== null) {
        basePort = found;
        break;
      }
    } catch {
      // missing file — next candidate
    }
  }

  const offset = options.worktreeName ? computeWorktreePortOffset(options.worktreeName) : 0;
  return { port: basePort + offset, basePort, offset };
}

/**
 * Picks which local port the tunnel actually exposes. The worktree port wins
 * whenever anything answers on it; otherwise, in a worktree whose base port
 * answers, the base port wins — that's a core without the worktree-port
 * patch (or a manual override), serving plain `PORT` even in a worktree.
 * When nothing answers, the worktree port is still the target: the app may
 * boot after the tunnel.
 */
export function selectShareTarget(
  port: number,
  basePort: number,
  offset: number,
  portOpen: boolean,
  baseOpen: boolean,
): { target: number; resolvedFrom: 'worktree' | 'base-fallback' | 'unverified' } {
  if (portOpen) {
    return { target: port, resolvedFrom: 'worktree' };
  }
  if (offset !== 0 && baseOpen) {
    return { target: basePort, resolvedFrom: 'base-fallback' };
  }
  return { target: port, resolvedFrom: 'unverified' };
}

/**
 * Returns null when `cloudflared` is usable, otherwise a human-readable
 * reason with the install hint.
 */
export async function checkCloudflared(): Promise<string | null> {
  try {
    await execFileAsync('cloudflared', ['--version']);
    return null;
  } catch {
    return `cloudflared is not installed or not on PATH. ${CLOUDFLARED_INSTALL_HINT}`;
  }
}

/**
 * Whether something answers on `127.0.0.1:port`. Used for the "is the app
 * even running?" warning — never a hard failure, since the app may boot
 * after the tunnel.
 */
export function isPortOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
