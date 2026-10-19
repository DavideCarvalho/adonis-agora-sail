import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import SailPrune from '../commands/sail_prune.js';
import type { ComposeProject, ComposeVolume } from '../src/prune.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

/**
 * The app's own live stack, two stacks whose worktree is gone, another app's
 * dead stack and a project docker reported without config files. Only the two
 * `shop-*` gone ones are orphans.
 */
function projectsFor(appPath: string): ComposeProject[] {
  return [
    { name: 'shop', status: 'running(1)', configFiles: [join(appPath, 'compose.yml')] },
    { name: 'shop-feature-login', status: 'running(1)', configFiles: ['/gone/login/compose.yml'] },
    { name: 'shop-feature-cart', status: 'exited(1)', configFiles: ['/gone/cart/compose.yml'] },
    { name: 'other-app-feature', status: 'running(1)', configFiles: ['/gone/other/compose.yml'] },
    { name: 'shop-unknown', status: 'running(1)', configFiles: [] },
  ];
}

/**
 * `fakeDocker` answers the command's `lsProjects` / `downProject` calls with
 * the given projects, and records every stack it was asked to stop.
 */
function dockerWith(
  projects: ComposeProject[],
  failures: Record<string, string> = {},
  volumes: ComposeVolume[] = [],
): {
  instance: unknown;
  downProject: ReturnType<typeof vi.fn>;
  removeVolumes: ReturnType<typeof vi.fn>;
} {
  // Like the daemon: `down --volumes` takes the project's volumes with it.
  let remaining = [...volumes];
  const downProject = vi.fn((name: string, options: { volumes?: boolean }) => {
    const failure = failures[name];
    if (!failure && options.volumes) {
      remaining = remaining.filter((volume) => volume.project !== name);
    }
    return Promise.resolve(
      failure ? runResult({ exitCode: 1, stderr: failure }) : runResult({ stdout: 'Removed' }),
    );
  });
  const removeVolumes = vi.fn((names: string[]) => {
    remaining = remaining.filter((volume) => !names.includes(volume.name));
    return Promise.resolve(runResult());
  });

  return {
    downProject,
    removeVolumes,
    instance: {
      ...fakeDocker().instance,
      lsProjects: () => Promise.resolve(projects),
      lsVolumes: () => Promise.resolve(remaining),
      downProject,
      removeVolumes,
    },
  };
}

/**
 * Volumes on the daemon: the live main checkout's, one per orphan stack, one
 * left by a worktree that was stopped and then deleted (no containers, so no
 * compose project), one of a live but stopped worktree, and another app's.
 */
const VOLUMES: ComposeVolume[] = [
  { name: 'shop_sail-postgres', project: 'shop', volume: 'sail-postgres' },
  {
    name: 'shop-feature-login_sail-postgres',
    project: 'shop-feature-login',
    volume: 'sail-postgres',
  },
  {
    name: 'shop-feature-cart_sail-postgres',
    project: 'shop-feature-cart',
    volume: 'sail-postgres',
  },
  { name: 'shop-old-spike_sail-postgres', project: 'shop-old-spike', volume: 'sail-postgres' },
  { name: 'shop-paused_sail-postgres', project: 'shop-paused', volume: 'sail-postgres' },
  {
    name: 'other-app-feature_sail-postgres',
    project: 'other-app-feature',
    volume: 'sail-postgres',
  },
];

/** What `git worktree list` says still exists: the main checkout and `paused`. */
const LIVE = new Set(['shop', 'shop-paused']);

