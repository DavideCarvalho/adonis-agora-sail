import { describe, expect, it, vi } from 'vitest';

import SailLogs from '../commands/sail_logs.js';
import type { RunResult } from '../src/docker.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

/**
 * The shared fake plus the options `docker.logs` was called with — the flags
 * only matter insofar as they reach compose.
 */
function dockerRecordingLogs(result: RunResult = runResult()) {
  const fake = fakeDocker({ logs: result });
  const options: unknown[] = [];
  return {
    calls: fake.calls,
    options,
    instance: {
      ...fake.instance,
      logs: (given: unknown) => {
        options.push(given);
        return fake.instance.logs();
      },
    },
  };
}

describe('sail:logs', () => {
  it('prints the captured logs for the whole stack', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--no-json', '--tail', '100']);
    const docker = fakeDocker({ logs: runResult({ stdout: 'postgres-1  | ready\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(docker.calls).toEqual(['logs']);
    expect(output(kernel)).toBe('postgres-1  | ready');
  });

  it('hands the service, --tail and --since through to compose', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, [
      '--no-json',
      'postgres',
      '--tail',
      '50',
      '--since',
      '10m',
    ]);
    const docker = dockerRecordingLogs();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(docker.options).toEqual([
      { service: 'postgres', tail: '50', since: '10m', follow: false },
    ]);
  });

  it('defaults to the last 100 lines of every service', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--no-json']);
    const docker = dockerRecordingLogs();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(docker.options).toEqual([
      { service: undefined, tail: '100', since: undefined, follow: false },
    ]);
  });

  it('refuses --follow together with --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--json', '--follow']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(jsonOutput(kernel)).toEqual({
      error: 'Cannot combine --follow with --json output',
      hint: 'Stream text with `node ace sail:logs --follow`, or poll once with `node ace sail:logs --tail 100 --json`',
    });
  });

  it('streams under --follow and returns the attached child exit code', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--no-json', '--follow']);
    const docker = dockerRecordingLogs(runResult({ exitCode: 130 }));
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(130);
    expect(docker.options).toEqual([
      { service: undefined, tail: '100', since: undefined, follow: true },
    ]);
    // Follow mode inherits stdio, so the command itself prints nothing.
    expect(output(kernel)).toBe('');
  });

  it('propagates the exit code when compose cannot read the logs', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--no-json', 'nope']);
    const docker = fakeDocker({
      logs: runResult({ exitCode: 2, stderr: 'no such service: nope\n' }),
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(2);
    expect(output(kernel)).toContain('Could not read logs:\nno such service: nope');
    expect(output(kernel)).toContain('Is the Docker daemon running?');
  });

  it('wraps the captured logs under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--json', 'postgres']);
    const docker = fakeDocker({ logs: runResult({ stdout: 'postgres-1  | ready\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      service: 'postgres',
      logs: 'postgres-1  | ready\n',
    });
  });

  it('reports a null service under --json when the argument is omitted', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailLogs, ['--json']);
    const docker = fakeDocker({ logs: runResult({ stdout: 'line\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(jsonOutput(kernel)).toEqual({ service: null, logs: 'line\n' });
  });

  it('fails before reaching docker when there is no compose file', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailLogs, ['--no-json']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('No compose file found at');
  });
});
