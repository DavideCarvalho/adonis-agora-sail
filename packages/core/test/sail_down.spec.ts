import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SailDown from '../commands/sail_down.js';
import type { RunResult } from '../src/docker.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

/** The subset of `DockerCompose` `sail:down` reaches for. */
type DockerStub = Partial<{
  checkAvailability: () => Promise<string | null>;
  down: (options?: { volumes?: boolean }) => Promise<RunResult>;
}>;

function useDocker(
  command: SailDown,
  overrides: DockerStub = {},
  results: Record<string, RunResult> = {},
): string[] {
  const fake = fakeDocker(results);
  vi.spyOn(command, 'docker').mockResolvedValue({ ...fake.instance, ...overrides } as never);
  return fake.calls;
}

/**
 * Tests never run on a TTY, so the confirmation branch has to be forced open
 * to be exercised at all — `canPrompt` is the one thing the command reads.
 */
function allowPrompts(command: SailDown) {
  Object.defineProperty(command, 'canPrompt', { get: () => true });
}

const CONFIRMATION = 'Delete named volumes? All local service data will be lost';

describe('sail:down', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the stack for the current worktree', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json']);
    const volumes: (boolean | undefined)[] = [];
    useDocker(command, {
      down: (options) => {
        volumes.push(options?.volumes);
        return Promise.resolve(runResult());
      },
    });
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Sail stack "shop" is down');
    expect(volumes).toEqual([false]);
  });

  it('refuses to run without a compose file, before asking anything', async () => {
    const { kernel, path } = await createTestApp();
    const command = await kernel.create(SailDown, ['--no-json', '--volumes']);
    allowPrompts(command);
    const confirm = vi.spyOn(command.prompt, 'confirm').mockResolvedValue(true);
    const calls = useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain(`No compose file found at ${join(path, 'compose.yml')}`);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('deletes volumes without prompting outside a TTY', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json', '--volumes']);
    const confirm = vi.spyOn(command.prompt, 'confirm');
    const volumes: (boolean | undefined)[] = [];
    useDocker(command, {
      down: (options) => {
        volumes.push(options?.volumes);
        return Promise.resolve(runResult());
      },
    });
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(volumes).toEqual([true]);
    expect(output(kernel)).toContain('Sail stack "shop" is down (volumes deleted)');
  });

  it('confirms the volume deletion in an interactive session', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json', '--volumes']);
    allowPrompts(command);
    const confirm = vi.spyOn(command.prompt, 'confirm').mockResolvedValue(true);
    const calls = useDocker(command);
    await command.exec();

    expect(confirm).toHaveBeenCalledWith(CONFIRMATION);
    expect(command.exitCode).toBe(0);
    expect(calls).toContain('down');
  });

  it('aborts without touching the stack when the confirmation is declined', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json', '--volumes']);
    allowPrompts(command);
    vi.spyOn(command.prompt, 'confirm').mockResolvedValue(false);
    const calls = useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Aborted — containers left running, volumes kept.');
    expect(calls).toEqual([]);
  });

  it('treats a cancelled prompt as a decline', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json', '--volumes']);
    allowPrompts(command);
    vi.spyOn(command.prompt, 'confirm').mockRejectedValue(new Error('Prompt cancelled'));
    const calls = useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Aborted — containers left running, volumes kept.');
    expect(calls).toEqual([]);
  });

  it("propagates docker compose's exit code instead of a generic 1", async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--no-json']);
    useDocker(command, {}, { down: runResult({ exitCode: 14, stderr: 'permission denied' }) });
    await command.exec();

    expect(command.exitCode).toBe(14);
    expect(output(kernel)).toContain('sail:down failed:');
    expect(output(kernel)).toContain('permission denied');
    expect(output(kernel)).toContain('Is the Docker daemon running?');
  });

  it('reports the failure as one JSON document under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--json']);
    useDocker(command, {}, { down: runResult({ exitCode: 5, stderr: 'boom' }) });
    await command.exec();

    expect(command.exitCode).toBe(5);
    expect(jsonOutput(kernel)).toMatchObject({
      error: 'sail:down failed:\nboom',
      hint: 'Is the Docker daemon running?',
    });
  });

  it('prints one JSON document under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--json']);
    useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toMatchObject({
      status: 'down',
      projectName: 'shop',
      volumes: false,
    });
  });

  it('reports the deleted volumes in the JSON document', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--json', '--volumes']);
    useDocker(command);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({ status: 'down', volumes: true });
  });

  it('keeps stdout parseable when the volume prompt is declined under --json', async () => {
    // The abort is the one exit that used to print a bare log line while
    // --json was on, breaking the one-document contract the rest honours.
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailDown, ['--json', '--volumes']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);
    vi.spyOn(command, 'canPrompt', 'get').mockReturnValue(true);
    vi.spyOn(command.prompt, 'confirm').mockResolvedValue(false);
    await command.exec();

    expect(jsonOutput(kernel)).toEqual({
      status: 'aborted',
      message: 'Aborted — containers left running, volumes kept.',
    });
    expect(docker.calls).not.toContain('down');
  });
});
