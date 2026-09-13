import { describe, expect, it, vi } from 'vitest';

import SailExec from '../commands/sail_exec.js';
import { createTestApp, fakeDocker, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  redis:
    image: redis:7
`;

describe('sail:exec', () => {
  it('runs the command after the `--` separator and prints its output', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, [
      '--no-json',
      'redis',
      '--',
      'redis-cli',
      'ping',
    ]);
    const docker = fakeDocker({ exec: runResult({ stdout: 'PONG\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(command.service).toBe('redis');
    expect(command.command).toEqual(['redis-cli', 'ping']);
    expect(docker.calls).toEqual(['exec']);
    expect(output(kernel)).toBe('PONG');
  });

  it('fails with usage before any docker call when no command is given', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, ['--no-json', 'redis']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('No command given');
    expect(output(kernel)).toContain(
      'Usage: node ace sail:exec <service> -- <command...> (e.g. node ace sail:exec redis -- redis-cli ping)',
    );
  });

  it("propagates the container command's exit code", async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, [
      '--no-json',
      'redis',
      '--',
      'redis-cli',
      'nope',
    ]);
    const docker = fakeDocker({
      exec: runResult({ exitCode: 3, stderr: "ERR unknown command 'nope'\n" }),
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(3);
    expect(output(kernel)).toContain("sail:exec failed (exit 3):\nERR unknown command 'nope'");
    expect(output(kernel)).toContain('Check the service name with `node ace sail:ps`');
  });

  it('relays container stdout verbatim even under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, ['--json', 'redis', '--', 'redis-cli', 'ping']);
    const docker = fakeDocker({ exec: runResult({ stdout: 'PONG\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    // The documented exception to one-JSON-document-per-command: sail:exec is a
    // passthrough and has no JSON success payload at all.
    expect(output(kernel)).toBe('PONG');
  });

  it('prints the JSON failure after the raw stdout under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, ['--json', 'redis', '--', 'redis-cli', 'nope']);
    const docker = fakeDocker({
      exec: runResult({ exitCode: 3, stdout: 'partial\n', stderr: 'boom\n' }),
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(3);
    expect(output(kernel)).toBe(
      `partial\n${JSON.stringify(
        {
          error: 'sail:exec failed (exit 3):\nboom',
          hint: 'Check the service name with `node ace sail:ps`',
        },
        null,
        2,
      )}`,
    );
  });

  it('fails when docker is unavailable', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailExec, [
      '--no-json',
      'redis',
      '--',
      'redis-cli',
      'ping',
    ]);
    const docker = fakeDocker({ unavailable: runResult() });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('docker is down');
    expect(output(kernel)).toContain('Install Docker (or start the daemon) and try again');
  });
});
