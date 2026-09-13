import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kernel } from '@adonisjs/core/ace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SailDomain from '../commands/sail_domain.js';
import { proxyPaths, routeConfigPath } from '../src/proxy.js';
import { createTestApp, jsonOutput, logs, output } from './helpers/ace.js';

/**
 * The kernel's log buffer accumulates across commands, so a test that runs
 * two of them reads the document the last one printed.
 */
function lastJson(kernel: Kernel): unknown {
  return JSON.parse(logs(kernel).at(-1) ?? '');
}

const docker = vi.hoisted(() => ({
  availability: null as string | null,
  upExitCode: 0,
  upStderr: '',
  calls: [] as string[],
}));

/**
 * The command builds its own `DockerCompose` for the shared proxy — that one
 * is not reachable through `command.docker()`, so the module is what gets
 * replaced. Calls are recorded as `<project>:<action>` because *which* project
 * was driven is half of what these tests assert.
 */
vi.mock('../src/docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/docker.js')>();

  class FakeDockerCompose {
    readonly #project: string;

    constructor(context: { projectName: string }) {
      this.#project = context.projectName;
    }

    checkAvailability() {
      return Promise.resolve(docker.availability);
    }

    up() {
      return this.#run('up', docker.upExitCode, docker.upStderr);
    }

    down() {
      return this.#run('down', 0, '');
    }

    #run(action: string, exitCode: number, stderr: string) {
      docker.calls.push(`${this.#project}:${action}`);
      return Promise.resolve({ exitCode, stdout: '', stderr });
    }
  }

  return { ...actual, DockerCompose: FakeDockerCompose as unknown as typeof actual.DockerCompose };
});

const mkcert = vi.hoisted(() => ({
  problem: null as string | null,
  caInstalled: true,
  issuedFor: [] as string[],
}));

vi.mock('../src/certs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/certs.js')>();
  const { mkdir, writeFile: write } = await import('node:fs/promises');

  return {
    ...actual,
    checkMkcert: () => Promise.resolve(mkcert.problem),
    isCaInstalled: () => Promise.resolve(mkcert.caInstalled),
    // Real files, fake contents: `hasIssuedCert` and the TLS config read the
    // cert dir back, so the pair has to actually be there.
    issueCert: async (options: { certsDir: string; projectName: string; hostnames: string[] }) => {
      mkcert.issuedFor.push(...options.hostnames);
      const paths = actual.certPaths(options.certsDir, options.projectName);
      await mkdir(options.certsDir, { recursive: true });
      await write(paths.certFile, 'cert', 'utf8');
      await write(paths.keyFile, 'key', 'utf8');
      return paths;
    },
  };
});

const dns = vi.hoisted(() => ({ resolves: false }));

