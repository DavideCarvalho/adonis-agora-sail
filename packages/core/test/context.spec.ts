import { describe, expect, it } from 'vitest';

import { buildSailContext, sanitizeProjectName } from '../src/context.js';
import { computeWorktreePortOffset } from '../src/ports.js';

const WORKTREE = {
  name: 'Feature Login',
  slug: 'feature-login',
  hash: 'abc123',
  path: '/wt/login',
};

describe('sanitizeProjectName', () => {
  it('lowercases and replaces invalid characters', () => {
    expect(sanitizeProjectName('My App')).toBe('my-app');
    expect(sanitizeProjectName('@scope/my-app')).toBe('scope-my-app');
    expect(sanitizeProjectName('UPPER_CASE.name')).toBe('upper_case-name');
  });

  it('falls back to app for empty input', () => {
    expect(sanitizeProjectName('')).toBe('app');
    expect(sanitizeProjectName('---')).toBe('app');
  });
});

describe('buildSailContext', () => {
  it('uses base ports and the bare app name in the main checkout', () => {
    const context = buildSailContext('/apps/shop', 'shop', null);
    expect(context).toMatchObject({
      appName: 'shop',
      projectName: 'shop',
      worktree: null,
      portOffset: 0,
      composeFilePath: '/apps/shop/compose.yml',
    });
  });

  it('scopes the project name and offsets ports in a linked worktree', () => {
    const context = buildSailContext('/wt/login', 'shop', WORKTREE);
    expect(context.projectName).toBe('shop-feature-login');
    expect(context.portOffset).toBe(computeWorktreePortOffset('Feature Login'));
    expect(context.worktree).toBe(WORKTREE);
  });
});
