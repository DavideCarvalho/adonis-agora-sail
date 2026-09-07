import { describe, expect, it } from 'vitest';

import {
  type ComposeProject,
  findOrphanProjects,
  isManagedProject,
  parseComposeProjects,
} from '../src/prune.js';

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
