import { readFile } from 'node:fs/promises';
import { ListLoader } from '@adonisjs/core/ace';
import type { CommandMetaData } from '@adonisjs/core/types/ace';

import { COMMANDS, loadAllCommands } from './registry.js';
import type SailPs from './sail_ps.js';

export type SailCommand = typeof SailPs;

/**
 * Shape of `commands.json`, generated next to the compiled barrel at build
 * time (`scripts/index_commands.mjs`): the serialized metadata of every
 * command, plus the file each command lives in.
 */
export interface CommandsIndex {
  commands: CommandMetaData[];
  files: Record<string, string>;
}

/**
 * A {@link ListLoader} that answers from the generated `commands.json` index
 * instead of importing every command up front — the same lazy pattern
 * AdonisJS's own packages use for their commands.
 *
 * The ace kernel reads every registered loader's metadata on EVERY `node ace`
 * invocation (`serve`, `migration:run`, …), not only `sail:*` ones, so an
 * eager barrel made each of them pay for loading all fifteen commands and
 * their dependencies (`yaml`, the app scanner, …). With the index, metadata is
 * one small JSON read and a command module loads only when it runs.
 *
 * When there is no index (running from source, or a build that skipped the
 * indexing step) it falls back to importing every command, exactly like the
 * plain list loader it extends — same metadata, same constructors.
 */
export class LazySailLoader extends ListLoader<SailCommand> {
  #index?: Promise<CommandsIndex | null>;
  #eager?: Promise<ListLoader<SailCommand>>;

  /** @param indexUrl where the generated `commands.json` lives. */
  constructor(private readonly indexUrl: URL) {
    super([]);
  }

  #readIndex(): Promise<CommandsIndex | null> {
    this.#index ??= readFile(this.indexUrl, 'utf8').then(
      (raw) => JSON.parse(raw) as CommandsIndex,
      () => null,
    );
    return this.#index;
  }

  #eagerLoader(): Promise<ListLoader<SailCommand>> {
    this.#eager ??= loadAllCommands().then(
      (commands) => new ListLoader(commands as unknown as SailCommand[]),
    );
    return this.#eager;
  }

  override async getMetaData(): Promise<CommandMetaData[]> {
    const index = await this.#readIndex();
    if (index === null) {
      return (await this.#eagerLoader()).getMetaData();
    }
    return index.commands;
  }

  override async getCommand(metaData: CommandMetaData): Promise<SailCommand | null> {
    const index = await this.#readIndex();
    if (index === null) {
      return (await this.#eagerLoader()).getCommand(metaData);
    }
    const file = index.files[metaData.commandName];
    const entry =
      file === undefined ? undefined : COMMANDS.find((command) => command.file === file);
    if (entry === undefined) {
      return null;
    }
    return (await entry.load()).default as unknown as SailCommand;
  }
}
