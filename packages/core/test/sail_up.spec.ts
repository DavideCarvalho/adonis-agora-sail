import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SailUp from '../commands/sail_up.js';
import { DockerCompose, type RunResult } from '../src/docker.js';
import { createTestApp, fakeDocker, jsonOutput, output, runResult } from './helpers/ace.js';

const objectStorageCompose = `services:
  rustfs:
    image: rustfs/rustfs:1.0.3
  redis:
    image: redis:7-alpine
`;

const composeFile = `services:
  postgres:
    image: postgres:17
    ports:
      - '\${SAIL_POSTGRES_PORT:-5432}:5432'
`;

/** The subset of {@link DockerCompose} `sail:up` reaches for. */
type DockerStub = Partial<{
  checkAvailability: () => Promise<string | null>;
  up: (options?: { pull?: boolean }) => Promise<RunResult>;
  takenHostPorts: () => Promise<number[]>;
  publishedHostPorts: () => Promise<number[]>;
  portHolders: () => Promise<Map<number, string[]>>;
  composeServices: () => Promise<string[]>;
  exec: (service: string, command: string[]) => Promise<RunResult>;
}>;

/**
 * Hands the command a fake docker with the given operations swapped in, and
 * returns the recorder — a test asserts on it to show the command stopped
 * before starting anything.
 */
function useDocker(
  command: SailUp,
  overrides: DockerStub = {},
  results: Record<string, RunResult> = {},
): string[] {
  const fake = fakeDocker(results);
  vi.spyOn(command, 'docker').mockResolvedValue({ ...fake.instance, ...overrides } as never);
  return fake.calls;
}

