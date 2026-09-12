import { args } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:exec <service> -- <command...>` — runs a one-shot command
 * inside a service container and prints its output.
 *
 * Examples: `node ace sail:exec redis -- redis-cli ping`,
 * `node ace sail:exec postgres -- psql -U sail -d app -c "select 1"`.
 *
 * Deliberately non-interactive (`exec -T`, captured output): agents and
 * scripts get plain text back with a propagated exit code. For an
 * interactive shell, use `docker compose exec` directly.
 */
export default class SailExec extends SailBaseCommand {
  static override commandName = 'sail:exec';
  static override description = 'Run a one-shot command inside a service container';
  static override options: CommandOptions = { startApp: false };

  @args.string({ description: 'Service to run the command in (e.g. postgres)' })
  declare service: string;

  @args.spread({ description: 'Command and arguments to run', required: false })
  declare command?: string[];

  override async run(): Promise<void> {
    if (!this.command || this.command.length === 0) {
      this.failJsonAware(
        'No command given',
        'Usage: node ace sail:exec <service> -- <command...> (e.g. node ace sail:exec redis -- redis-cli ping)',
      );
      return;
    }
    if (!(await this.ensureComposeFile())) {
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    const docker = await this.docker();
    const result = await docker.exec(this.service, this.command);

    if (result.stdout.trim()) {
      this.logger.log(result.stdout.trimEnd());
    }

    if (result.exitCode !== 0) {
      this.failJsonAware(
        `sail:exec failed (exit ${result.exitCode}):\n${this.tailLines(result.stderr || result.stdout)}`,
        'Check the service name with `node ace sail:ps`',
        result.exitCode,
      );
    }
  }
}
