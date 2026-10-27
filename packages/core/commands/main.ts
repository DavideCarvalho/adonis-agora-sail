import { LazySailLoader } from './lazy_loader.js';

/**
 * The commands barrel for `@adonis-agora/sail`. An app registers it in its
 * `adonisrc` via `rcFile.addCommand('@adonis-agora/sail/commands')` (done by
 * `configure`). A {@link ListLoader} exposes the command metadata and
 * constructors to the ace kernel: `sail:install`, `sail:up`, `sail:down`,
 * `sail:ps`, `sail:logs`, `sail:info`, `sail:exec`, `sail:prune`,
 * `sail:sync-env`, `sail:psql`, `sail:mysql`, `sail:redis`, `sail:serve`,
 * `sail:share` and `sail:domain`.
 *
 * `@adonisjs/core` is an *optional* peer of this otherwise framework-free core —
 * only this `./commands` subpath imports it, so the main entrypoint stays
 * dependency-free.
 */
const loader = new LazySailLoader(new URL('./commands.json', import.meta.url));

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
