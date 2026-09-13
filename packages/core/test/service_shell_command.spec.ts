import { describe, expect, it, vi } from 'vitest';

import SailPsql from '../commands/sail_psql.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
`;

const redisOnlyComposeFile = `services:
  redis:
    image: redis:7
`;

// The three shells share one implementation; sail:psql stands in for it here
// and sail_shells.spec.ts covers what each subclass binds.
describe('service shells', () => {
  it('refuses a service that is not in the compose file', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': redisOnlyComposeFile });
    const command = await kernel.create(SailPsql, ['--no-json', '--', '-c', 'select 1']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('The postgres service is not enabled');
    expect(output(kernel)).toContain('Run "node ace sail:install --services=postgres" first');
  });

  it('refuses the REPL under --json and hints the one-shot with the flag before `--`', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--json']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    const payload = jsonOutput(kernel) as { error: string; hint: string };
    expect(payload.error).toBe('Cannot open an interactive postgres shell with --json output');
    // Everything after `--` goes to psql, so a trailing --json would never
    // reach ace and the suggested re-run would open a REPL again.
    expect(payload.hint).toBe(`Pass a command instead: node ace sail:psql --json -- -c 'select 1'`);
  });

  it('refuses the REPL when there is no interactive terminal', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--no-json']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.canPrompt).toBe(false);
    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('No interactive terminal — cannot open a postgres shell');
    expect(output(kernel)).toContain(`Pass a command instead: node ace sail:psql -- -c 'select 1'`);
  });

  it('runs a one-shot and prints the trimmed client output', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--no-json', '--', '-c', 'select 1']);
    const docker = fakeDocker({
      exec: runResult({ stdout: ' ?column?\n---------\n        1\n\n' }),
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(docker.calls).toEqual(['exec']);
    expect(output(kernel)).toBe(' ?column?\n---------\n        1');
  });

  it('wraps the one-shot under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--json', '--', '-c', 'select 1']);
    const docker = fakeDocker({ exec: runResult({ stdout: '        1\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toEqual({
      service: 'postgres',
      command: ['psql', '-U', 'sail', '-d', 'app', '-c', 'select 1'],
      output: '        1\n',
    });
  });

  it("propagates the client's exit code on a failing one-shot", async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--no-json', '--', '-c', 'select boom']);
    const docker = fakeDocker({
      exec: runResult({ exitCode: 3, stderr: 'ERROR:  column "boom" does not exist\n' }),
    });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(3);
    expect(output(kernel)).toContain(
      'sail:psql failed (exit 3):\nERROR:  column "boom" does not exist',
    );
    expect(output(kernel)).toContain('Check the service is up with `node ace sail:ps`');
  });

  it('reports a failing one-shot as JSON with the same exit code', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailPsql, ['--json', '--', '-c', 'select boom']);
    const docker = fakeDocker({ exec: runResult({ exitCode: 3, stderr: 'ERROR:  nope\n' }) });
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(3);
    expect(jsonOutput(kernel)).toEqual({
      error: 'sail:psql failed (exit 3):\nERROR:  nope',
      hint: 'Check the service is up with `node ace sail:ps`',
    });
  });

  it('fails before reaching docker when there is no compose file', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailPsql, ['--no-json', '--', '-c', 'select 1']);
    const docker = fakeDocker();
    vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(output(kernel)).toContain('No compose file found at');
  });
});
