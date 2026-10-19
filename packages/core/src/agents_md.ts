import { createHash } from 'node:crypto';

/**
 * Idempotent `AGENTS.md` snippet managed by `sail:install`.
 *
 * The section is deliberately generic — no worktree names, no concrete ports:
 * the file is committed and shared across every worktree and machine, while
 * ports shift per worktree. Agents get the live values from
 * `node ace sail:info --json`.
 */
export const AGENTS_MD_START = '<!-- sail:start';
export const AGENTS_MD_END = '<!-- sail:end -->';

const SECTION_BODY = [
  '## Sail (local dev services)',
  '',
  '- Start services with `node ace sail:up` (idempotent, waits for healthchecks); stop with `node ace sail:down`.',
  '- Each git worktree gets isolated containers and shifted host ports. Never hardcode ports: run `node ace sail:info --json` for the actual ports, dashboards and connection env.',
  '- Status and logs: `node ace sail:ps --json`, `node ace sail:logs --tail 100`.',
].join('\n');

/**
 * Fingerprint of a section body, stored in the start marker so a later
 * install can tell its own text from text a person rewrote.
 */
export function agentsMdChecksum(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex').slice(0, 12);
}

/**
 * Builds the managed `AGENTS.md` section, markers included. The start marker
 * carries the checksum of the body (`<!-- sail:start checksum=… -->`).
 */
export function buildAgentsMdSection(body: string = SECTION_BODY): string {
  return `<!-- sail:start checksum=${agentsMdChecksum(body)} -->\n${body}\n${AGENTS_MD_END}`;
}

/**
 * What {@link updateAgentsMd} did: `kept` means the section was edited by
 * hand (translated, reworded) and sail left it alone.
 */
export type AgentsMdAction = 'created' | 'appended' | 'updated' | 'unchanged' | 'kept';

const START_MARKER_PATTERN = /<!-- sail:start(?:\s+checksum=([0-9a-f]+))?\s*-->/;

/**
 * Inserts or refreshes the sail section of an `AGENTS.md` body, without ever
 * clobbering a section someone edited:
 *
 * - no file, or no markers → the section is created / appended;
 * - markers whose body still matches the checksum in the start marker → sail
 *   wrote it and nobody changed it since, so it is refreshed to the current
 *   text (a no-op when that is identical);
 * - markers whose body does not match → someone edited it (a translation, a
 *   house-style rewrite): left byte-for-byte as it is, reported as `kept`;
 * - markers without a checksum (written by sail 0.4 and earlier) → refreshed
 *   only while the body is still the stock text, kept otherwise.
 *
 * To get the stock text back, delete the section, markers included, and
 * re-run install.
 */
export function updateAgentsMd(
  existing: string | null,
  section: string = buildAgentsMdSection(),
): { content: string; action: AgentsMdAction } {
  if (!existing || existing.trim().length === 0) {
    return { content: `${section}\n`, action: 'created' };
  }

  const start = START_MARKER_PATTERN.exec(existing);
  const end = start ? existing.indexOf(AGENTS_MD_END, start.index) : -1;
  if (start && end !== -1) {
    const body = existing.slice(start.index + start[0].length, end);
    const checksum = start[1];
    const pristine = checksum
      ? agentsMdChecksum(body) === checksum
      : body.trim() === SECTION_BODY.trim();
    if (!pristine) {
      return { content: existing, action: 'kept' };
    }
    const content = `${existing.slice(0, start.index)}${section}${existing.slice(end + AGENTS_MD_END.length)}`;
    return { content, action: content === existing ? 'unchanged' : 'updated' };
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${existing}${separator}${section}\n`, action: 'appended' };
}

/**
 * {@link updateAgentsMd}, returning just the new content. Running it twice is
 * a no-op, and a hand-edited section is never overwritten.
 */
export function upsertAgentsMd(
  existing: string | null,
  section: string = buildAgentsMdSection(),
): string {
  return updateAgentsMd(existing, section).content;
}
