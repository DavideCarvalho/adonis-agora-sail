import { fileURLToPath } from 'node:url';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { encryptedEnvWarning, syncSailLocalEnvs } from '../src/dotenv.js';
import { resolveStackInfo } from '../src/info.js';
import { detectVarlock } from '../src/varlock.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:sync-env [--json]` — writes the current worktree's service
 * ports into the sail-managed block of `.env.local` (plus `.env.test.local`,
 * which is what the Adonis loader reads under `NODE_ENV=test`), creating the
 * files and git-ignoring them when needed.
 *
 * Pure file sync, no docker involved: safe to run any time, and re-running
 * without port changes is a no-op. `sail:up` already calls the same sync
 * after the stack is healthy — this command exists for refreshing ports
 * without touching containers, and as a retry-safe primitive for agents.
 * Everything outside the `# sail:start` / `# sail:end` markers is preserved.
 * Encrypted files (varlock ciphertext) are skipped with a warning instead of
 * corrupted.
 */
export default class SailSyncEnv extends SailBaseCommand {
  static override commandName = 'sail:sync-env';
  static override description = "Sync the worktree's service ports into .env.local";
  static override options: CommandOptions = { startApp: false };

  override async run(): Promise<void> {
    const varlock = await detectVarlock(this.app.appRoot);
    const { services, info } = await resolveStackInfo(this.app.appRoot);
    if (services.length === 0) {
      this.failJsonAware(
        'No sail services enabled for this app',
        'Run "node ace sail:install" first to generate compose.yml',
      );
      return;
    }

    const result = await syncSailLocalEnvs(fileURLToPath(this.app.appRoot), info.appEnv);
    const encrypted = result.files.filter((file) => file.action === 'skipped-encrypted');
    const synced = result.files.filter((file) => file.action !== 'skipped-encrypted');

    // A skipped file means the sync did not happen, in either output mode:
    // set the code before the JSON path returns, so agents and humans agree.
    if (encrypted.length > 0) {
      this.exitCode = 1;
    }

    if (this.wantsJson) {
      this.printJson({
        // A run that skipped a file did not do the thing it was asked to do,
        // and it exits 1 — reporting "synced" would have the payload
        // contradict the exit code for the one consumer that reads both.
        status: encrypted.length > 0 ? 'skipped' : 'synced',
        files: result.files,
        gitignore: result.gitignore,
        keys: Object.keys(info.appEnv).sort(),
        varlock,
      });
      return;
    }

    if (synced.length > 0) {
      this.logger.success(
        `${synced.map((file) => `${file.file} ${file.action}`).join(', ')} with ${services.join(', ')} ports for worktree "${info.worktree?.name ?? 'main'}"`,
      );
    }
    for (const file of encrypted) {
      this.logger.warning(encryptedEnvWarning(file.file));
    }
    if (synced.length > 0) {
      this.logger.info(
        varlock.inUse
          ? 'Boot with `varlock run -- node ace serve --hmr`'
          : 'Just boot the app — Adonis loads .env.local over .env on its own',
      );
    }
  }
}
