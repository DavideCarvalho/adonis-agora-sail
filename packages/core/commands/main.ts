import { ListLoader } from '@adonisjs/core/ace';

import SailDown from './sail_down.js';
import SailExec from './sail_exec.js';
import SailInfo from './sail_info.js';
import SailInstall from './sail_install.js';
import SailLogs from './sail_logs.js';
import SailMysql from './sail_mysql.js';
import SailPrune from './sail_prune.js';
import SailPs from './sail_ps.js';
import SailPsql from './sail_psql.js';
import SailRedis from './sail_redis.js';
import SailShare from './sail_share.js';
import SailSyncEnv from './sail_sync_env.js';
import SailUp from './sail_up.js';

/**
 * The commands barrel for `@adonis-agora/sail`. An app registers it in its
 * `adonisrc` via `rcFile.addCommand('@adonis-agora/sail/commands')` (done by
 * `configure`). A {@link ListLoader} exposes the command metadata and
 * constructors to the ace kernel: `sail:install`, `sail:up`, `sail:down`,
 * `sail:ps`, `sail:logs`, `sail:info`, `sail:exec`, `sail:prune`,
 * `sail:sync-env`, `sail:psql`, `sail:mysql`, `sail:redis` and `sail:share`.
 *
 * `@adonisjs/core` is an *optional* peer of this otherwise framework-free core —
 * only this `./commands` subpath imports it, so the main entrypoint stays
 * dependency-free.
 */
const loader = new ListLoader([
  SailInstall,
  SailUp,
  SailDown,
  SailPs,
  SailLogs,
  SailInfo,
  SailExec,
  SailPrune,
  SailSyncEnv,
  SailPsql,
  SailMysql,
  SailRedis,
  SailShare,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
