import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { encryptedEnvWarning, syncSailLocalEnvs } from '../src/dotenv.js';
import { formatStackInfo, resolveStackInfo } from '../src/info.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:up [--pull]` — starts the stack detached and waits for the
 * services' healthchecks, so `node ace sail:up && node ace migration:run`
 * works with no sleeps in between.
 *
 * Idempotent: running it twice is a silent success, which makes it safe to
 * retry from scripts and agents. Before touching docker it probes the
 * stack's host ports: when another stack (or anything else) already holds
 * one, it fails loud naming the holder instead of cross-wiring containers
 * onto the wrong database. On success it syncs the worktree's ports into
 * `.env.local` (plus `.env.test.local`) — the same sync as `sail:sync-env`
 * — and prints the stack summary, the same content as `sail:info`. Just
 * boot the app normally afterwards: Adonis loads `.env.local` over `.env`
 * on its own, no `eval` needed.
 */
export default class SailUp extends SailBaseCommand {
  static override commandName = 'sail:up';
  static override description = 'Start the sail stack and wait for service healthchecks';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({ description: 'Pull the latest images before starting', default: false })
  declare pull: boolean;

  override async run(): Promise<void> {
    if (!(await this.ensureComposeFile())) {
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    const docker = await this.docker();

    // Pre-flight: fail loud when another stack holds our ports. Ports our
    // own running containers publish are subtracted, so re-running `up` on
    // a live stack stays a silent success.
    const taken = await docker.takenHostPorts();
    if (taken.length > 0) {
      const own = new Set(await docker.publishedHostPorts());
      const foreign = taken.filter((port) => !own.has(port));
      if (foreign.length > 0) {
        const holders = await docker.portHolders();
        const details = foreign.map((port) => {
          const names = holders.get(port) ?? [];
          return names.length > 0 ? `:${port} (held by ${names.join(', ')})` : `:${port}`;
        });
        this.failJsonAware(
          `Cannot start: host port(s) already in use: ${details.join(', ')}`,
          'Stop the other stack (`node ace sail:down` in that worktree), pick a worktree with free ports, or run `node ace sail:prune` for orphans',
        );
        return;
      }
    }

    const result = await docker.up({ pull: this.pull });
    if (result.exitCode !== 0) {
      this.failJsonAware(
        `sail:up failed:\n${this.tailLines(result.stderr || result.stdout)}`,
        'Is the Docker daemon running? See `node ace sail:logs` for service output',
        result.exitCode,
      );
      return;
    }

    const { info } = await resolveStackInfo(this.app.appRoot);

    const synced = await syncSailLocalEnvs(fileURLToPath(this.app.appRoot), info.appEnv);
    const envSync = synced.files.map((file) => `${file.file} ${file.action}`).join(', ');
    const encrypted = synced.files.filter((file) => file.action === 'skipped-encrypted');

    if (this.wantsJson) {
      this.printJson({ status: 'up', envSync: synced, ...info });
      return;
    }

    this.logger.success(`Sail stack "${info.projectName}" is up`);
    this.logger.info(`env: ${envSync}`);
    for (const file of encrypted) {
      this.logger.warning(encryptedEnvWarning(file.file));
    }
    this.logger.log(formatStackInfo(info));
  }
}
