import { describe, expect, it } from 'vitest';

import { computeWorktreePortOffset, PORT_RANGE, resolveHostPorts } from '../src/ports.js';

describe('computeWorktreePortOffset', () => {
  it('is deterministic for the same worktree name', () => {
    expect(computeWorktreePortOffset('feature-login')).toBe(
      computeWorktreePortOffset('feature-login'),
    );
  });

  it('stays inside the documented range', () => {
    for (const name of ['main', 'feature-login', 'fix/auth-bug', 'release-2.x', 'davi']) {
      const offset = computeWorktreePortOffset(name);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(PORT_RANGE);
    }
  });

  it('matches the core serve range so app and service ports shift together', () => {
    expect(PORT_RANGE).toBe(1000);
  });
});

describe('resolveHostPorts', () => {
  it('adds the offset to every base port, keyed by env var', () => {
    expect(
      resolveHostPorts(
        [
          { envVar: 'SAIL_POSTGRES_PORT', basePort: 5432 },
          { envVar: 'SAIL_REDIS_PORT', basePort: 6379 },
        ],
        123,
      ),
    ).toEqual({ SAIL_POSTGRES_PORT: 5555, SAIL_REDIS_PORT: 6502 });
  });

  it('keeps base ports with a zero offset (main checkout)', () => {
    expect(resolveHostPorts([{ envVar: 'SAIL_POSTGRES_PORT', basePort: 5432 }], 0)).toEqual({
      SAIL_POSTGRES_PORT: 5432,
    });
  });
});
