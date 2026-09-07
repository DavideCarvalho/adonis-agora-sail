import { existsSync } from 'node:fs';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { isRunningInAIAgent } from '@poppinss/utils';
import { resolveSailContext } from '../src/context.js';
import { DockerCompose } from '../src/docker.js';
import type { SailContext } from '../src/types.js';

/**
 * Shared plumbing for every sail command: the resolved worktree-aware
 * {@link SailContext}, a bound {@link DockerCompose} runner, and the
 * agent-aware output mode — inside an AI coding agent the commands default
 * to machine-readable JSON and never open an interactive prompt.
 */
export abstract class SailBaseCommand extends BaseCommand {
  static override options: CommandOptions = {};

  @flags.boolean({
    description: 'Output machine-readable JSON (defaults to on when running inside an AI agent)',
  })
  declare json?: boolean;

  #context?: SailContext;
  #docker?: DockerCompose;

  /**
   * Whether output should be JSON: explicit `--json` wins, otherwise it
   * follows AI-agent detection.
   */
  get wantsJson(): boolean {
    return this.json ?? isRunningInAIAgent();
  }

  /**
   * Whether the command may open interactive prompts.
   */
  get canPrompt(): boolean {
    return !isRunningInAIAgent() && process.stdin.isTTY === true;
  }

  async sailContext(): Promise<SailContext> {
    if (!this.#context) {
      this.#context = await resolveSailContext(this.app.appRoot);
    }
    return this.#context;
  }

  async docker(): Promise<DockerCompose> {
    if (!this.#docker) {
      this.#docker = new DockerCompose(await this.sailContext());
    }
    return this.#docker;
  }

  protected printJson(payload: unknown) {
    this.logger.log(JSON.stringify(payload, null, 2));
  }

  /**
   * Last non-blank lines of a command's output, for error messages.
   * Docker errors end with the cause; the full log is one `compose logs`
   * away, so the tail is all a failure message needs.
   */
  protected tailLines(text: string, max = 8): string {
    const lines = text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.slice(-max).join('\n');
  }

  protected failJsonAware(message: string, hint?: string) {
    this.exitCode = 1;
    if (this.wantsJson) {
      this.printJson({ error: message, ...(hint ? { hint } : {}) });
      return;
    }
    this.logger.error(message);
    if (hint) {
      this.logger.info(hint);
    }
  }

  /**
   * Fails the command when the compose file does not exist yet.
   * Returns true when it is safe to continue.
   */
  protected async ensureComposeFile(): Promise<boolean> {
    const context = await this.sailContext();
    if (existsSync(context.composeFilePath)) {
      return true;
    }
    this.failJsonAware(
      `No compose file found at ${context.composeFilePath}`,
      'Run "node ace sail:install" first to generate it',
    );
    return false;
  }

  /**
   * Fails the command when docker / the compose plugin is unavailable.
   * Returns true when it is safe to continue.
   */
  protected async ensureDocker(): Promise<boolean> {
    const docker = await this.docker();
    const problem = await docker.checkAvailability();
    if (problem === null) {
      return true;
    }
    this.failJsonAware(problem, 'Install Docker (or start the daemon) and try again');
    return false;
  }
}
