import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import {
  readServeState,
  SERVE_READY_TIMEOUT_MS,
  type ServeMode,
  type ServeState,
  serveHealth,
  serveLogTail,
  servePaths,
  startServe,
  stopServe,
  waitForServe,
} from '../src/serve.js';
import { isPortOpen, resolveSharePort } from '../src/share.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:serve [--status | --stop | --restart] [--port N] [--watch | --no-hmr]`
 * — runs the app in the background, once per worktree, so several people or
 * agents working on the same worktree share one process instead of each
 * starting (and killing) their own.
 *
 * Without a mode flag it is idempotent: when the worktree's app is already up
 * it reports it (`reused: true`); otherwise it starts `node ace serve --hmr`
 * detached on the worktree port (dot-env `PORT` + worktree offset, the same
 * port `sail:share` exposes), waits until it answers and reports it. `--stop`
 * stops the whole process group; `--restart` is stop + start (after a rebase,
 * a new migration or an `.env` change — `--hmr` already picks up code edits).
 *
 * The process inherits the caller's environment, so extra variables are just
 * a prefix: `VITE_API_URL=https://… node ace sail:serve`. State and logs live
 * in `~/.sail/serve/<project>.{json,log}` — never in the app.
 */
export default class SailServe extends SailBaseCommand {
  static override commandName = 'sail:serve';
  static override description =
    'Run the app in the background, shared per worktree (start, reuse, stop)';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({
    description: 'Report whether the app is running, without starting it',
    default: false,
  })
  declare status: boolean;

  @flags.boolean({ description: 'Stop the background app', default: false })
  declare stop: boolean;

  @flags.boolean({ description: 'Stop and start again', default: false })
  declare restart: boolean;

  @flags.number({
    description: 'Port to serve on (defaults to the worktree serve port)',
    alias: 'p',
  })
  declare port?: number;

  @flags.boolean({
    description: 'Restart on file changes (`serve --watch`) instead of HMR',
    default: false,
  })
  declare watch: boolean;

  @flags.boolean({ description: 'Hot module reload (`serve --hmr`)', default: true })
  declare hmr: boolean;

  @flags.string({
    description: 'Who is starting it, recorded for shared setups (default: $SAIL_SERVE_BY)',
  })
  declare by?: string;

  @flags.number({
    description: 'Seconds to wait for the app to answer',
    default: SERVE_READY_TIMEOUT_MS / 1000,
  })
  declare wait: number;

  override async run(): Promise<void> {
    const chosen = [this.status, this.stop, this.restart].filter(Boolean).length;
    if (chosen > 1) {
      this.failJsonAware('Choose one of --status, --stop or --restart');
      return;
    }

    const context = await this.sailContext();
    const appRoot = fileURLToPath(this.app.appRoot);
    const paths = servePaths(context.projectName);
    const current = await readServeState(paths);
    const health = current ? await serveHealth(current) : 'dead';

    if (this.status) {
      this.#report(
        current && health !== 'dead'
          ? { ...current, running: health === 'running', health }
          : { running: false, projectName: context.projectName },
      );
      return;
    }

    if (this.stop || this.restart) {
      const result = current ? await stopServe(current, paths) : { stopped: false, forced: false };
      if (this.stop) {
        this.#report({
          projectName: context.projectName,
          stopped: result.stopped,
          forced: result.forced,
        });
        return;
      }
    } else if (current && health === 'running') {
      this.#report({ ...current, running: true, reused: true });
      return;
    } else if (current && health === 'starting') {
      // Someone else's start is still booting: wait for it instead of racing a second process.
      const settled = await waitForServe(current, this.wait * 1000);
      if (settled === 'running') {
        this.#report({ ...current, running: true, reused: true });
        return;
      }
      await stopServe(current, paths);
    }

    const { port } = await resolveSharePort(appRoot, {
      port: this.port,
      worktreeName: context.worktree?.name ?? null,
    });
    if (await isPortOpen(port)) {
      this.failJsonAware(
        `Port ${port} is already in use by a process sail:serve did not start`,
        'Stop that process (or pass --port), then re-run',
      );
      return;
    }

    const mode: ServeMode = this.watch ? 'watch' : this.hmr ? 'hmr' : 'plain';
    const started = await startServe({
      appRoot,
      projectName: context.projectName,
      port,
      mode,
      startedBy: this.by ?? process.env.SAIL_SERVE_BY ?? null,
      paths,
    });
    if (!this.wantsJson) {
      this.logger.info(`Starting node ace serve (${mode}) on :${port}…`);
    }

    const settled = await waitForServe(started, this.wait * 1000);
    if (settled !== 'running') {
      const tail = await serveLogTail(paths);
      // Wedged or dead, the entry must go: a stale one would make the next run "reuse" nothing.
      await stopServe(started, paths);
      this.failJsonAware(
        settled === 'dead'
          ? `node ace serve exited before answering on :${port}`
          : `node ace serve did not answer on :${port} within ${this.wait}s (stopped it)`,
        tail ? `Last log lines (${paths.logFile}):\n${tail}` : `See ${paths.logFile}`,
      );
      return;
    }
    this.#report({ ...started, running: true, reused: false });
  }

  #report(payload: Partial<ServeState> & Record<string, unknown>) {
    if (this.wantsJson) {
      this.printJson(payload);
      return;
    }
    if (payload.stopped !== undefined) {
      this.logger.info(
        payload.stopped
          ? `Stopped ${payload.projectName}${payload.forced ? ' (forced)' : ''}`
          : `${payload.projectName} was not running`,
      );
      return;
    }
    if (!payload.running) {
      this.logger.info(
        payload.health === 'starting'
          ? `${payload.projectName} is starting (port ${payload.port} not answering yet)`
          : `${payload.projectName} is not running`,
      );
      return;
    }
    const by = payload.startedBy ? ` by ${payload.startedBy}` : '';
    this.logger.success(
      `${payload.reused ? 'Already running' : 'Running'} at ${payload.local} (pid ${payload.pid}, ${payload.mode}, since ${payload.startedAt}${by})`,
    );
    this.logger.info(`Logs: ${payload.logFile} · stop with: node ace sail:serve --stop`);
  }
}
