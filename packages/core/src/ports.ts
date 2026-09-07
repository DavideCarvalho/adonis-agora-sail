import { createHash } from 'node:crypto';

/**
 * The number of available port offsets. Deliberately identical to the range
 * used by `@adonisjs/core`'s worktree-aware `serve` command, so the app port
 * and every sail service port shift by the same amount in a given worktree.
 */
export const PORT_RANGE = 1000;

/**
 * Computes the deterministic port offset for a worktree name. The same
 * name always resolves to the same offset, on any machine, so teammates
 * working on a worktree with the same name get the same ports.
 */
export function computeWorktreePortOffset(worktreeName: string): number {
  const hash = createHash('sha1').update(worktreeName).digest();
  return hash.readUInt32BE(0) % PORT_RANGE;
}

/**
 * Resolves the host ports of a set of port definitions for a given offset,
 * keyed by the port's env var name.
 */
export function resolveHostPorts(
  ports: { envVar: string; basePort: number }[],
  offset: number,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const port of ports) {
    resolved[port.envVar] = port.basePort + offset;
  }
  return resolved;
}
