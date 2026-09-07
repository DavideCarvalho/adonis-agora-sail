import type Configure from '@adonisjs/core/commands/configure';

/**
 * `node ace add @adonis-agora/sail` (or `node ace configure @adonis-agora/sail`)
 * — registers the sail commands barrel in `adonisrc.ts`, which is what makes
 * `sail:install`, `sail:up`, `sail:info` and friends show up in `node ace list`.
 *
 * There is no provider and no config file: sail is dev tooling, it never boots
 * with the app. Run `node ace sail:install` next to generate `compose.yml`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addCommand('@adonis-agora/sail/commands');
  });
}
