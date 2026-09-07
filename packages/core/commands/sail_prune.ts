import { existsSync } from 'node:fs';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import { type ComposeProject, findOrphanProjects } from '../src/prune.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:prune [--dry-run] [--volumes]` — stops sail stacks whose
 * worktree is gone.
 *
 * Each worktree owns a compose project, so deleting a worktree (without
 * `sail:down`) leaves its containers behind. A managed project counts as
 * orphan only when its compose file no longer exists on disk; projects with
 * no reported config files are left alone, and other apps' projects are
 * never touched. `--dry-run` only lists, `--volumes` also deletes the
 * orphan volumes.
 */
export default class SailPrune extends SailBaseCommand {
  static override commandName = 'sail:prune';
  static override description = 'Stop sail stacks whose worktree is gone';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({ description: 'Only list orphan stacks without stopping them', default: false })
  declare dryRun: boolean;

  @flags.boolean({ description: 'Also delete orphan volumes (their data!)', default: false })
  declare volumes: boolean;

  override async run(): Promise<void> {
    if (!(await this.ensureDocker())) {
      return;
    }

    const context = await this.sailContext();
    const docker = await this.docker();

    let projects: ComposeProject[];
    try {
      projects = await docker.lsProjects();
    } catch (error) {
      this.failJsonAware(
        `Could not list compose projects: ${error instanceof Error ? error.message : String(error)}`,
        'Is the Docker daemon running?',
      );
      return;
    }

    const orphans = findOrphanProjects(projects, context.appName, existsSync);
    const names = orphans.map((orphan) => orphan.name);

    if (orphans.length === 0) {
      if (this.wantsJson) {
        this.printJson({ orphans: [], removed: [] });
        return;
      }
      this.logger.success('No orphan sail stacks — everything running belongs to a live worktree.');
      return;
    }

    if (this.dryRun) {
      if (this.wantsJson) {
        this.printJson({ orphans: names, removed: [] });
        return;
      }
      this.logger.info(
        `Orphan sail stacks (re-run without --dry-run to stop them):\n  ${names.join('\n  ')}`,
      );
      return;
    }

    const removed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const orphan of orphans) {
      const result = await docker.downProject(orphan.name, { volumes: this.volumes });
      if (result.exitCode === 0) {
        removed.push(orphan.name);
      } else {
        failed.push({
          name: orphan.name,
          error: this.tailLines(result.stderr || result.stdout),
        });
      }
    }

    if (failed.length > 0) {
      this.exitCode = 1;
    }
    if (this.wantsJson) {
      this.printJson({ orphans: names, removed, failed });
      return;
    }

    if (removed.length > 0) {
      this.logger.success(`Stopped orphan stack(s): ${removed.join(', ')}`);
    }
    for (const failure of failed) {
      this.logger.error(`Could not stop "${failure.name}":\n${failure.error}`);
    }
  }
}
