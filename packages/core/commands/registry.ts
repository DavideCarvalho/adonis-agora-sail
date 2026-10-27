import type { BaseCommand } from '@adonisjs/core/ace';

/**
 * One sail command: its compiled file name (next to this module) and a thunk
 * that imports it. The thunks are what keep `node ace` startup lean — a
 * command module, and everything it imports (`yaml`, the app scanner…), only
 * loads when that command actually runs.
 */
export interface CommandEntry {
  file: string;
  load: () => Promise<{ default: typeof BaseCommand }>;
}

/**
 * Every sail command, in the order the barrel registers them. The single list
 * both the eager fallback and the generated `commands.json` index come from.
 */
export const COMMANDS: readonly CommandEntry[] = [
  { file: 'sail_install.js', load: () => import('./sail_install.js') },
  { file: 'sail_up.js', load: () => import('./sail_up.js') },
  { file: 'sail_down.js', load: () => import('./sail_down.js') },
  { file: 'sail_ps.js', load: () => import('./sail_ps.js') },
  { file: 'sail_logs.js', load: () => import('./sail_logs.js') },
  { file: 'sail_info.js', load: () => import('./sail_info.js') },
  { file: 'sail_exec.js', load: () => import('./sail_exec.js') },
  { file: 'sail_prune.js', load: () => import('./sail_prune.js') },
  { file: 'sail_sync_env.js', load: () => import('./sail_sync_env.js') },
  { file: 'sail_psql.js', load: () => import('./sail_psql.js') },
  { file: 'sail_mysql.js', load: () => import('./sail_mysql.js') },
  { file: 'sail_redis.js', load: () => import('./sail_redis.js') },
  { file: 'sail_serve.js', load: () => import('./sail_serve.js') },
  { file: 'sail_share.js', load: () => import('./sail_share.js') },
  { file: 'sail_domain.js', load: () => import('./sail_domain.js') },
];

/** Every command class, imported eagerly, in registration order. */
export async function loadAllCommands(): Promise<(typeof BaseCommand)[]> {
  const modules = await Promise.all(COMMANDS.map((entry) => entry.load()));
  return modules.map((module) => module.default);
}
