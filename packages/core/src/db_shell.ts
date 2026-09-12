import { SAIL_DATABASE, SAIL_PASSWORD, SAIL_USER } from './services.js';

/**
 * Services with a one-word shell command. Unlike `sail:exec` (arbitrary
 * commands, captured output), these open the service's own client — a REPL
 * when run on a terminal, a one-shot when given arguments.
 */
export type DbShellService = 'postgres' | 'mysql' | 'redis';

export const DB_SHELL_SERVICES: DbShellService[] = ['postgres', 'mysql', 'redis'];

/**
 * Client argv for a shell *inside* the service container
 * (`docker compose exec <service> …`), so connections use the container
 * network and never the worktree-shifted host ports. `extraArgs` are passed
 * through verbatim (`sail:psql -- -c 'select 1'`).
 */
export function dbShellCommand(service: DbShellService, extraArgs: string[] = []): string[] {
  switch (service) {
    case 'postgres':
      return ['psql', '-U', SAIL_USER, '-d', SAIL_DATABASE, ...extraArgs];
    case 'mysql':
      return ['mysql', `-u${SAIL_USER}`, `-p${SAIL_PASSWORD}`, SAIL_DATABASE, ...extraArgs];
    case 'redis':
      return ['redis-cli', ...extraArgs];
  }
}

/**
 * The non-interactive equivalent, shown when there is no TTY to open the
 * REPL in (agents, CI) — the exact re-run that works there. Ace flags go
 * *before* the `--` separator: everything after it is handed to the client,
 * so a trailing `--json` would reach `psql` instead of ace.
 */
export function dbShellExample(service: DbShellService, options: { json?: boolean } = {}): string {
  const flag = options.json ? ' --json' : '';
  switch (service) {
    case 'postgres':
      return `node ace sail:psql${flag} -- -c 'select 1'`;
    case 'mysql':
      return `node ace sail:mysql${flag} -- -e 'show tables'`;
    case 'redis':
      return `node ace sail:redis${flag} -- ping`;
  }
}
