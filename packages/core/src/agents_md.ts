/**
 * Idempotent `AGENTS.md` snippet managed by `sail:install`.
 *
 * The section is deliberately generic — no worktree names, no concrete ports:
 * the file is committed and shared across every worktree and machine, while
 * ports shift per worktree. Agents get the live values from
 * `node ace sail:info --json`.
 */
export const AGENTS_MD_START = '<!-- sail:start -->';
export const AGENTS_MD_END = '<!-- sail:end -->';

const SECTION_BODY = [
  '## Sail (local dev services)',
  '',
  '- Start services with `node ace sail:up` (idempotent, waits for healthchecks); stop with `node ace sail:down`.',
  '- Each git worktree gets isolated containers and shifted host ports. Never hardcode ports: run `node ace sail:info --json` for the actual ports, dashboards and connection env.',
  '- Status and logs: `node ace sail:ps --json`, `node ace sail:logs --tail 100`.',
].join('\n');

/**
 * Builds the managed `AGENTS.md` section, markers included.
 */
export function buildAgentsMdSection(): string {
  return `${AGENTS_MD_START}\n${SECTION_BODY}\n${AGENTS_MD_END}`;
}

/**
 * Inserts the sail section into an `AGENTS.md` body, or replaces it in place
 * when the markers are already there. Takes the previous file content (or
 * null when the file does not exist) and returns the new content. Running it
 * twice is a no-op — the markers make the update idempotent.
 */
export function upsertAgentsMd(
  existing: string | null,
  section: string = buildAgentsMdSection(),
): string {
  if (!existing || existing.trim().length === 0) {
    return `${section}\n`;
  }

  const start = existing.indexOf(AGENTS_MD_START);
  const end = existing.indexOf(AGENTS_MD_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${section}${existing.slice(end + AGENTS_MD_END.length)}`;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${section}\n`;
}
