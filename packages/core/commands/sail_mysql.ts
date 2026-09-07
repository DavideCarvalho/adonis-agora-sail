import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailServiceShellCommand } from './service_shell_command.js';

/**
 * `node ace sail:mysql [-- <mysql args>]` — opens a `mysql` REPL in the mysql
 * container, or runs a one-shot (`sail:mysql -- -e 'show tables'`) with a
 * propagated exit code. The container network is used, so worktree port
 * offsets never matter here.
 */
export default class SailMysql extends SailServiceShellCommand {
  static override commandName = 'sail:mysql';
  static override description = 'Open a mysql shell in the mysql container';
  static override options: CommandOptions = { startApp: false };

  override readonly shellService = 'mysql' as const;
}
