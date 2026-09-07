import { describe, expect, it } from 'vitest';

import { configure } from '../configure.js';

/**
 * A minimal stand-in for the pieces of ace's `Configure` command the hook drives.
 * Recording the calls is enough: the hook's whole job is to hand the right
 * specifier to `updateRcFile`, and getting it wrong is invisible until
 * someone's `node ace list` misses every `sail:*` command.
 */
function recordingCommand() {
  const commands: string[] = [];
  const providers: string[] = [];

  const codemods = {
    async updateRcFile(callback: (rcFile: unknown) => void) {
      callback({
        addCommand: (specifier: string) => commands.push(specifier),
        addProvider: (specifier: string) => providers.push(specifier),
      });
    },
  };

  return {
    commands,
    providers,
    command: {
      async createCodemods() {
        return codemods;
      },
    },
  };
}

describe('configure', () => {
  it('registers the commands barrel so `sail:*` is discoverable', async () => {
    const recorder = recordingCommand();

    await configure(recorder.command as never);

    expect(recorder.commands).toEqual(['@adonis-agora/sail/commands']);
  });

  it('registers no provider — sail is dev tooling and never boots with the app', async () => {
    const recorder = recordingCommand();

    await configure(recorder.command as never);

    expect(recorder.providers).toEqual([]);
  });

  it('registers specifiers this package actually exports', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    const recorder = recordingCommand();

    await configure(recorder.command as never);

    for (const specifier of [...recorder.providers, ...recorder.commands]) {
      expect(specifier.startsWith(`${pkg.name}/`)).toBe(true);
      expect(Object.keys(pkg.exports)).toContain(`./${specifier.slice(pkg.name.length + 1)}`);
    }
  });

  it('is re-exported from the package root, where `ace configure` looks for it', async () => {
    // `ace configure <pkg>` / `ace add <pkg>` import the package ROOT and
    // read `.configure` off it — the `./configure` subpath alone is never
    // consulted. Shipping the hook only there fails with "does not export
    // the configure hook" (caught live against two real apps).
    const index = (await import('../src/index.js')) as { configure: unknown };
    expect(index.configure).toBe(configure);
  });
});
