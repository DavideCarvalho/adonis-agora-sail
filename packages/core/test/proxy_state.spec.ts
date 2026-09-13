import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  PROXY_PROJECT_NAME,
  proxyPaths,
  proxyTargetHost,
  routeConfigPath,
  usesHostNetwork,
} from '../src/proxy.js';
import {
  ensureProxyScaffold,
  hasIssuedCert,
  isDomainEnabled,
  proxyContext,
  refreshTlsConfig,
  removeRoute,
  resolveDomainHostnames,
  writeRoute,
} from '../src/proxy_state.js';

async function proxyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sail-proxy-'));
}

describe('ensureProxyScaffold', () => {
  it('creates the directories and writes the compose file', async () => {
    const home = await proxyHome();
    const paths = await ensureProxyScaffold(home);

    expect(paths).toEqual(proxyPaths(home));
    const compose = parse(await readFile(paths.composeFile, 'utf8'));
    expect(compose.services.traefik.image).toBe('traefik:v3');
  });

  it('is idempotent, and refreshes the compose file on every run', async () => {
    const home = await proxyHome();
    const paths = await ensureProxyScaffold(home);
    await writeFile(paths.composeFile, 'services: {}\n', 'utf8');

    await ensureProxyScaffold(home);
    expect(await readFile(paths.composeFile, 'utf8')).toContain('traefik');
  });
});

describe('route registration', () => {
  it('treats the route file as the enabled flag', async () => {
    const home = await proxyHome();
    await ensureProxyScaffold(home);

    expect(await isDomainEnabled('shop', home)).toBe(false);

    await writeRoute({
      projectName: 'shop',
      hostnames: ['shop.localhost'],
      targetPort: 3333,
      tls: false,
      home,
    });
    expect(await isDomainEnabled('shop', home)).toBe(true);

    expect(await removeRoute('shop', home)).toBe(true);
    expect(await isDomainEnabled('shop', home)).toBe(false);
  });

  it('rewrites the route in place when the port moves', async () => {
    const home = await proxyHome();
    const paths = await ensureProxyScaffold(home);
    const route = { projectName: 'shop', hostnames: ['shop.localhost'], tls: false, home };

    await writeRoute({ ...route, targetPort: 3333 });
    await writeRoute({ ...route, targetPort: 5835 });

    // The target host follows how the proxy attaches on this platform; the
    // port is what a rewrite has to move.
    const written = parse(await readFile(routeConfigPath(paths.confDir, 'shop'), 'utf8'));
    expect(written.http.services.shop.loadBalancer.servers).toEqual([
      { url: `http://${proxyTargetHost(usesHostNetwork())}:5835` },
    ]);
  });

  it('reports a route that was never registered', async () => {
    const home = await proxyHome();
    await ensureProxyScaffold(home);
    expect(await removeRoute('never-enabled', home)).toBe(false);
  });
});

describe('refreshTlsConfig', () => {
  it('lists the certificates present on disk', async () => {
    const home = await proxyHome();
    const paths = await ensureProxyScaffold(home);
    await writeFile(join(paths.certsDir, 'shop.pem'), 'cert', 'utf8');
    await writeFile(join(paths.certsDir, 'shop.key'), 'key', 'utf8');

    const certs = await refreshTlsConfig(home);
    expect(certs).toHaveLength(1);

    const config = parse(await readFile(join(paths.confDir, 'tls.yml'), 'utf8'));
    expect(config.tls.certificates).toEqual([
      { certFile: '/etc/traefik/certs/shop.pem', keyFile: '/etc/traefik/certs/shop-key.pem' },
    ]);
  });

  it('writes an empty config when no certificate was issued', async () => {
    const home = await proxyHome();
    const paths = await ensureProxyScaffold(home);

    await expect(refreshTlsConfig(home)).resolves.toEqual([]);
    expect(await readFile(join(paths.confDir, 'tls.yml'), 'utf8')).toBeTruthy();
    expect(await hasIssuedCert(paths.certsDir, 'shop')).toBe(false);
  });
});

describe('resolveDomainHostnames', () => {
  it('falls back to the project name', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-app-'));
    await expect(resolveDomainHostnames(appRoot, 'shop-feature-login')).resolves.toEqual([
      'shop-feature-login.localhost',
      'shop-feature-login.test',
    ]);
  });

  it('lets the repo pin the hostname through SAIL_DOMAIN', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-app-'));
    await writeFile(join(appRoot, '.env'), 'PORT=3333\nSAIL_DOMAIN=shop.test\n', 'utf8');

    await expect(resolveDomainHostnames(appRoot, 'shop')).resolves.toEqual(['shop.test']);
  });

  it('prefers .env.local, and ignores quotes and an empty value', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-app-'));
    const dev = { nodeEnv: 'development' };
    await writeFile(join(appRoot, '.env'), 'SAIL_DOMAIN=committed.test\n', 'utf8');
    await writeFile(join(appRoot, '.env.local'), 'SAIL_DOMAIN="mine.test"\n', 'utf8');
    await expect(resolveDomainHostnames(appRoot, 'shop', dev)).resolves.toEqual(['mine.test']);

    await writeFile(join(appRoot, '.env.local'), 'SAIL_DOMAIN=\n', 'utf8');
    await expect(resolveDomainHostnames(appRoot, 'shop', dev)).resolves.toEqual(['committed.test']);
  });

  it('walks the same dot-env priority the app port does', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-app-'));
    await writeFile(join(appRoot, '.env'), 'SAIL_DOMAIN=committed.test\n', 'utf8');
    await writeFile(join(appRoot, '.env.local'), 'SAIL_DOMAIN=mine.test\n', 'utf8');
    await writeFile(join(appRoot, '.env.test'), 'SAIL_DOMAIN=suite.test\n', 'utf8');

    // Under NODE_ENV=test the Adonis loader skips .env.local, so the domain
    // has to skip it too — otherwise it disagrees with the port it routes to.
    await expect(resolveDomainHostnames(appRoot, 'shop', { nodeEnv: 'test' })).resolves.toEqual([
      'suite.test',
    ]);
  });

  it('drops a pinned value that could never be matched', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'sail-app-'));
    const dev = { nodeEnv: 'development' };

    await writeFile(join(appRoot, '.env'), 'SAIL_DOMAIN=https://Shop.Test:3333/app\n', 'utf8');
    await expect(resolveDomainHostnames(appRoot, 'shop', dev)).resolves.toEqual(['shop.test']);

    await writeFile(join(appRoot, '.env'), 'SAIL_DOMAIN=not a hostname\n', 'utf8');
    await expect(resolveDomainHostnames(appRoot, 'shop', dev)).resolves.toEqual([
      'shop.localhost',
      'shop.test',
    ]);
  });
});

describe('proxyContext', () => {
  it('targets the shared project, outside the per-worktree model', () => {
    const context = proxyContext(proxyPaths('/home/dev/.sail'));

    expect(context.projectName).toBe(PROXY_PROJECT_NAME);
    expect(context.worktree).toBeNull();
    expect(context.portOffset).toBe(0);
    expect(context.composeFilePath).toBe('/home/dev/.sail/proxy/compose.yml');
  });
});
