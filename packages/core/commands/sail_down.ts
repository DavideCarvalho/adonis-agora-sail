import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:down [--volumes]` — stops the stack for the current
 * worktree. Other worktrees' stacks are untouched: every worktree is its own
 * compose project.
 *
 * `--volumes` also deletes the named volumes — all local service data. In an
 * interactive session that flag asks for confirmation; everywhere else (CI,
 * agents) the explicit flag itself counts as consent, so scripts never hang
 * on a prompt.
 */
export default class SailDown extends SailBaseCommand {
  static override commandName = 'sail:down';
  static override description = 'Stop the sail stack for the current worktree';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({
    description: 'Also delete named volumes (all local data!)',
    alias: 'v',
    default: false,
  })
  declare volumes: boolean;

  override async run(): Promise<void> {
    if (!(await this.ensureComposeFile())) {
      return;
    }
    if (!(await this.ensureDocker())) {
      return;
    }

    if (this.volumes && this.canPrompt) {
      let confirmed = false;
      try {
        confirmed = await this.prompt.confirm(
          'Delete named volumes? All local service data will be lost',
        );
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        const message = 'Aborted — containers left running, volumes kept.';
        // Every other exit of this command is one JSON document under --json;
        // a bare log line here would be the one a consumer cannot parse.
        if (this.wantsJson) {
          this.printJson({ status: 'aborted', message });
          return;
        }
        this.logger.info(message);
        return;
      }
    }

    const docker = await this.docker();
    const context = await this.sailContext();
    const result = await docker.down({ volumes: this.volumes });
    if (result.exitCode !== 0) {
      this.failJsonAware(
        `sail:down failed:\n${this.tailLines(result.stderr || result.stdout)}`,
        'Is the Docker daemon running?',
        result.exitCode,
      );
      return;
    }

    if (this.wantsJson) {
      this.printJson({ status: 'down', projectName: context.projectName, volumes: this.volumes });
      return;
    }

    this.logger.success(
      `Sail stack "${context.projectName}" is down${this.volumes ? ' (volumes deleted)' : ''}`,
    );
  }
}
