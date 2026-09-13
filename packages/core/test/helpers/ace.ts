import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '@adonisjs/core/ace';
import { AceFactory } from '@adonisjs/core/factories';

import type { RunResult } from '../../src/docker.js';

/**
 * Harness for driving a `sail:*` command the way ace does, against a throwaway
 * app on disk.
 *
 * The commands are where sail's behaviour actually lives — exit codes, the
 * `--json` payloads, the refusals — and none of it is reachable from the pure
 * modules the rest of the suite covers. Everything here is real except docker:
 * see {@link fakeDocker}.
 */
export interface TestApp {
  /** Absolute path of the throwaway app root. */
  path: string;
  /** Ace kernel bound to that app. */
  kernel: Kernel;
}

/**
 * Creates an app root with the files a sail command expects to find, and an
 * ace kernel pointed at it. `files` are written relative to the root, so a
 * test can hand the command a compose file, a `.env`, a `package.json` — or
 * deliberately omit one to exercise a failure path.
 */
export async function createTestApp(files: Record<string, string> = {}): Promise<TestApp> {
  const path = await mkdtemp(join(tmpdir(), 'sail-cmd-'));

  const withDefaults = { 'package.json': JSON.stringify({ name: 'shop' }), ...files };
  for (const [name, contents] of Object.entries(withDefaults)) {
    await writeFile(join(path, name), contents, 'utf8');
  }

  const kernel = await new AceFactory().make(new URL(`file://${path}/`));
  kernel.ui.switchMode('raw');

  return { path, kernel };
}

/** The lines a command logged, stripped of ace's formatting. */
export function logs(kernel: Kernel): string[] {
  return kernel.ui.logger.getLogs().map((log) => log.message);
}

/** Everything a command printed, as one string — for loose assertions. */
export function output(kernel: Kernel): string {
  return logs(kernel).join('\n');
}

/**
 * The single JSON document a command prints under `--json`. Fails loudly when
 * the output is not parseable, which is itself the contract under test.
 */
export function jsonOutput(kernel: Kernel): unknown {
  const printed = logs(kernel).join('\n');
  try {
    return JSON.parse(printed);
  } catch (error) {
    throw new Error(`expected one JSON document on stdout, got:\n${printed}\n\n${error}`);
  }
}

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

/**
 * A stand-in for {@link DockerCompose} that records what it was asked to do
 * and answers with canned results. Docker itself is exercised by
 * `proxy.integration.spec.ts`; here the point is what the command does with
 * the answer — which exit code it surfaces, what it prints, whether it stops.
 */
export function fakeDocker(results: Record<string, RunResult> = {}) {
  const calls: string[] = [];
  const answer = (name: string) => {
    calls.push(name);
    return Promise.resolve(results[name] ?? runResult());
  };

  return {
    calls,
    instance: {
      checkAvailability: () => Promise.resolve(results['unavailable'] ? 'docker is down' : null),
      up: () => answer('up'),
      down: () => answer('down'),
      logs: () => answer('logs'),
      exec: () => answer('exec'),
      execInteractive: () => answer('execInteractive'),
      ps: () => Promise.resolve([]),
      composeServices: () => Promise.resolve([]),
      takenHostPorts: () => Promise.resolve([]),
      publishedHostPorts: () => Promise.resolve([]),
      portHolders: () => Promise.resolve(new Map()),
      lsProjects: () => Promise.resolve([]),
      capturedLogs: () => answer('capturedLogs'),
      wantedHostPorts: () => [],
      downProject: () => answer('downProject'),
      servicePorts: () => ({}),
      portEnvironment: () => ({}),
    },
  };
}

/**
 * Every public method of the real `DockerCompose`, so a test that stubs it can
 * be trusted. A fake that answers to a name the class does not have is worse
 * than no fake: the command's `try/catch` turns the resulting `TypeError` into
 * a plausible-looking failure path, and the test passes while proving nothing.
 * `docker.spec.ts` asserts this list against the class.
 */
export const DOCKER_METHODS = [
  'capturedLogs',
  'checkAvailability',
  'composeServices',
  'down',
  'downProject',
  'exec',
  'execInteractive',
  'logs',
  'lsProjects',
  'portEnvironment',
  'portHolders',
  'ps',
  'publishedHostPorts',
  'servicePorts',
  'takenHostPorts',
  'up',
  'wantedHostPorts',
] as const;
