import { spawn } from 'node:child_process';

import { resolveHostPorts } from './ports.js';
import { type ComposeProject, parseComposeProjects } from './prune.js';
import { SERVICES } from './services.js';
import type { SailContext, SailServiceName, SailServiceStatus } from './types.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper around the `docker compose` CLI, bound to a {@link SailContext}:
 * every invocation targets the context's compose file and project name, and
 * carries the worktree-offset `SAIL_*_PORT` variables in its environment so
 * the `${VAR:-default}` interpolations in the compose file resolve to the
 * per-worktree ports.
 */
export class DockerCompose {
  constructor(private context: SailContext) {}

  /**
   * The `SAIL_*_PORT` variables for every known service, offset for the
   * current worktree. Injecting all of them is harmless — compose only reads
   * the ones the file mentions.
   */
  portEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const service of Object.values(SERVICES)) {
      const resolved = resolveHostPorts(service.ports, this.context.portOffset);
      for (const [envVar, port] of Object.entries(resolved)) {
        environment[envVar] = String(port);
      }
    }
    return environment;
  }

  /**
   * Resolved host ports for one service, keyed by env var name.
   */
  servicePorts(name: SailServiceName): Record<string, number> {
    return resolveHostPorts(SERVICES[name].ports, this.context.portOffset);
  }

  private spawnDocker(
    fullArgs: string[],
    options: { inheritStdio?: boolean } = {},
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', fullArgs, {
        env: { ...process.env, ...this.portEnvironment() },
        stdio: options.inheritStdio ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }

  private run(args: string[], options: { inheritStdio?: boolean } = {}): Promise<RunResult> {
    return this.spawnDocker(
      [
        'compose',
        '--file',
        this.context.composeFilePath,
        '--project-name',
        this.context.projectName,
        ...args,
      ],
      options,
    );
  }

  /**
   * Global (unscoped) compose invocation: no `--file`, no `--project-name`.
   * Used for operations that span projects (`ls`) or target a project whose
   * compose file is already gone (`downProject` on an orphan stack).
   */
  private runGlobal(args: string[]): Promise<RunResult> {
    return this.spawnDocker(['compose', ...args]);
  }

  /**
   * Returns null when docker (or the compose plugin) is available, otherwise
   * a human-readable reason.
   */
  async checkAvailability(): Promise<string | null> {
    try {
      const result = await this.runGlobal(['version', '--short']);
      return result.exitCode === 0
        ? null
        : `docker compose is not usable: ${result.stderr.trim() || 'unknown error'}`;
    } catch {
      return 'docker is not installed or not on PATH';
    }
  }

  /**
   * Starts the stack detached and waits for healthchecks. Idempotent: an
   * already-running stack resolves successfully without changes.
   */
  up(options: { pull?: boolean } = {}): Promise<RunResult> {
    const args = ['up', '--detach', '--wait', '--remove-orphans'];
    if (options.pull) {
      args.push('--pull', 'always');
    }
    return this.run(args);
  }

  /**
   * Stops the stack. With `volumes`, also deletes the named volumes (data!).
   */
  down(options: { volumes?: boolean } = {}): Promise<RunResult> {
    const args = ['down', '--remove-orphans'];
    if (options.volumes) {
      args.push('--volumes');
    }
    return this.run(args);
  }

  /**
   * Stops another project by name — used by `sail:prune` for orphan stacks
   * whose compose file no longer exists, so this goes through the global
   * (file-less) invocation.
   */
  downProject(projectName: string, options: { volumes?: boolean } = {}): Promise<RunResult> {
    const args = ['--project-name', projectName, 'down', '--remove-orphans'];
    if (options.volumes) {
      args.push('--volumes');
    }
    return this.runGlobal(args);
  }

  /**
   * Lists every compose project on the daemon, parsed into
   * {@link ComposeProject} entries.
   */
  async lsProjects(): Promise<ComposeProject[]> {
    const result = await this.runGlobal(['ls', '--format', 'json']);
    if (result.exitCode !== 0) {
      throw new Error(`docker compose ls failed: ${result.stderr.trim()}`);
    }
    return parseComposeProjects(result.stdout);
  }

  /**
   * Runs a one-shot command inside a service container without a TTY
   * (`exec -T`) and captures its output. Non-interactive on purpose: agents
   * and scripts get plain text back, and interactive sessions should use
   * the `sail:psql` / `sail:mysql` / `sail:redis` shells (or `execInteractive`
   * via `docker compose exec` directly).
   */
  exec(service: string, command: string[]): Promise<RunResult> {
    return this.run(['exec', '-T', service, ...command]);
  }

  /**
   * Runs a command attached to the terminal (no `-T`, stdio inherited) and
   * waits for it to exit. Used by the interactive service shells: output and
   * colors flow straight through, and Ctrl+C reaches the client.
   */
  execInteractive(service: string, command: string[]): Promise<RunResult> {
    return this.run(['exec', service, ...command], { inheritStdio: true });
  }

  /**
   * Runs `docker compose logs`. Streams to the terminal only with
   * `follow`; otherwise the output comes back in the {@link RunResult}.
   */
  logs(options: {
    service?: string | undefined;
    tail?: string | undefined;
    since?: string | undefined;
    follow?: boolean | undefined;
  }) {
    const args = ['logs', '--no-color'];
    if (options.tail) {
      args.push('--tail', options.tail);
    }
    if (options.since) {
      args.push('--since', options.since);
    }
    if (options.follow) {
      args.push('--follow');
    }
    if (options.service) {
      args.push(options.service);
    }
    return this.run(args, { inheritStdio: options.follow === true });
  }

  /**
   * Captures service logs and returns them as text.
   */
  capturedLogs(options: {
    service?: string | undefined;
    tail?: string | undefined;
    since?: string | undefined;
  }): Promise<RunResult> {
    return this.logs({ ...options, follow: false });
  }

  /**
   * Lists the stack's containers. Handles both `docker compose ps --format
   * json` output shapes (a JSON array on older versions, NDJSON on newer).
   */
  async ps(): Promise<SailServiceStatus[]> {
    const result = await this.run(['ps', '--all', '--format', 'json']);
    if (result.exitCode !== 0) {
      throw new Error(`docker compose ps failed: ${result.stderr.trim()}`);
    }
    return parsePsEntries(result.stdout);
  }
}

