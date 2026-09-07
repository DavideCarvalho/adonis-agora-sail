import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailServiceShellCommand } from './service_shell_command.js';

/**
 * `node ace sail:psql [-- <psql args>]` — opens a `psql` REPL in the postgres
 * container, or runs a one-shot (`sail:psql -- -c 'select 1'`) with a
 * propagated exit code. The container network is used, so worktree port
 * offsets never matter here.
 */
export default class SailPsql extends SailServiceShellCommand {
  static override commandName = 'sail:psql';
  static override description = 'Open a psql shell in the postgres container';
  static override options: CommandOptions = { startApp: false };

  override readonly shellService = 'postgres' as const;
}
