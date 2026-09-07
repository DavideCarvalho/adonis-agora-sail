import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD_END,
  AGENTS_MD_START,
  buildAgentsMdSection,
  upsertAgentsMd,
} from '../src/agents_md.js';

describe('buildAgentsMdSection', () => {
  it('is wrapped in markers and stays generic (no ports, no worktree names)', () => {
    const section = buildAgentsMdSection();
    expect(section.startsWith(AGENTS_MD_START)).toBe(true);
    expect(section.endsWith(AGENTS_MD_END)).toBe(true);
    expect(section).toContain('sail:info --json');
    expect(section).not.toMatch(/\d{4,5}/);
  });
});

describe('upsertAgentsMd', () => {
  it('creates the file body when there is none', () => {
    expect(upsertAgentsMd(null)).toBe(`${buildAgentsMdSection()}\n`);
    expect(upsertAgentsMd('   \n')).toBe(`${buildAgentsMdSection()}\n`);
  });

  it('appends the section to existing content', () => {
    const updated = upsertAgentsMd('# My app\n');
    expect(updated.startsWith('# My app\n')).toBe(true);
    expect(updated).toContain(AGENTS_MD_START);
  });

  it('replaces the section in place on re-runs (idempotent)', () => {
    const once = upsertAgentsMd('# My app\n');
    const twice = upsertAgentsMd(once);
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(AGENTS_MD_START, 'g'))).toHaveLength(1);
  });
});
