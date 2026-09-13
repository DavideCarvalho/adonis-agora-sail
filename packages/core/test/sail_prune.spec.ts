import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import SailPrune from '../commands/sail_prune.js';
import type { ComposeProject } from '../src/prune.js';
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
): { instance: unknown; downProject: ReturnType<typeof vi.fn> } {
  const downProject = vi.fn((name: string, _options: { volumes?: boolean }) => {
    const failure = failures[name];
    return Promise.resolve(
      failure ? runResult({ exitCode: 1, stderr: failure }) : runResult({ stdout: 'Removed' }),
    );
  });

  return {
    downProject,
    instance: {
      ...fakeDocker().instance,
      lsProjects: () => Promise.resolve(projects),
      downProject,
    },
  };
}

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
      removed: ['shop-feature-login'],
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
    expect(jsonOutput(kernel)).toEqual({ orphans: [], removed: [] });
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
      removed: [],
    });
    expect(docker.downProject).not.toHaveBeenCalled();
  });
});
