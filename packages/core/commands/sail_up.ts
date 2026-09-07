import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { syncSailLocalEnvs } from '../src/dotenv.js';
import { formatStackInfo, resolveStackInfo } from '../src/info.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:up [--pull]` — starts the stack detached and waits for the
 * services' healthchecks, so `node ace sail:up && node ace migration:run`
 * works with no sleeps in between.
 *
 * Idempotent: running it twice is a silent success, which makes it safe to
 * retry from scripts and agents. On success it syncs the worktree's ports
 * into `.env.local` (plus `.env.test.local`, which is what the loader reads
 * under `NODE_ENV=test`) — the same sync as `sail:sync-env` — and prints the
 * stack summary (ports, dashboards, app env), the same content as
 * `sail:info`. Just boot the app normally afterwards: Adonis loads
 * `.env.local` over `.env` on its own, no `eval` needed.
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
    const result = await docker.up({ pull: this.pull });
    if (result.exitCode !== 0) {
      this.exitCode = result.exitCode;
      this.failJsonAware(
        `sail:up failed:\n${this.tailLines(result.stderr || result.stdout)}`,
        'Is the Docker daemon running? See `node ace sail:logs` for service output',
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
      this.logger.warning(
        `${file.file} looks encrypted — ports NOT synced there, use \`node ace sail:info --env\``,
      );
    }
    this.logger.log(formatStackInfo(info));
  }
}
