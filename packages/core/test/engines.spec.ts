import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

describe('engines.node', () => {
  it('promises Node 22, the oldest line Node still maintains', async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(pkg.engines.node).toBe('>=22');
  });

  it('is a floor CI actually tests, not just a number in package.json', async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const floor = /(\d+)/.exec(pkg.engines.node)?.[1];
    const ci = await readFile(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const matrix = /node:\s*\[([^\]]+)\]/
      .exec(ci)?.[1]
      ?.split(',')
      .map((entry) => entry.trim());

    expect(matrix).toContain(floor);
  });
});
