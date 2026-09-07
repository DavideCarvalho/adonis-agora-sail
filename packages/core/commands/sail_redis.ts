import type { CommandOptions } from '@adonisjs/core/types/ace';

import { SailServiceShellCommand } from './service_shell_command.js';

/**
 * `node ace sail:redis [-- <redis-cli args>]` — opens a `redis-cli` REPL in
 * the redis container, or runs a one-shot (`sail:redis -- ping`) with a
 * propagated exit code. The container network is used, so worktree port
 * offsets never matter here.
 */
export default class SailRedisCli extends SailServiceShellCommand {
  static override commandName = 'sail:redis';
  static override description = 'Open a redis-cli shell in the redis container';
  static override options: CommandOptions = { startApp: false };

  override readonly shellService = 'redis' as const;
}
