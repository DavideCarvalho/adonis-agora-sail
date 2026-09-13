import { describe, expect, it, vi } from 'vitest';

import SailPs from '../commands/sail_ps.js';
import type { SailServiceStatus } from '../src/types.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

const RUNNING: SailServiceStatus = {
  name: 'postgres',
  state: 'running',
  health: 'healthy',
  publishers: [{ hostPort: 5432, containerPort: 5432 }],
};

const STOPPED: SailServiceStatus = {
  name: 'redis',
  state: 'exited',
  health: '',
  publishers: [],
};

describe('sail:ps', () => {
  it('refuses to run before the compose file exists', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailPs, ['--no-json']);
    const docker = fakeDocker();
    const checkAvailability = vi.spyOn(docker.instance, 'checkAvailability');
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('No compose file found at');
    expect(output(kernel)).toContain('node ace sail:install');
    // The compose-file check comes first so a fresh checkout never waits on docker.
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it('stops with the install hint when docker is unavailable', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--no-json']);
    const docker = fakeDocker({ unavailable: runResult({ exitCode: 1 }) });
    const ps = vi.spyOn(docker.instance, 'ps');
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('docker is down');
    expect(output(kernel)).toContain('Install Docker (or start the daemon) and try again');
    expect(ps).not.toHaveBeenCalled();
  });

  it('renders one line per container with health and published ports', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--no-json']);
    vi.spyOn(command, 'docker').mockResolvedValue({
      ...fakeDocker().instance,
      ps: () => Promise.resolve([RUNNING, STOPPED]),
    } as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('postgres  running (healthy)  5432->5432');
    // No health and no published ports: neither decoration is rendered.
    expect(output(kernel)).toContain('redis  exited');
    expect(output(kernel)).not.toContain('redis  exited (');
  });

  it('points at sail:up when the stack has no containers', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--no-json']);
    vi.spyOn(command, 'docker').mockResolvedValue(fakeDocker().instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('No containers for this stack. Run "node ace sail:up"');
  });

  it('reports a failing docker compose ps with the daemon hint', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--no-json']);
    vi.spyOn(command, 'docker').mockResolvedValue({
      ...fakeDocker().instance,
      ps: () => Promise.reject(new Error('docker compose ps failed: permission denied')),
    } as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain(
      'Could not list containers: docker compose ps failed: permission denied',
    );
    expect(output(kernel)).toContain('Is the Docker daemon running?');
  });

  it('prints the statuses as a JSON array under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--json']);
    vi.spyOn(command, 'docker').mockResolvedValue({
      ...fakeDocker().instance,
      ps: () => Promise.resolve([RUNNING, STOPPED]),
    } as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual([RUNNING, STOPPED]);
  });

  it('prints an empty array for an empty stack under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPs, ['--json']);
    vi.spyOn(command, 'docker').mockResolvedValue(fakeDocker().instance as never);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual([]);
  });

  it('reports a preflight failure as JSON under --json', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailPs, ['--json']);
    vi.spyOn(command, 'docker').mockResolvedValue(fakeDocker().instance as never);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(jsonOutput(kernel)).toMatchObject({
      hint: 'Run "node ace sail:install" first to generate it',
    });
  });
});