// `resolvesLocally` asks the system resolver whether the domains answer; the
// answer is a test input here, not whatever this machine's DNS says.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();

  return {
    ...actual,
    lookup: (hostname: string) =>
      dns.resolves
        ? Promise.resolve({ address: '127.0.0.1', family: 4 })
        : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${hostname}`)),
  };
});

describe('sail:domain', () => {
  let sailHome: string;
  let paths: ReturnType<typeof proxyPaths>;

  beforeEach(async () => {
    // Every path the command writes hangs off $SAIL_HOME: no test may land in
    // the developer's real ~/.sail.
    sailHome = await mkdtemp(join(tmpdir(), 'sail-home-'));
    vi.stubEnv('SAIL_HOME', sailHome);
    paths = proxyPaths(sailHome);

    docker.availability = null;
    docker.upExitCode = 0;
    docker.upStderr = '';
    docker.calls = [];
    mkcert.problem = null;
    mkcert.caInstalled = true;
    mkcert.issuedFor = [];
    dns.resolves = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports the status without creating the proxy directory', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Domains are off for "shop"');
    expect(output(kernel)).toContain('127.0.0.1:3333');
    expect(existsSync(paths.root)).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  it('creates nothing when disabling an app that never enabled', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--disable']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('Domains were not enabled for "shop"');
    expect(existsSync(paths.root)).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  it('registers the route and issues a certificate when mkcert is available', async () => {
    dns.resolves = true;
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(docker.calls).toEqual(['sail-proxy:up']);
    expect(mkcert.issuedFor).toEqual(['shop.localhost', 'shop.test']);

    // Hostnames reach the route file as Traefik v3 host regexps.
    const route = await readFile(routeConfigPath(paths.confDir, 'shop'), 'utf8');
    expect(route).toContain('shop\\.localhost');
    expect(route).toContain('shop\\.test');
    expect(route).toContain(':3333');
    expect(route).toContain('shop-secure');

    expect(existsSync(join(paths.certsDir, 'shop.pem'))).toBe(true);
    expect(existsSync(join(paths.certsDir, 'shop-key.pem'))).toBe(true);
    expect(output(kernel)).toContain('https://shop.localhost');
  });

  it('falls back to HTTP when mkcert is missing', async () => {
    mkcert.problem = 'mkcert is not installed or not on PATH. Install mkcert and re-run';
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(mkcert.issuedFor).toEqual([]);
    expect(existsSync(join(paths.certsDir, 'shop.pem'))).toBe(false);

    const route = await readFile(routeConfigPath(paths.confDir, 'shop'), 'utf8');
    expect(route).not.toContain('shop-secure');
    expect(output(kernel)).toContain('http://shop.localhost');
    expect(output(kernel)).toContain('Serving HTTP only');
  });

  it('warns that an issued certificate is untrusted until the CA is installed', async () => {
    mkcert.caInstalled = false;
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('the browser will not trust it yet');
    expect(output(kernel)).toContain('mkcert -install');
  });

  it('points at the one-time DNS setup when the resolver does not answer', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable']);
    await command.exec();

    expect(output(kernel)).toContain("this machine's resolver does not");
    expect(output(kernel)).toContain('node ace sail:domain --install');
  });

  it('rolls the route back when the proxy fails to start', async () => {
    docker.upExitCode = 1;
    docker.upStderr = 'Bind for 0.0.0.0:80 failed: port is already allocated';
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(existsSync(routeConfigPath(paths.confDir, 'shop'))).toBe(false);
    expect(output(kernel)).toContain('Could not start the sail proxy');
    expect(output(kernel)).toContain('port is already allocated');
    expect(output(kernel)).toContain('Ports 80 and 443 must be free');
  });

  it('refuses --enable together with --disable', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--enable', '--disable']);
    await command.exec();

    expect(command.exitCode).toBe(1);
    expect(output(kernel)).toContain('Cannot combine --enable with --disable');
    expect(existsSync(paths.root)).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  it('prints the resolver setup for --install and runs nothing', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--no-json', '--install']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(output(kernel)).toContain('*.test');
    expect(output(kernel)).toContain('127.0.0.1');
    expect(docker.calls).toEqual([]);
    expect(mkcert.issuedFor).toEqual([]);
    expect(existsSync(paths.root)).toBe(false);
  });

  it('serves the hostname pinned in SAIL_DOMAIN', async () => {
    const { kernel } = await createTestApp({ '.env': 'SAIL_DOMAIN=shop.example\n' });
    const command = await kernel.create(SailDomain, ['--json', '--enable']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({
      hostnames: ['shop.example'],
      urls: ['https://shop.example'],
    });
    expect(mkcert.issuedFor).toEqual(['shop.example']);
  });

  it('normalises a pinned domain carrying a scheme, case and a port', async () => {
    const { kernel } = await createTestApp({ '.env': 'SAIL_DOMAIN=https://Shop.Test:3333\n' });
    const command = await kernel.create(SailDomain, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toMatchObject({ hostnames: ['shop.test'] });
  });

  it('prints the status payload under --json', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--json']);
    await command.exec();

    expect(jsonOutput(kernel)).toEqual({
      status: 'disabled',
      projectName: 'shop',
      hostnames: ['shop.localhost', 'shop.test'],
      urls: [],
      targetPort: 3333,
      tls: false,
    });
    expect(existsSync(paths.root)).toBe(false);
  });

  it('prints the enabled payload under --json', async () => {
    const { kernel } = await createTestApp();
    const command = await kernel.create(SailDomain, ['--json', '--enable']);
    await command.exec();

    expect(jsonOutput(kernel)).toEqual({
      status: 'enabled',
      projectName: 'shop',
      hostnames: ['shop.localhost', 'shop.test'],
      urls: ['https://shop.localhost', 'https://shop.test'],
      targetPort: 3333,
      tls: true,
      caInstalled: true,
      unresolved: ['shop.localhost', 'shop.test'],
    });
  });

  it('prints the disabled payload under --json and stops the last proxy', async () => {
    const { kernel } = await createTestApp();
    const enable = await kernel.create(SailDomain, ['--json', '--enable']);
    await enable.exec();

    const command = await kernel.create(SailDomain, ['--json', '--disable']);
    await command.exec();

    expect(command.exitCode).toBe(0);
    expect(lastJson(kernel)).toEqual({
      status: 'disabled',
      projectName: 'shop',
      hostnames: ['shop.localhost', 'shop.test'],
      removed: true,
      proxyStopped: true,
    });
    expect(existsSync(routeConfigPath(paths.confDir, 'shop'))).toBe(false);
    expect(docker.calls).toEqual(['sail-proxy:up', 'sail-proxy:down']);
  });

  it('leaves the proxy running when another app is still routed', async () => {
    const { kernel } = await createTestApp();
    const enable = await kernel.create(SailDomain, ['--json', '--enable']);
    await enable.exec();
    await writeFile(routeConfigPath(paths.confDir, 'other'), 'http: {}\n', 'utf8');

    const command = await kernel.create(SailDomain, ['--json', '--disable']);
    await command.exec();

    expect(lastJson(kernel)).toMatchObject({ removed: true, proxyStopped: false });
    expect(docker.calls).toEqual(['sail-proxy:up']);
  });
});
