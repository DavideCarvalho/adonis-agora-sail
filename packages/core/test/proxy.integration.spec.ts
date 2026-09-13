import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { generateProxyComposeFile, usesHostNetwork } from '../src/proxy.js';
import { ensureProxyScaffold, writeRoute } from '../src/proxy_state.js';

const execFileAsync = promisify(execFile);

/**
 * The rest of the suite asserts the YAML sail *writes*. This one hands that
 * YAML to a real Traefik and checks a request actually arrives — the class of
 * bug the unit tests structurally cannot see: a rule that parses but matches
 * nothing, a target address the container cannot reach, a compose file docker
 * rejects.
 *
 * Skipped when docker is unavailable, so a laptop without it still runs a
 * green suite; CI has docker, so there it always runs.
 */
async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['compose', 'version', '--short']);
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

// Skipping is for laptops. In CI a missing docker would mean this file quietly
// proves nothing, which is worse than a red build.
if (!hasDocker && process.env['CI']) {
  throw new Error('docker is required to run the proxy integration test in CI');
}

/** Entrypoints are moved off 80/443: this asserts routing, not port binding. */
const WEB_PORT = 18080;
const SECURE_PORT = 18443;
const PROJECT = `sail-it-${process.pid}`;

/**
 * Raw `http.request` rather than `fetch`: undici treats `host` as a forbidden
 * header and drops it, which is precisely the header being tested here.
 */
function request(host: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: WEB_PORT, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Moves the proxy off 80/443, which a dev machine usually has spoken for.
 *
 * Where the move has to happen depends on how the proxy is attached: with host
 * networking the entrypoint *is* the host port, while off the bridge the
 * entrypoints stay put and the published mapping moves. Remapping the wrong
 * one leaves docker publishing a port nothing listens on — which is a red
 * suite on macOS and Windows, where the bridge is the only mode.
 */
function movePorts(compose: string, hostNetwork = usesHostNetwork()): string {
  return hostNetwork
    ? compose
        .replace('--entrypoints.web.address=:80', `--entrypoints.web.address=:${WEB_PORT}`)
        .replace(
          '--entrypoints.websecure.address=:443',
          `--entrypoints.websecure.address=:${SECURE_PORT}`,
        )
    : compose.replace("'80:80'", `'${WEB_PORT}:80'`).replace("'443:443'", `'${SECURE_PORT}:443'`);
}

describe('the fixture rewrite this suite runs on', () => {
  // Linux is the only mode CI can exercise end to end, so the branch a macOS
  // contributor hits is checked here instead of going unverified.
  it('moves the entrypoints under host networking', () => {
    const moved = movePorts(generateProxyComposeFile({ hostNetwork: true }), true);

    expect(moved).toContain(`--entrypoints.web.address=:${WEB_PORT}`);
    expect(moved).toContain(`--entrypoints.websecure.address=:${SECURE_PORT}`);
  });

  it('moves the published mapping off the bridge, leaving the entrypoints alone', () => {
    const moved = movePorts(generateProxyComposeFile({ hostNetwork: false }), false);
    const compose = parse(moved);

    expect(compose.services.traefik.ports).toEqual([`${WEB_PORT}:80`, `${SECURE_PORT}:443`]);
    expect(moved).toContain('--entrypoints.web.address=:80');
    expect(moved).toContain('--entrypoints.websecure.address=:443');
  });
});

describe.skipIf(!hasDocker)('the generated proxy config routes real traffic', () => {
  let app: Server;
  let composeFile: string;
  let appPort: number;

  beforeAll(async () => {
    app = createServer((req, res) => res.end(`hit:${req.headers.host}${req.url}`));
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    appPort = typeof address === 'object' && address ? address.port : 0;

    const home = await mkdtemp(join(tmpdir(), 'sail-it-'));
    const paths = await ensureProxyScaffold(home);
    composeFile = paths.composeFile;

    await writeRoute({
      projectName: 'shop',
      hostnames: ['shop.localhost', 'shop.test'],
      targetPort: appPort,
      tls: false,
      home,
    });

    // Move the proxy off 80/443, which a dev machine usually has spoken for.
    // Where that move has to happen depends on how the proxy is attached: with
    // host networking the entrypoint *is* the host port, while off the bridge
    // the entrypoints stay put and the published mapping moves — remapping the
    // wrong one leaves docker publishing a port nothing listens on.
    await writeFile(composeFile, movePorts(await readFile(composeFile, 'utf8')), 'utf8');

    await execFileAsync('docker', [
      'compose',
      '--file',
      composeFile,
      '--project-name',
      PROJECT,
      'up',
      '--detach',
      '--wait',
    ]);
  }, 180_000);

  afterAll(async () => {
    if (composeFile) {
      await execFileAsync('docker', [
        'compose',
        '--file',
        composeFile,
        '--project-name',
        PROJECT,
        'down',
        '--volumes',
      ]).catch(() => {});
    }
    app?.close();
  }, 60_000);

  it('reaches the app on the host', async () => {
    // The whole point of the feature: the name arrives at the app, and the
    // app is on the host rather than in a container.
    await expect(request('shop.localhost')).resolves.toEqual({
      status: 200,
      body: 'hit:shop.localhost/',
    });
  });

  it('routes every configured hostname to the same app', async () => {
    await expect(request('shop.test', '/health')).resolves.toEqual({
      status: 200,
      body: 'hit:shop.test/health',
    });
  });

  it('routes subdomains, which is what tenant-per-subdomain apps need', async () => {
    await expect(request('tenant1.shop.localhost')).resolves.toMatchObject({ status: 200 });
    await expect(request('deep.nested.shop.test')).resolves.toMatchObject({ status: 200 });
  });

  it('does not answer for a host it was not configured for', async () => {
    await expect(request('notshop.localhost')).resolves.toMatchObject({ status: 404 });
    await expect(request('other.test')).resolves.toMatchObject({ status: 404 });
  });

  it('does not answer for a name that merely starts with the hostname', async () => {
    // `shop.localhost.evil.com` must not match `shop.localhost` — the anchor
    // in the generated rule is what stops it.
    await expect(request('shop.localhost.evil.com')).resolves.toMatchObject({ status: 404 });
  });

  it('follows the port when the route is rewritten under a live proxy', async () => {
    const moved = createServer((req, res) => res.end(`moved:${req.headers.host}`));
    await new Promise<void>((resolve) => moved.listen(0, '127.0.0.1', resolve));
    const address = moved.address();
    const movedPort = typeof address === 'object' && address ? address.port : 0;

    const home = join(composeFile, '..', '..');
    await writeRoute({
      projectName: 'shop',
      hostnames: ['shop.localhost', 'shop.test'],
      targetPort: movedPort,
      tls: false,
      home,
    });

    // Traefik watches the conf dir; this is the `sail:up` refresh path, and it
    // must take effect without restarting the proxy.
    await expect
      .poll(async () => (await request('shop.localhost')).body, { timeout: 15_000 })
      .toBe('moved:shop.localhost');

    moved.close();
  }, 30_000);
});
