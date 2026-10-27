// Writes dist/commands/commands.json: the serialized metadata of every sail
// command plus the file it lives in, so the commands barrel can answer the ace
// kernel without importing every command (see commands/main.ts). Run after tsc.
import { writeFile } from 'node:fs/promises';
import { ListLoader } from '@adonisjs/core/ace';

const distCommands = new URL('../dist/commands/', import.meta.url);
const { COMMANDS } = await import(new URL('registry.js', distCommands).href);

const classes = await Promise.all(COMMANDS.map(async (entry) => (await entry.load()).default));
const commands = await new ListLoader(classes).getMetaData();
const files = Object.fromEntries(
  classes.map((command, index) => [command.commandName, COMMANDS[index].file]),
);

await writeFile(
  new URL('commands.json', distCommands),
  `${JSON.stringify({ commands, files }, null, 2)}\n`,
);
console.log(`indexed ${commands.length} sail commands into dist/commands/commands.json`);
