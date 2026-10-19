import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getGitWorktree } from '@poppinss/utils';
import { describe, expect, it } from 'vitest';

import { buildSailContext } from '../src/context.js';
import {
  type ComposeProject,
  findOrphanProjects,
  findOrphanVolumes,
  isManagedProject,
  liveProjectNames,
  parseComposeProjects,
  parseComposeVolumes,
} from '../src/prune.js';

const exec = promisify(execFile);

const ARRAY_JSON = JSON.stringify([
  { Name: 'shop', Status: 'running(2)', ConfigFiles: '/apps/shop/compose.yml' },
  {
    Name: 'shop-feature-login',
    Status: 'exited(2)',
    ConfigFiles: '/wt/login/compose.yml,/wt/login/compose.override.yml',
  },
  { Name: 'unrelated', Status: 'running(1)', ConfigFiles: '/other/compose.yml' },
]);

describe('parseComposeProjects', () => {
  it('parses the JSON-array shape', () => {
    expect(parseComposeProjects(ARRAY_JSON)).toEqual([
      { name: 'shop', status: 'running(2)', configFiles: ['/apps/shop/compose.yml'] },
      {
        name: 'shop-feature-login',
        status: 'exited(2)',
        configFiles: ['/wt/login/compose.yml', '/wt/login/compose.override.yml'],
      },
      { name: 'unrelated', status: 'running(1)', configFiles: ['/other/compose.yml'] },
    ]);
  });

  it('parses the NDJSON shape', () => {
    const ndjson = [
      JSON.stringify({ Name: 'shop', Status: 'running', ConfigFiles: '/apps/shop/compose.yml' }),
      JSON.stringify({ Name: 'shop-x', Status: 'exited', ConfigFiles: ['/gone/compose.yml'] }),
    ].join('\n');
    expect(parseComposeProjects(ndjson).map((project) => project.name)).toEqual(['shop', 'shop-x']);
  });

  it('returns an empty list for blank output', () => {
    expect(parseComposeProjects('  \n ')).toEqual([]);
  });
});

describe('isManagedProject', () => {
  it('matches the main project and per-worktree projects only', () => {
    expect(isManagedProject('shop', 'shop')).toBe(true);
    expect(isManagedProject('shop-feature-login', 'shop')).toBe(true);
    expect(isManagedProject('shopify', 'shop')).toBe(false);
    expect(isManagedProject('other', 'shop')).toBe(false);
  });

  it('sanitizes the app name before comparing', () => {
    expect(isManagedProject('scope-shop-x', '@scope/shop')).toBe(true);
  });
});

describe('findOrphanProjects', () => {
  const projects = parseComposeProjects(ARRAY_JSON);

  it('reports managed projects whose compose files are gone', () => {
    const orphans = findOrphanProjects(projects, 'shop', () => false);
    expect(orphans.map((project) => project.name)).toEqual(['shop', 'shop-feature-login']);
  });

  it('keeps projects whose files still exist', () => {
    const exists = (path: string) => path === '/apps/shop/compose.yml';
    expect(findOrphanProjects(projects, 'shop', exists).map((project) => project.name)).toEqual([
      'shop-feature-login',
    ]);
  });

  it('never touches other apps projects', () => {
    const other: ComposeProject = { name: 'other', status: 'running', configFiles: ['/gone.yml'] };
    expect(findOrphanProjects([other], 'shop', () => false)).toEqual([]);
  });

  it('leaves projects with no reported config files alone', () => {
    const bare: ComposeProject = { name: 'shop-bare', status: 'running', configFiles: [] };
    expect(findOrphanProjects([bare], 'shop', () => false)).toEqual([]);
  });
});

describe('parseComposeVolumes', () => {
  it('reads the project from the labels string docker prints', () => {
    const output = [
      JSON.stringify({
        Name: 'shop-x_sail-postgres',
        Labels: 'com.docker.compose.project=shop-x,com.docker.compose.volume=sail-postgres',
      }),
      JSON.stringify({ Name: 'loose-volume', Labels: '' }),
    ].join('\n');
    expect(parseComposeVolumes(output)).toEqual([
      { name: 'shop-x_sail-postgres', project: 'shop-x', volume: 'sail-postgres' },
    ]);
    expect(parseComposeVolumes('')).toEqual([]);
  });
});

describe('findOrphanVolumes', () => {
  const volumes = [
    { name: 'shop_sail-postgres', project: 'shop', volume: 'sail-postgres' },
    { name: 'shop-gone_sail-postgres', project: 'shop-gone', volume: 'sail-postgres' },
    { name: 'shop-stopped_sail-redis', project: 'shop-stopped', volume: 'sail-redis' },
    { name: 'shop-left_sail-postgres', project: 'shop-left', volume: 'sail-postgres' },
    // `shop-api` may be another app: without a sail volume name, hands off
    { name: 'shop-api_pgdata', project: 'shop-api', volume: 'pgdata' },
    { name: 'other_sail-postgres', project: 'other', volume: 'sail-postgres' },
  ];

  it('takes orphan stacks and container-less leftovers, never live or foreign ones', () => {
    expect(
      findOrphanVolumes(volumes, {
        appName: 'shop',
        orphanProjects: ['shop-gone'],
        knownProjects: ['shop', 'shop-gone'],
        liveProjects: new Set(['shop', 'shop-stopped']),
      }).map((volume) => volume.name),
    ).toEqual(['shop-gone_sail-postgres', 'shop-left_sail-postgres']);
  });

  it('only takes orphan stacks when the live worktrees are unknown', () => {
    expect(
      findOrphanVolumes(volumes, {
        appName: 'shop',
        orphanProjects: ['shop-gone'],
        knownProjects: ['shop', 'shop-gone'],
        liveProjects: null,
      }).map((volume) => volume.name),
    ).toEqual(['shop-gone_sail-postgres']);
  });
});

describe('liveProjectNames', () => {
  it('names the main checkout and every linked worktree the way sail:up does', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sail-live-')));
    const main = join(root, 'main');
    await mkdir(main);
    const git = (...args: string[]) => exec('git', args, { cwd: main });
    await git('init', '-q');
    await git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    await git('worktree', 'add', '-q', '-b', 'feature-login', join(root, 'Feature Login'));
    await git('worktree', 'add', '-q', '-b', 'gone', join(root, 'gone'));
    await rm(join(root, 'gone'), { recursive: true });

    const live = await liveProjectNames(main, 'shop');
    const worktree = await getGitWorktree(join(root, 'Feature Login'));

    expect(live).toEqual(new Set(['shop', 'shop-feature-login']));
    // the same project name the context computes inside that worktree
    expect(buildSailContext(join(root, 'Feature Login'), 'shop', worktree).projectName).toBe(
      'shop-feature-login',
    );
  });

  it('is null outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-nogit-'));
    await writeFile(join(dir, 'package.json'), '{}');
    expect(await liveProjectNames(dir, 'shop')).toBeNull();
  });
});
