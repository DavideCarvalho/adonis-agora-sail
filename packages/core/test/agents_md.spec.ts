import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD_END,
  AGENTS_MD_START,
  buildAgentsMdSection,
  updateAgentsMd,
  upsertAgentsMd,
} from '../src/agents_md.js';

describe('buildAgentsMdSection', () => {
  it('is wrapped in markers and stays generic (no ports, no worktree names)', () => {
    const section = buildAgentsMdSection();
    expect(section.startsWith(AGENTS_MD_START)).toBe(true);
    expect(section.endsWith(AGENTS_MD_END)).toBe(true);
    expect(section).toContain('sail:info --json');
    // the checksum in the start marker is hex; the body is what agents read
    const body = section.slice(section.indexOf('-->') + 3);
    expect(body).not.toMatch(/\d{4,5}/);
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

  it('keeps a section someone edited, byte for byte', () => {
    const once = upsertAgentsMd('# My app\n');
    const translated = once.replace('Start services with', 'Suba os serviços com');
    expect(updateAgentsMd(translated)).toEqual({ content: translated, action: 'kept' });
  });

  it('refreshes a section sail wrote and nobody touched', () => {
    const old = buildAgentsMdSection('## Sail\n\n- an older wording');
    const updated = updateAgentsMd(`# My app\n\n${old}\n`);
    expect(updated.action).toBe('updated');
    expect(updated.content).toBe(`# My app\n\n${buildAgentsMdSection()}\n`);
  });

  it('treats a checksum-less 0.4 section as stock only while its text is', () => {
    const stock = buildAgentsMdSection().replace(
      /<!-- sail:start checksum=\w+ -->/,
      '<!-- sail:start -->',
    );
    expect(updateAgentsMd(stock).action).toBe('updated');
    const edited = stock.replace('Start services', 'Bring services up');
    expect(updateAgentsMd(edited).action).toBe('kept');
  });
});
