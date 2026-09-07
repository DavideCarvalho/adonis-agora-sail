import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildSailContext } from '../src/context.js';
import { buildStackInfo, formatAppEnv, formatStackInfo, resolveStackInfo } from '../src/info.js';

describe('buildStackInfo', () => {
  it('applies the worktree offset to every host port', () => {
    const info = buildStackInfo(buildSailContext('/wt/x', 'shop', null), ['postgres', 'redis']);
    const postgres = info.services.find((service) => service.name === 'postgres');
    expect(postgres?.ports).toEqual([
      { label: 'postgres', envVar: 'SAIL_POSTGRES_PORT', hostPort: 5432, containerPort: 5432 },
    ]);
    expect(info.appEnv).toMatchObject({ DB_PORT: '5432', REDIS_PORT: '6379' });
  });

  it('shifts ports and dashboard urls by the offset', () => {
    const context = buildSailContext('/wt/login', 'shop', {
      name: 'login',
      slug: 'login',
      hash: 'abc123',
      path: '/wt/login',
    });
    const info = buildStackInfo(context, ['mailpit']);
    expect(info.portOffset).toBeGreaterThanOrEqual(0);
    expect(info.appEnv['SMTP_PORT']).toBe(String(1025 + context.portOffset));
    expect(info.services[0]?.dashboards[0]?.url).toBe(
      `http://localhost:${8025 + context.portOffset}`,
    );
  });
});

describe('formatStackInfo', () => {
  it('mentions the project, ports and app env', () => {
    const text = formatStackInfo(
      buildStackInfo(buildSailContext('/apps/shop', 'shop', null), ['postgres']),
    );
    expect(text).toContain('Sail stack "shop"');
    expect(text).toContain('localhost:5432 -> 5432');
    expect(text).toContain('DB_HOST=127.0.0.1');
  });

  it('explains itself when no services are enabled', () => {
    const info = buildStackInfo(buildSailContext('/apps/shop', 'shop', null), []);
    expect(formatStackInfo(info)).toContain('sail:install');
  });
});

describe('formatAppEnv', () => {
  it('prints sorted KEY=value lines with no decoration', () => {
    const text = formatAppEnv(
      buildStackInfo(buildSailContext('/apps/shop', 'shop', null), ['redis', 'postgres']),
    );
    const lines = text.split('\n');
    expect(lines).toContain('DB_PORT=5432');
    expect(lines).toContain('REDIS_PORT=6379');
    expect(lines).toEqual([...lines].sort());
  });
});

describe('resolveStackInfo', () => {
  it('reads the enabled services from the managed compose file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-info-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@scope/shop' }), 'utf8');
    const { generateComposeFile } = await import('../src/compose_file.js');
    await writeFile(join(dir, 'compose.yml'), generateComposeFile(['postgres']), 'utf8');

    const { context, services, info } = await resolveStackInfo(pathToFileURL(`${dir}/`));
    // /tmp lives outside any git repo, so there is no worktree and no offset
    expect(context.worktree).toBeNull();
    expect(context.appName).toBe('shop');
    expect(services).toEqual(['postgres']);
    expect(info.projectName).toBe('shop');
  });

  it('falls back to dependency auto-detection before install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-detect-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'shop', dependencies: { ioredis: '^5.0.0' } }),
      'utf8',
    );

    const { services } = await resolveStackInfo(pathToFileURL(`${dir}/`));
    expect(services).toEqual(['redis']);
  });
});
