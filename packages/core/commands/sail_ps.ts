import type { CommandOptions } from '@adonisjs/core/types/ace';

import type { SailServiceStatus } from '../src/types.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:ps` — lists the current worktree's stack containers with
 * their state, health and published ports. Machine-readable with `--json`
 * (the default inside AI agents).
 */
export default class SailPs extends SailBaseCommand {
  static override commandName = 'sail:ps';
  static override description = "List the sail stack's containers";
  static override options: CommandOptions = { startApp: false };

  override async run(): Promise<void> {
    if (!(await this.ensureComposeFile())) {
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    const docker = await this.docker();
    let statuses: SailServiceStatus[];
    try {
      statuses = await docker.ps();
    } catch (error) {
      this.failJsonAware(
        `Could not list containers: ${error instanceof Error ? error.message : String(error)}`,
        'Is the Docker daemon running?',
      );
      return;
    }

    if (this.wantsJson) {
      this.printJson(statuses);
      return;
    }

    if (statuses.length === 0) {
      this.logger.info('No containers for this stack. Run "node ace sail:up" to start it.');
      return;
    }

    for (const status of statuses) {
      const health = status.health ? ` (${status.health})` : '';
      const ports = status.publishers
        .map((publisher) => `${publisher.hostPort}->${publisher.containerPort}`)
        .join(', ');
      this.logger.log(`  ${status.name}  ${status.state}${health}${ports ? `  ${ports}` : ''}`);
    }
  }
}