describe('sail:up', () => {
  beforeEach(async () => {
    // `sail:up` also refreshes the local-domain route when the app has one.
    // An empty SAIL_HOME means no route exists, so that branch stays out of
    // these tests (and never touches the real ~/.sail).
    vi.stubEnv('SAIL_HOME', await mkdtemp(join(tmpdir(), 'sail-home-')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refuses to start without a compose file, pointing at sail:install', async () => {
    const { kernel, path } = await createTestApp();
    const command = await kernel.create(SailUp, ['--no-json']);
    const calls = useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain(`No compose file found at ${join(path, 'compose.yml')}`);
    expect(output(kernel)).toContain('Run "node ace sail:install" first to generate it');
    expect(calls).toEqual([]);
  });

  it('refuses to start when docker is unavailable, reporting the reason', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    const calls = useDocker(command, {}, { unavailable: runResult() });
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('docker is down');
    expect(output(kernel)).toContain('Install Docker (or start the daemon) and try again');
    expect(calls).toEqual([]);
  });

  it('aborts naming the container that holds a wanted host port', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    const calls = useDocker(command, {
      takenHostPorts: () => Promise.resolve([5432]),
      publishedHostPorts: () => Promise.resolve([]),
      portHolders: () => Promise.resolve(new Map([[5432, ['other-app-postgres-1']]])),
    });
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain(
      'Cannot start: host port(s) already in use: :5432 (held by other-app-postgres-1)',
    );
    expect(output(kernel)).toContain('node ace sail:down');
    expect(calls).not.toContain('up');
  });

  it('names the bare port when docker will not say who holds it', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    useDocker(command, {
      takenHostPorts: () => Promise.resolve([5432]),
      publishedHostPorts: () => Promise.resolve([]),
      portHolders: () => Promise.resolve(new Map()),
    });
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('Cannot start: host port(s) already in use: :5432');
    expect(output(kernel)).not.toContain('held by');
  });

  it('stays a silent success when the taken ports are its own containers', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    const calls = useDocker(command, {
      takenHostPorts: () => Promise.resolve([5432]),
      publishedHostPorts: () => Promise.resolve([5432]),
    });
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(calls).toContain('up');
    expect(output(kernel)).toContain('Sail stack "shop" is up');
  });

  it('probes only the ports of the services the compose file declares', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    // Real port resolution — only the socket probe is replaced, because the
    // scoping under test lives in `composeServices`/`wantedHostPorts`.
    const real = new DockerCompose(await command.sailContext());
    const busy = new Set([3306]);
    const calls = useDocker(command, {
      takenHostPorts: async () =>
        real.wantedHostPorts(await real.composeServices()).filter((port) => busy.has(port)),
    });
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(calls).toContain('up');
  });

  it('aborts when a port of a declared service is busy', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    const real = new DockerCompose(await command.sailContext());
    const busy = new Set([5432]);
    const calls = useDocker(command, {
      takenHostPorts: async () =>
        real.wantedHostPorts(await real.composeServices()).filter((port) => busy.has(port)),
    });
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('already in use: :5432');
    expect(calls).not.toContain('up');
  });

  it('pulls images only when --pull is given', async () => {
    const pulls: (boolean | undefined)[] = [];
    const up = (options?: { pull?: boolean }) => {
      pulls.push(options?.pull);
      return Promise.resolve(runResult());
    };

    const plain = await createTestApp({ 'compose.yml': composeFile });
    const withoutPull = await plain.kernel.create(SailUp, ['--no-json']);
    useDocker(withoutPull, { up });
    await withoutPull.exec();

    const pulled = await createTestApp({ 'compose.yml': composeFile });
    const withPull = await pulled.kernel.create(SailUp, ['--no-json', '--pull']);
    useDocker(withPull, { up });
    await withPull.exec();

    expect(pulls).toEqual([false, true]);
  });

  it("propagates docker compose's exit code instead of a generic 1", async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    useDocker(
      command,
      {},
      { up: runResult({ exitCode: 17, stderr: 'no such image: postgres:17' }) },
    );
    await command.exec();

    expect(command.exitCode).toBe(17);
    expect(output(kernel)).toContain('sail:up failed:');
    expect(output(kernel)).toContain('no such image: postgres:17');
    expect(output(kernel)).toContain('node ace sail:logs');
    // A stack that never came up must not leave ports behind in .env.local.
    expect(existsSync(join(path, '.env.local'))).toBe(false);
  });

  it('reports the failure as one JSON document under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--json']);
    useDocker(command, {}, { up: runResult({ exitCode: 3, stderr: 'boom' }) });
    await command.exec();

    expect(command.exitCode).toBe(3);
    expect(jsonOutput(kernel)).toMatchObject({
      error: 'sail:up failed:\nboom',
      hint: 'Is the Docker daemon running? See `node ace sail:logs` for service output',
    });
  });

  it('syncs the worktree ports into the local env files and says so', async () => {
    const { kernel, path } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--no-json']);
    useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('env: .env.local created, .env.test.local created');
    expect(await readFile(join(path, '.env.local'), 'utf8')).toContain('DB_PORT=5432');
    expect(await readFile(join(path, '.env.test.local'), 'utf8')).toContain('DB_PORT=5432');
    // The summary is the same content `sail:info` prints.
    expect(output(kernel)).toContain('postgres: localhost:5432 -> 5432');
  });

  it('warns about an encrypted .env.local without failing the command', async () => {
    const { kernel } = await createTestApp({
      'compose.yml': composeFile,
      '.env.local': 'DB_PASSWORD=varlock(local:Zm9v)\n',
    });
    const command = await kernel.create(SailUp, ['--no-json']);
    useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Sail stack "shop" is up');
    expect(output(kernel)).toContain('env: .env.local skipped-encrypted, .env.test.local created');
    expect(output(kernel)).toContain('.env.local looks encrypted — ports NOT synced there');
  });

  it('prints one JSON document under --json', async () => {
    const { kernel } = await createTestApp({ 'compose.yml': composeFile });
    const command = await kernel.create(SailUp, ['--json']);
    useDocker(command);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(jsonOutput(kernel)).toMatchObject({
      status: 'up',
      envSync: {
        files: [
          { file: '.env.local', action: 'created' },
          { file: '.env.test.local', action: 'created' },
        ],
        gitignore: 'updated',
      },
      appName: 'shop',
      projectName: 'shop',
      worktree: null,
      portOffset: 0,
      services: [{ name: 'postgres' }],
      appEnv: { DB_HOST: '127.0.0.1', DB_PORT: '5432' },
    });
    // No route registered for this app, so no domain is reported.
    expect(jsonOutput(kernel)).not.toHaveProperty('domain');
  });

  describe('object storage bootstrap', () => {
    it('creates the bucket inside the container once the stack is healthy', async () => {
      const { kernel } = await createTestApp({ 'compose.yml': objectStorageCompose });
      const command = await kernel.create(SailUp, ['--json']);
      const execs: { service: string; command: string[] }[] = [];
      useDocker(command, {
        composeServices: () => Promise.resolve(['rustfs', 'redis']),
        exec: (service, argv) => {
          execs.push({ service, command: argv });
          return Promise.resolve(runResult());
        },
      });
      await command.exec();

      expect(command.exitCode).toBe(0);
      // Only the backend that needs it: redis has no bootstrap step.
      expect(execs).toHaveLength(1);
      expect(execs[0]?.service).toBe('rustfs');
      expect(execs[0]?.command.join(' ')).toContain('-X PUT http://127.0.0.1:9000/local');
      expect(jsonOutput(kernel)).toMatchObject({
        status: 'up',
        bootstrap: [{ service: 'rustfs', step: "create the 'local' bucket" }],
      });
    });

    it('fails, without syncing env, when the bootstrap step fails', async () => {
      const { kernel, path } = await createTestApp({ 'compose.yml': objectStorageCompose });
      const command = await kernel.create(SailUp, ['--no-json']);
      useDocker(command, {
        composeServices: () => Promise.resolve(['rustfs']),
        exec: () => Promise.resolve(runResult({ exitCode: 22, stderr: 'curl: (22) 403' })),
      });
      await command.exec();

      expect(command.exitCode).toBe(22);
      expect(output(kernel)).toContain(
        "sail:up started the stack but could not create the 'local' bucket in rustfs",
      );
      expect(output(kernel)).toContain('curl: (22) 403');
      expect(existsSync(join(path, '.env.local'))).toBe(false);
    });
  });

  describe('app env', () => {
    it("blanks REDIS_PASSWORD so a production password in .env never reaches sail's redis", async () => {
      const { kernel, path } = await createTestApp({
        'compose.yml': 'services:\n  redis:\n    image: redis:7-alpine\n',
      });
      const command = await kernel.create(SailUp, ['--no-json']);
      useDocker(command);
      await command.exec();

      expect(await readFile(join(path, '.env.local'), 'utf8')).toMatch(/^REDIS_PASSWORD=$/m);
    });

    it('leaves REDIS_PASSWORD out when start/env.ts requires it, since empty would fail boot', async () => {
      const { kernel, path } = await createTestApp({
        'compose.yml': 'services:\n  redis:\n    image: redis:7-alpine\n',
      });
      await mkdir(join(path, 'start'));
      await writeFile(
        join(path, 'start', 'env.ts'),
        'export default await Env.create(url, {\n  REDIS_PASSWORD: Env.schema.string(),\n})\n',
      );
      const command = await kernel.create(SailUp, ['--no-json']);
      useDocker(command);
      await command.exec();

      const local = await readFile(join(path, '.env.local'), 'utf8');
      expect(local).toContain('REDIS_PORT=6379');
      expect(local).not.toContain('REDIS_PASSWORD');
    });

    it('writes the object storage env under the names config/drive.ts reads', async () => {
      const { kernel, path } = await createTestApp({ 'compose.yml': objectStorageCompose });
      await mkdir(join(path, 'config'));
      await writeFile(
        join(path, 'config', 'drive.ts'),
        `export default defineConfig({
  default: env.get('DRIVE_DISK'),
  services: {
    s3: services.s3({
      credentials: {
        accessKeyId: env.get('S3_ACCESS_KEY'),
        secretAccessKey: env.get('S3_SECRET_KEY'),
      },
      region: 'us-east-1',
      bucket: env.get('S3_BUCKET'),
      endpoint: env.get('S3_URL'),
      forcePathStyle: env.get('S3_PATH_STYLE'),
    }),
  },
})
`,
      );
      const command = await kernel.create(SailUp, ['--no-json']);
      useDocker(command, { composeServices: () => Promise.resolve(['rustfs', 'redis']) });
      await command.exec();

      const local = await readFile(join(path, '.env.local'), 'utf8');
      expect(local).toContain('S3_ACCESS_KEY=sail');
      expect(local).toContain('S3_SECRET_KEY=password');
      expect(local).toContain('S3_BUCKET=local');
      expect(local).toContain('S3_URL=http://127.0.0.1:9000');
      expect(local).toContain('S3_PATH_STYLE=true');
      // Nothing under names the app never reads — the region is a literal.
      expect(local).not.toContain('AWS_');
      expect(local).not.toContain('S3_ENDPOINT');
    });
  });
});