/**
 * Parses `docker compose ps --all --format json` output. Handles both shapes
 * (a JSON array on older versions, NDJSON on newer) and dedupes publishers:
 * newer compose versions report each published port twice (IPv4 + IPv6).
 */
export function parsePsEntries(stdout: string): SailServiceStatus[] {
  const raw = stdout.trim();
  if (!raw) {
    return [];
  }

  const entries: Record<string, unknown>[] = raw.startsWith('[')
    ? (JSON.parse(raw) as Record<string, unknown>[])
    : raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);

  return entries.map((entry) => {
    // Newer compose versions report each published port twice (one entry
    // per address family: 0.0.0.0 and ::). Dedupe so `sail:ps` shows each
    // mapping once.
    const seen = new Set<string>();
    const publishers: { hostPort: number; containerPort: number }[] = [];
    if (Array.isArray(entry['Publishers'])) {
      for (const publisher of entry['Publishers'] as Record<string, unknown>[]) {
        const hostPort = Number(publisher['PublishedPort']);
        const containerPort = Number(publisher['TargetPort']);
        if (!(hostPort > 0)) {
          continue;
        }
        const key = `${hostPort}->${containerPort}`;
        if (!seen.has(key)) {
          seen.add(key);
          publishers.push({ hostPort, containerPort });
        }
      }
    }
    return {
      name: String(entry['Service'] ?? entry['Name'] ?? ''),
      state: String(entry['State'] ?? ''),
      health: String(entry['Health'] ?? ''),
      publishers,
    };
  });
}
