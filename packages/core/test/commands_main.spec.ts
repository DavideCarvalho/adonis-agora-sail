import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import loader, { getCommand, getMetaData } from '../commands/main.js';

const COMMANDS_DIR = new URL('../commands/', import.meta.url);

/**
 * Every `commandName` declared under `commands/`, found on disk rather than
 * through the barrel: a command the barrel forgot to list does not exist for
 * `node ace`, and nothing else would notice.
 */
async function declaredCommandNames(): Promise<string[]> {
  const files = (await readdir(fileURLToPath(COMMANDS_DIR)))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => new URL(file, COMMANDS_DIR).href);

  const names: string[] = [];
  for (const file of files) {
    const module = (await import(file)) as { default?: { commandName?: unknown } };
    const name = module.default?.commandName;
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    }
  }
  return names.sort();
}

describe('commands barrel', () => {
  it('registers every command declared under commands/', async () => {
    const metaData = await getMetaData();

    expect(metaData.map((command) => command.commandName).sort()).toEqual(
      await declaredCommandNames(),
    );
  });

  it('exposes the fourteen sail commands', async () => {
    const metaData = await getMetaData();

    expect(metaData).toHaveLength(14);
    expect(metaData.map((command) => command.commandName)).toEqual(
      expect.arrayContaining([
        'sail:install',
        'sail:up',
        'sail:down',
        'sail:ps',
        'sail:logs',
        'sail:info',
        'sail:exec',
        'sail:prune',
        'sail:sync-env',
        'sail:psql',
        'sail:mysql',
        'sail:redis',
        'sail:share',
        'sail:domain',
      ]),
    );
  });

  it('registers no command twice', async () => {
    const names = (await getMetaData()).map((command) => command.commandName);

    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every command it registers', async () => {
    for (const command of await getMetaData()) {
      expect(command.commandName.startsWith('sail:')).toBe(true);
      expect(command.description).toBeTruthy();
    }
  });

  it('resolves each command back to its constructor', async () => {
    const metaData = await getMetaData();

    for (const command of metaData) {
      const commandClass = await getCommand(command);
      expect(commandClass?.commandName).toBe(command.commandName);
    }
  });

  it('exports the loader the ace kernel consumes', async () => {
    expect(await loader.getMetaData()).toEqual(await getMetaData());
  });
});