describe('sail:prune', () => {
  it('stops with the install hint when docker is unavailable', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--no-json']);
    vi.spyOn(command, 'docker').mockResolvedValue(
      fakeDocker({ unavailable: runResult({ exitCode: 1 }) }).instance as never,
    );
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('docker is down');
  });

  it('reports a failing docker compose ls with the daemon hint', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--no-json']);
    vi.spyOn(command, 'docker').mockResolvedValue({
      ...fakeDocker().instance,
      lsProjects: () => Promise.reject(new Error('docker compose ls failed: daemon not running')),
    } as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain(
      'Could not list compose projects: docker compose ls failed: daemon not running',
    );
    expect(output(kernel)).toContain('Is the Docker daemon running?');
  });

  it('lists orphans without touching them under --dry-run', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--dry-run', '--no-json']);
    const docker = dockerWith(projectsFor(path));
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('shop-feature-login');
    expect(output(kernel)).toContain('shop-feature-cart');
    expect(output(kernel)).toContain('re-run without --dry-run');
    expect(docker.downProject).not.toHaveBeenCalled();
  });

  it("never stops a live stack, another app's stack or a project without config files", async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--no-json']);
    const docker = dockerWith(projectsFor(path));
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(docker.downProject.mock.calls.map((call) => call[0])).toEqual([
      'shop-feature-login',
      'shop-feature-cart',
    ]);
    expect(output(kernel)).toContain(
      'Stopped orphan stack(s): shop-feature-login, shop-feature-cart',
    );
  });

  it('keeps the orphan volumes unless --volumes is passed', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const kept = await kernel.create(SailPrune, ['--no-json']);
    const keepingDocker = dockerWith(projectsFor(path));
    vi.spyOn(kept, 'docker').mockResolvedValue(keepingDocker.instance as never);
    await kept.exec();

    const wiped = await kernel.create(SailPrune, ['--volumes', '--no-json']);
    const wipingDocker = dockerWith(projectsFor(path));
    vi.spyOn(wiped, 'docker').mockResolvedValue(wipingDocker.instance as never);
    await wiped.exec();

    expect(keepingDocker.downProject.mock.calls[0]?.[1]).toEqual({ volumes: false });
    expect(wipingDocker.downProject.mock.calls[0]?.[1]).toEqual({ volumes: true });
  });

  it('reports a per-project failure without skipping the rest', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--no-json']);
    const docker = dockerWith(projectsFor(path), {
      'shop-feature-login': 'Error response from daemon: conflict\n',
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.downProject).toHaveBeenCalledTimes(2);
    expect(output(kernel)).toContain('Stopped orphan stack(s): shop-feature-cart');
    expect(output(kernel)).toContain('Could not stop "shop-feature-login"');
    expect(output(kernel)).toContain('Error response from daemon: conflict');
  });

  it('says everything belongs to a live worktree when there is no orphan', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--no-json']);
    const docker = dockerWith([
      { name: 'shop', status: 'running(1)', configFiles: [join(path, 'compose.yml')] },
    ]);
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('No orphan sail stacks');
    expect(docker.downProject).not.toHaveBeenCalled();
  });

  it('prints orphans, removals and failures under --json', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--json']);
    const docker = dockerWith(projectsFor(path), {
      'shop-feature-cart': 'Error response from daemon: conflict\n',
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toEqual({
      orphans: ['shop-feature-login', 'shop-feature-cart'],
      volumes: [],
      removed: ['shop-feature-login'],
      removedVolumes: [],
      failed: [{ name: 'shop-feature-cart', error: 'Error response from daemon: conflict' }],
    });
  });

  it('prints empty lists under --json when nothing is orphan', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--json']);
    const docker = dockerWith([
      { name: 'shop', status: 'running(1)', configFiles: [join(path, 'compose.yml')] },
    ]);
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      orphans: [],
      volumes: [],
      removed: [],
      removedVolumes: [],
    });
  });

  it('lists orphans without a removed list under --dry-run --json', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPrune, ['--dry-run', '--json']);
    const docker = dockerWith(projectsFor(path));
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      orphans: ['shop-feature-login', 'shop-feature-cart'],
      volumes: [],
      removed: [],
      removedVolumes: [],
    });
    expect(docker.downProject).not.toHaveBeenCalled();
  });

  describe('volumes', () => {
    async function prune(argv: string[], live: Set<string> | null = LIVE) {
      const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
      const command = await kernel.create(SailPrune, argv);
      const docker = dockerWith(projectsFor(path), {}, VOLUMES);
      vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
      vi.spyOn(command, 'liveProjects').mockResolvedValue(live);
      await command.exec();
      return { command, kernel, docker };
    }

    it('lists the volumes it would delete under --dry-run, deleting nothing', async () => {
      const { command, kernel, docker } = await prune(['--dry-run', '--json']);

      expect(command.exitCode).toBe(0);
      expect(jsonOutput(kernel)).toEqual({
        orphans: ['shop-feature-login', 'shop-feature-cart'],
        volumes: [
          'shop-feature-login_sail-postgres',
          'shop-feature-cart_sail-postgres',
          'shop-old-spike_sail-postgres',
        ],
        removed: [],
        removedVolumes: [],
      });
      expect(docker.downProject).not.toHaveBeenCalled();
      expect(docker.removeVolumes).not.toHaveBeenCalled();
    });

    it('says how to delete them in the human --dry-run output', async () => {
      const { kernel } = await prune(['--dry-run', '--no-json']);

      expect(output(kernel)).toContain('Orphan volumes (re-run with --volumes');
      expect(output(kernel)).toContain('shop-old-spike_sail-postgres');
      expect(output(kernel)).not.toContain('shop-paused_sail-postgres');
    });

    it('deletes the orphan volumes with --volumes, the leftover ones by name', async () => {
      const { command, kernel, docker } = await prune(['--volumes', '--json']);

      expect(command.exitCode).toBe(0);
      // down --volumes took the two stacks' volumes; the stack that has no
      // containers left is only reachable by volume name.
      expect(docker.removeVolumes).toHaveBeenCalledWith(['shop-old-spike_sail-postgres']);
      expect(jsonOutput(kernel)).toEqual({
        orphans: ['shop-feature-login', 'shop-feature-cart'],
        volumes: [
          'shop-feature-login_sail-postgres',
          'shop-feature-cart_sail-postgres',
          'shop-old-spike_sail-postgres',
        ],
        removed: ['shop-feature-login', 'shop-feature-cart'],
        removedVolumes: [
          'shop-feature-login_sail-postgres',
          'shop-feature-cart_sail-postgres',
          'shop-old-spike_sail-postgres',
        ],
        failed: [],
      });
    });

    it('keeps them without --volumes and says how to delete them', async () => {
      const { kernel, docker } = await prune(['--no-json']);

      expect(docker.removeVolumes).not.toHaveBeenCalled();
      expect(output(kernel)).toContain(
        'Kept 3 volume(s) of deleted worktrees: shop-feature-login_sail-postgres, shop-feature-cart_sail-postgres, shop-old-spike_sail-postgres — re-run with --volumes to delete them',
      );
    });

    it('never treats a container-less volume as orphan when git cannot list the worktrees', async () => {
      const { kernel } = await prune(['--dry-run', '--json'], null);

      expect(jsonOutput(kernel)).toMatchObject({
        volumes: ['shop-feature-login_sail-postgres', 'shop-feature-cart_sail-postgres'],
      });
    });
  });
});
