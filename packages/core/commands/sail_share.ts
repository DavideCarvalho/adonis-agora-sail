import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import {
  checkCloudflared,
  isPortOpen,
  parseTunnelUrl,
  resolveSharePort,
  SHARE_URL_TIMEOUT_MS,
  selectShareTarget,
} from '../src/share.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:share [--port 3333] [--json]` — exposes the locally running
 * app on a public `https://<label>.trycloudflare.com` URL via a cloudflared
 * quick tunnel (no account needed). For previews and, mainly, webhook
 * integrations (payments providers calling back into your machine).
 *
 * The local target is the worktree's `serve` port: dot-env `PORT` (loader
 * priority) plus the deterministic worktree offset — the same port `serve`
 * listens on, so no flag is needed; `--port` overrides. When the worktree
 * port answers, it wins; when only the base `PORT` answers (a core without
 * the worktree-port patch serves plain `PORT` even in a worktree), the base
 * port is shared instead, and the output says so. When nothing answers yet,
 * the worktree port is still the target — the app may boot after the tunnel.
 * The command stays attached until interrupted (Ctrl+C), like
 * `sail:logs --follow`. With `--json` (the default inside AI agents) it
 * prints one JSON line (`{ url, local }`) on stdout once the tunnel
 * registers, keeps tunnel logs on stderr, and keeps running — kill the
 * command to stop sharing. No docker involved: the app runs on the host.
 */
export default class SailShare extends SailBaseCommand {
  static override commandName = 'sail:share';
  static override description = 'Share the app publicly via a tunnel URL (previews, webhooks)';
  static override options: CommandOptions = { startApp: false };

  @flags.number({
    description: 'Local port to expose (defaults to the worktree serve port)',
    alias: 'p',
  })
  declare port?: number;

  override async run(): Promise<void> {
    const problem = await checkCloudflared();
    if (problem) {
      this.failJsonAware(problem);
      return;
    }

    const context = await this.sailContext();
    const { port, basePort, offset } = await resolveSharePort(fileURLToPath(this.app.appRoot), {
      port: this.port,
      worktreeName: context.worktree?.name ?? null,
    });

    const [portOpen, baseOpen] = await Promise.all([
      isPortOpen(port),
      offset !== 0 && basePort !== port ? isPortOpen(basePort) : Promise.resolve(false),
    ]);
    const { target: targetPort, resolvedFrom } = selectShareTarget(
      port,
      basePort,
      offset,
      portOpen,
      baseOpen,
    );

    if (resolvedFrom === 'base-fallback') {
      const hint = `worktree port :${port} is closed but base PORT :${basePort} answers — sharing :${basePort} (core worktree-port not active?)`;
      if (this.wantsJson) {
        this.printJson({ notice: hint });
      } else {
        this.logger.info(hint);
      }
    } else if (resolvedFrom === 'unverified') {
      const hint = `Nothing is listening on :${port} — start the app first (e.g. \`node ace serve --hmr\`), then re-run`;
      if (this.wantsJson) {
        this.printJson({ warning: hint, port, basePort, portOffset: offset });
      } else {
        this.logger.warning(`${hint} (continuing anyway — the app may still be booting)`);
      }
    }

    const local = `http://127.0.0.1:${targetPort}`;
    if (this.wantsJson) {
      await this.#runJson(local, targetPort, basePort, offset, resolvedFrom);
      return;
    }

    this.logger.info(`Sharing ${local} publicly (Ctrl+C to stop)…`);
    const exitCode = await this.#runAttached(local);
    if (exitCode !== 0) {
      this.exitCode = exitCode;
    }
  }

  /** Human path: native colors and URL straight from cloudflared. */
  #runAttached(target: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn('cloudflared', ['tunnel', '--url', target], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
  }

  /**
   * Agent path: piped so stdout stays a single JSON line. Tunnel logs go to
   * stderr; the command runs until killed.
   */
  async #runJson(
    target: string,
    port: number,
    basePort: number,
    offset: number,
    resolvedFrom: 'worktree' | 'base-fallback' | 'unverified',
  ): Promise<void> {
    const child = spawn('cloudflared', ['tunnel', '--url', target], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const forward = (chunk: Buffer | string) => process.stderr.write(chunk);
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);

    const url = await new Promise<string | null>((resolve) => {
      let output = '';
      const timer = setTimeout(() => resolve(null), SHARE_URL_TIMEOUT_MS);
      const onData = (chunk: Buffer | string) => {
        output += chunk.toString();
        const found = parseTunnelUrl(output);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve(parseTunnelUrl(output));
      });
    });

    if (!url) {
      this.exitCode = 1;
      try {
        child.kill();
      } catch {
        // already gone
      }
      this.failJsonAware(
        'cloudflared did not print a tunnel URL in time',
        'Check your network and re-run (tunnel logs above, on stderr)',
      );
      return;
    }

    this.printJson({ url, local: target, port, basePort, portOffset: offset, resolvedFrom });

    const stop = () => {
      try {
        child.kill('SIGINT');
      } catch {
        // already gone
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const exitCode: number = await new Promise((resolve) =>
      child.on('close', (code) => resolve(code ?? 1)),
    );
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (exitCode !== 0) {
      this.exitCode = exitCode;
    }
  }
}
