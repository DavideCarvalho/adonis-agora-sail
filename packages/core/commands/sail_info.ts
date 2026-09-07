import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { formatAppScan } from '../src/app_scan.js';
import { formatAppEnv, formatStackInfo, resolveStackInfo } from '../src/info.js';
import { detectVarlock } from '../src/varlock.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:info [--env] [--json]` — shows the current worktree's stack:
 * compose project, port offset, per-service host ports, dashboards and the
 * env vars the app should use to reach each service.
 *
 * This is the command to reach for instead of hardcoding ports: host ports
 * shift per worktree by a deterministic offset, so `5432` is only right in
 * the main checkout. `--env` prints `KEY=value` lines for
 * `eval $(node ace sail:info --env)`; `--json` (the default inside AI
 * agents) prints the full stack object.
 */
export default class SailInfo extends SailBaseCommand {
  static override commandName = 'sail:info';
  static override description = "Show the sail stack's ports, URLs and connection env";
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({
    description: 'Print KEY=value lines for eval $(node ace sail:info --env)',
    default: false,
  })
  declare env: boolean;

  override async run(): Promise<void> {
    const { services, scan, info } = await resolveStackInfo(this.app.appRoot);
    const varlock = await detectVarlock(this.app.appRoot);

    if (services.length === 0) {
      this.failJsonAware(
        'No sail services enabled for this app',
        'Run "node ace sail:install" first to generate compose.yml',
      );
      return;
    }

    if (this.env) {
      this.logger.log(formatAppEnv(info));
      return;
    }

    if (this.wantsJson) {
      this.printJson({ ...info, scan, varlock });
      return;
    }

    this.logger.log(formatStackInfo(info));
    this.logger.log(formatAppScan(scan));
    if (varlock.inUse) {
      this.logger.info('varlock detected — boot with `varlock run -- node ace serve --hmr`');
    } else {
      this.logger.info('.env.local is synced by sail:up / sail:sync-env — just boot the app');
    }
  }
}
