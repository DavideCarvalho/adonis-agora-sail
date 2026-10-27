import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ListLoader } from '@adonisjs/core/ace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LazySailLoader } from '../commands/lazy_loader.js';
import { COMMANDS, loadAllCommands } from '../commands/registry.js';

let dir: string;
let indexUrl: URL;

beforeAll(async () => {
  // Same content scripts/index_commands.mjs writes into dist/commands.
  dir = await mkdtemp(join(tmpdir(), 'sail-commands-index-'));
  const classes = await loadAllCommands();
  const commands = await new ListLoader(classes).getMetaData();
  const files = Object.fromEntries(
    classes.map((command, index) => [command.commandName, COMMANDS[index]?.file]),
  );
  indexUrl = pathToFileURL(join(dir, 'commands.json'));
  await writeFile(indexUrl, JSON.stringify({ commands, files }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LazySailLoader', () => {
  it('serves the same metadata from the index as the eager list loader', async () => {
    const eager = new ListLoader(await loadAllCommands());
    const lazy = new LazySailLoader(indexUrl);

    expect(await lazy.getMetaData()).toEqual(await eager.getMetaData());
  });

  it('resolves each indexed command back to its constructor', async () => {
    const lazy = new LazySailLoader(indexUrl);

    for (const command of await lazy.getMetaData()) {
      expect((await lazy.getCommand(command))?.commandName).toBe(command.commandName);
    }
  });

  it('returns null for a command it does not know', async () => {
    const lazy = new LazySailLoader(indexUrl);
    const [first] = await lazy.getMetaData();

    expect(await lazy.getCommand({ ...first!, commandName: 'sail:nope' })).toBeNull();
  });

  it('falls back to importing every command when there is no index', async () => {
    const eager = new ListLoader(await loadAllCommands());
    const lazy = new LazySailLoader(pathToFileURL(join(dir, 'missing.json')));

    expect(await lazy.getMetaData()).toEqual(await eager.getMetaData());
    const [first] = await lazy.getMetaData();
    expect((await lazy.getCommand(first!))?.commandName).toBe(first?.commandName);
  });

  it('is still a ListLoader for the ace kernel', () => {
    expect(new LazySailLoader(indexUrl)).toBeInstanceOf(ListLoader);
  });
});
