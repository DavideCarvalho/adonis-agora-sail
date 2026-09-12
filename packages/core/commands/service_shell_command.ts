import { args } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { type DbShellService, dbShellCommand, dbShellExample } from '../src/db_shell.js';
import { resolveStackInfo } from '../src/info.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * Shared behavior for the one-word service shells (`sail:psql`, `sail:mysql`,
 * `sail:redis`). With no extra args it opens the client's REPL on the
 * terminal (refused without a TTY, and with `--json`); with args it runs a
 * captured one-shot with a propagated exit code — the agent path.
 * Args/flags inherit through ace's `strategy: 'inherit'`, so subclasses only
 * set `shellService` plus their metadata.
 */
export abstract class SailServiceShellCommand extends SailBaseCommand {
  static override options: CommandOptions = { startApp: false };

  abstract readonly shellService: DbShellService;

  @args.spread({
    description: 'Arguments passed to the client (e.g. -- -c "select 1")',
    required: false,
  })
  declare clientArgs?: string[];

  override async run(): Promise<void> {
    const extra = this.clientArgs ?? [];
    if (!(await this.ensureComposeFile())) {
      return;
    }
    const { services } = await resolveStackInfo(this.app.appRoot);
    if (!services.includes(this.shellService)) {
      this.failJsonAware(
        `The ${this.shellService} service is not enabled`,
        `Run "node ace sail:install --services=${this.shellService}" first`,
      );
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    if (extra.length === 0) {
      if (this.wantsJson) {
        this.failJsonAware(
          `Cannot open an interactive ${this.shellService} shell with --json output`,
          `Pass a command instead: ${dbShellExample(this.shellService, { json: true })}`,
        );
        return;
      }
      if (!this.canPrompt) {
        this.failJsonAware(
          `No interactive terminal — cannot open a ${this.shellService} shell`,
          `Pass a command instead: ${dbShellExample(this.shellService)}`,
        );
        return;
      }
      const docker = await this.docker();
      const result = await docker.execInteractive(
        this.shellService,
        dbShellCommand(this.shellService),
      );
      if (result.exitCode !== 0) {
        this.exitCode = result.exitCode;
      }
      return;
    }

    const argv = dbShellCommand(this.shellService, extra);
    const docker = await this.docker();
    const result = await docker.exec(this.shellService, argv);
    if (result.exitCode !== 0) {
      this.failJsonAware(
        `${this.commandName} failed (exit ${result.exitCode}):\n${this.tailLines(result.stderr || result.stdout)}`,
        'Check the service is up with `node ace sail:ps`',
        result.exitCode,
      );
      return;
    }
    if (this.wantsJson) {
      this.printJson({ service: this.shellService, command: argv, output: result.stdout });
      return;
    }
    if (result.stdout.trim()) {
      this.logger.log(result.stdout.trimEnd());
    }
  }
}
