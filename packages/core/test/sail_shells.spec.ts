import { describe, expect, it, vi } from 'vitest';

import SailMysql from '../commands/sail_mysql.js';
import SailPsql from '../commands/sail_psql.js';
import SailRedis from '../commands/sail_redis.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const composeFile = `services:
  postgres:
    image: postgres:17
  mysql:
    image: mysql:8
  redis:
    image: redis:7
`;

// The shared behaviour lives in service_shell_command.spec.ts; these three
// subclasses only pick a service and a client.
const shells = [
  {
    name: 'sail:psql',
    Command: SailPsql,
    service: 'postgres',
    clientArgs: ['-c', 'select 1'],
    argv: ['psql', '-U', 'sail', '-d', 'app', '-c', 'select 1'],
  },
  {
    name: 'sail:mysql',
    Command: SailMysql,
    service: 'mysql',
    clientArgs: ['-e', 'show tables'],
    argv: ['mysql', '-usail', '-ppassword', 'app', '-e', 'show tables'],
  },
  {
    name: 'sail:redis',
    Command: SailRedis,
    service: 'redis',
    clientArgs: ['ping'],
    argv: ['redis-cli', 'ping'],
  },
] as const;

describe('service shell commands', () => {
  for (const shell of shells) {
    it(`${shell.name} runs the ${shell.service} client in its own container`, async () => {
      const { kernel } = await createTestApp({ 'compose.yml': composeFile });
      const command = await kernel.create(shell.Command, ['--json', '--', ...shell.clientArgs]);
      const docker = fakeDocker({ exec: runResult({ stdout: 'ok\n' }) });
      vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

      await command.exec();

      expect(command.exitCode).toBe(0);
      expect(docker.calls).toEqual(['exec']);
      expect(jsonOutput(kernel)).toEqual({
        service: shell.service,
        command: shell.argv,
        output: 'ok\n',
      });
    });

    it(`${shell.name} names itself when the client fails`, async () => {
      const { kernel } = await createTestApp({ 'compose.yml': composeFile });
      const command = await kernel.create(shell.Command, ['--no-json', '--', ...shell.clientArgs]);
      const docker = fakeDocker({ exec: runResult({ exitCode: 2, stderr: 'boom\n' }) });
      vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

      await command.exec();

      expect(command.exitCode).toBe(2);
      expect(output(kernel)).toContain(`${shell.name} failed (exit 2):\nboom`);
    });

    it(`${shell.name} refuses when ${shell.service} is not enabled`, async () => {
      const { kernel } = await createTestApp({ 'compose.yml': 'services: {}\n' });
      const command = await kernel.create(shell.Command, ['--no-json', '--', ...shell.clientArgs]);
      const docker = fakeDocker();
      vi.spyOn(command, 'docker').mockResolvedValue(docker.instance as never);

      await command.exec();

      expect(command.exitCode).toBe(1);
      expect(docker.calls).toEqual([]);
      expect(output(kernel)).toContain(`The ${shell.service} service is not enabled`);
      expect(output(kernel)).toContain(
        `Run "node ace sail:install --services=${shell.service}" first`,
      );
    });
  }
});
