import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import {
  type ComposeProject,
  type ComposeVolume,
  findOrphanProjects,
  findOrphanVolumes,
  liveProjectNames,
} from '../src/prune.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:prune [--dry-run] [--volumes]` — stops sail stacks whose
 * worktree is gone, and with `--volumes` deletes their data too.
 *
 * Each worktree owns a compose project, so deleting a worktree (without
 * `sail:down`) leaves its containers behind — and even after `sail:down`, its
 * named volumes. A managed project counts as orphan when its compose file no
 * longer exists on disk (stopped projects included); projects with no
 * reported config files are left alone, and other apps' projects are never
 * touched. A volume counts as orphan when its project is an orphan, or when
 * no container is left and the project matches no worktree `git worktree
 * list` still knows (skipped entirely when git cannot list them).
 *
 * Volumes are only deleted with `--volumes`, the same opt-in as
 * `sail:down --volumes`: a worktree re-created under the same name gets its
 * old data back otherwise. `--dry-run` lists stacks and volumes alike.
 */
export default class SailPrune extends SailBaseCommand {
  static override commandName = 'sail:prune';
  static override description =
    'Stop sail stacks whose worktree is gone (and delete their volumes)';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({
    description: 'Only list orphan stacks and volumes, change nothing',
    default: false,
  })
  declare dryRun: boolean;

  @flags.boolean({ description: 'Also delete orphan volumes (their data!)', default: false })
  declare volumes: boolean;

  /**
   * Compose project names of the worktrees that still exist, or null when git
   * cannot tell. A method so tests can stand in for git.
   */
  async liveProjects(appName: string): Promise<Set<string> | null> {
    return liveProjectNames(fileURLToPath(this.app.appRoot), appName);
  }

  override async run(): Promise<void> {
    if (!(await this.ensureDocker())) {
      return;
    }

    const context = await this.sailContext();
    const docker = await this.docker();

    // Both listings are independent reads: start the volume listing alongside
    // the project listing instead of after it. Best-effort, see below.
    const volumesListing = docker.lsVolumes().then(
      (volumes) => volumes,
      () => [] as ComposeVolume[],
    );

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

    // Best-effort: a daemon that lists projects but not volumes still gets
    // its orphan stacks stopped.
    const allVolumes = await volumesListing;
    const orphanVolumes = findOrphanVolumes(allVolumes, {
      appName: context.appName,
      orphanProjects: names,
      knownProjects: projects.map((project) => project.name),
      liveProjects: allVolumes.length > 0 ? await this.liveProjects(context.appName) : null,
    }).map((volume) => volume.name);

    if (orphans.length === 0 && orphanVolumes.length === 0) {
      if (this.wantsJson) {
        this.printJson({ orphans: [], volumes: [], removed: [], removedVolumes: [] });
        return;
      }
      this.logger.success('No orphan sail stacks — everything running belongs to a live worktree.');
      return;
    }

    if (this.dryRun) {
      if (this.wantsJson) {
        this.printJson({ orphans: names, volumes: orphanVolumes, removed: [], removedVolumes: [] });
        return;
      }
      if (names.length > 0) {
        this.logger.info(
          `Orphan sail stacks (re-run without --dry-run to stop them):\n  ${names.join('\n  ')}`,
        );
      }
      if (orphanVolumes.length > 0) {
        this.logger.info(
          `Orphan volumes (re-run with --volumes and without --dry-run to delete them):\n  ${orphanVolumes.join('\n  ')}`,
        );
      }
      return;
    }

    const removed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    // Each orphan is its own compose project, so stopping them is independent:
    // run the `compose down`s concurrently, then report in the original order.
    const results = await Promise.all(
      orphans.map(async (orphan) => ({
        orphan,
        result: await docker.downProject(orphan.name, { volumes: this.volumes }),
      })),
    );
    for (const { orphan, result } of results) {
      if (result.exitCode === 0) {
        removed.push(orphan.name);
      } else {
        failed.push({
          name: orphan.name,
          error: this.tailLines(result.stderr || result.stdout),
        });
      }
    }

    // `down --volumes` only reaches volumes compose can still associate with
    // the project; whatever is left (a project with no containers, a volume
    // the stack no longer declares) goes by name.
    const removedVolumes: string[] = [];
    let volumeFailure: string | null = null;
    if (this.volumes && orphanVolumes.length > 0) {
      let remaining = orphanVolumes;
      try {
        const stillThere = new Set((await docker.lsVolumes()).map((volume) => volume.name));
        remaining = orphanVolumes.filter((name) => stillThere.has(name));
      } catch {
        remaining = orphanVolumes;
      }
      removedVolumes.push(...orphanVolumes.filter((name) => !remaining.includes(name)));
      if (remaining.length > 0) {
        const result = await docker.removeVolumes(remaining);
        if (result.exitCode === 0) {
          removedVolumes.push(...remaining);
        } else {
          volumeFailure = this.tailLines(result.stderr || result.stdout);
        }
      }
    }
    const keptVolumes = this.volumes ? [] : orphanVolumes;

    if (volumeFailure !== null) {
      failed.push({ name: 'volumes', error: volumeFailure });
    }
    if (failed.length > 0) {
      this.exitCode = 1;
    }
    if (this.wantsJson) {
      this.printJson({
        orphans: names,
        volumes: orphanVolumes,
        removed,
        removedVolumes,
        failed,
      });
      return;
    }

    if (removed.length > 0) {
      this.logger.success(`Stopped orphan stack(s): ${removed.join(', ')}`);
    }
    if (removedVolumes.length > 0) {
      this.logger.success(`Deleted orphan volume(s): ${removedVolumes.join(', ')}`);
    }
    if (keptVolumes.length > 0) {
      this.logger.info(
        `Kept ${keptVolumes.length} volume(s) of deleted worktrees: ${keptVolumes.join(', ')} — re-run with --volumes to delete them`,
      );
    }
    for (const failure of failed) {
      this.logger.error(
        failure.name === 'volumes'
          ? `Could not delete the orphan volumes:\n${failure.error}`
          : `Could not stop "${failure.name}":\n${failure.error}`,
      );
    }
  }
}
