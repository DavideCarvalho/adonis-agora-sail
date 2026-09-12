import { describe, expect, it } from 'vitest';

import { DB_SHELL_SERVICES, dbShellCommand, dbShellExample } from '../src/db_shell.js';

describe('dbShellCommand', () => {
  it('opens the stock clients with the sail dev credentials', () => {
    expect(dbShellCommand('postgres')).toEqual(['psql', '-U', 'sail', '-d', 'app']);
    expect(dbShellCommand('mysql')).toEqual(['mysql', '-usail', '-ppassword', 'app']);
    expect(dbShellCommand('redis')).toEqual(['redis-cli']);
  });

  it('passes extra args through verbatim', () => {
    expect(dbShellCommand('postgres', ['-c', 'select 1'])).toEqual([
      'psql',
      '-U',
      'sail',
      '-d',
      'app',
      '-c',
      'select 1',
    ]);
    expect(dbShellCommand('redis', ['ping'])).toEqual(['redis-cli', 'ping']);
  });

  it('keeps ace flags before the `--` separator', () => {
    // Everything after `--` is handed to the client, so a trailing --json
    // would reach psql instead of ace.
    expect(dbShellExample('postgres', { json: true })).toBe(
      `node ace sail:psql --json -- -c 'select 1'`,
    );
    expect(dbShellExample('redis', { json: true })).toBe('node ace sail:redis --json -- ping');
    for (const service of DB_SHELL_SERVICES) {
      const example = dbShellExample(service, { json: true });
      expect(example.indexOf('--json')).toBeLessThan(example.indexOf(' -- '));
    }
  });

  it('covers every shell service', () => {
    expect(DB_SHELL_SERVICES).toEqual(['postgres', 'mysql', 'redis']);
    for (const service of DB_SHELL_SERVICES) {
      expect(dbShellCommand(service).length).toBeGreaterThan(0);
      expect(dbShellExample(service)).toContain(
        `sail:${service === 'postgres' ? 'psql' : service}`,
      );
    }
  });
});
