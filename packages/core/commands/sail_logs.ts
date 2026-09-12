import { args, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:logs [service] [--tail 100] [--since 10m] [--follow]` —
 * shows the stack's service logs.
 *
 * `--follow` streams to the terminal and therefore refuses `--json` (an
 * endless JSON stream helps nobody); agents should poll with `--tail` /
 * `--since` instead. Everything else is plain captured text, JSON-wrapped
 * when asked.
 */
export default class SailLogs extends SailBaseCommand {
  static override commandName = 'sail:logs';
  static override description = "Show the sail stack's service logs";
  static override options: CommandOptions = { startApp: false };

  @args.string({
    description: 'Service to show logs for (all services when omitted)',
    required: false,
  })
  declare service?: string;

  @flags.string({ description: 'Lines to show from the end of the logs', default: '100' })
  declare tail: string;

  @flags.string({ description: 'Show logs since (e.g. 10m, 2026-09-07T00:00:00)', required: false })
  declare since?: string;

  @flags.boolean({
    description: 'Follow log output (streams text, incompatible with --json)',
    alias: 'f',
    default: false,
  })
  declare follow: boolean;

  override async run(): Promise<void> {
    if (!(await this.ensureComposeFile())) {
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    if (this.follow && this.wantsJson) {
      this.failJsonAware(
        'Cannot combine --follow with --json output',
        'Stream text with `node ace sail:logs --follow`, or poll once with `node ace sail:logs --tail 100 --json`',
      );
      return;
    }

    const docker = await this.docker();
    const result = await docker.logs({
      service: this.service,
      tail: this.tail,
      since: this.since,
      follow: this.follow,
    });

    if (this.follow) {
      this.exitCode = result.exitCode;
      return;
    }

    if (result.exitCode !== 0) {
      this.failJsonAware(
        `Could not read logs:\n${this.tailLines(result.stderr || result.stdout)}`,
        'Is the Docker daemon running? Check the service name with `node ace sail:ps`',
        result.exitCode,
      );
      return;
    }

    if (this.wantsJson) {
      this.printJson({ service: this.service ?? null, logs: result.stdout });
      return;
    }

    this.logger.log(result.stdout.trimEnd());
  }
}
