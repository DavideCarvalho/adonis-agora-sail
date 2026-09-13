import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  buildRouteConfig,
  DEFAULT_DOMAIN_SUFFIXES,
  generateProxyComposeFile,
  hostnamesFor,
  listRegisteredProjects,
  PROXY_PROJECT_NAME,
  proxyPaths,
  routeConfigPath,
  sailHomeDir,
} from '../src/proxy.js';

function parseProxyCompose(hostNetwork = false): any {
  return parse(generateProxyComposeFile({ hostNetwork }));
}

function parseRoute(options: {
  hostNetwork?: boolean;
  projectName?: string;
  hostnames?: string[];
  targetPort?: number;
  tls?: boolean;
}): any {
  return parse(
    buildRouteConfig({
      projectName: options.projectName ?? 'shop',
      hostnames: options.hostnames ?? ['shop.localhost', 'shop.test'],
      targetPort: options.targetPort ?? 3333,
      tls: options.tls ?? false,
      hostNetwork: options.hostNetwork ?? false,
    }),
  );
}

/** Turns a Traefik v3 rule back into the regexps it is built from. */
function ruleRegexps(rule: string): RegExp[] {
  return [...rule.matchAll(/HostRegexp\(`([^`]+)`\)/g)].map((match) => new RegExp(match[1]!));
}

function ruleMatches(rule: string, host: string): boolean {
  return ruleRegexps(rule).some((regexp) => regexp.test(host));
}

describe('generateProxyComposeFile', () => {
  it('emits the managed-file header', () => {
    expect(generateProxyComposeFile().split('\n')[0]).toMatch(/Managed by @adonis-agora\/sail/);
  });

  it('runs traefik v3 on the http and https ports', () => {
    const traefik = parseProxyCompose().services.traefik;
    expect(traefik.image).toBe('traefik:v3');
    expect(traefik.ports).toEqual(['80:80', '443:443']);
  });

  it('quotes the port mappings, which yaml 1.1 would otherwise read as base-60', () => {
    expect(generateProxyComposeFile({ hostNetwork: false })).toContain("- '80:80'");
    expect(generateProxyComposeFile({ hostNetwork: false })).toContain("- '443:443'");
  });

  it('joins the host network on linux, where the bridge hits the host firewall', () => {
    const traefik = parseProxyCompose(true).services.traefik;
    expect(traefik.network_mode).toBe('host');
    // Both are meaningless under host networking, and `ports` would warn.
    expect(traefik.ports).toBeUndefined();
    expect(traefik.extra_hosts).toBeUndefined();
  });

  it('survives a docker restart', () => {
    expect(parseProxyCompose().services.traefik.restart).toBe('unless-stopped');
  });

  it('configures traefik entirely through CLI flags', () => {
    const command: string[] = parseProxyCompose().services.traefik.command;
    expect(command).toContain('--entrypoints.web.address=:80');
    expect(command).toContain('--entrypoints.websecure.address=:443');
    expect(command).toContain('--providers.file.directory=/etc/traefik/conf');
    expect(command).toContain('--providers.file.watch=true');
  });

  it('mounts the conf and certs dirs next to the compose file', () => {
    const traefik = parseProxyCompose().services.traefik;
    expect(traefik.volumes).toEqual(['./conf:/etc/traefik/conf', './certs:/etc/traefik/certs:ro']);
  });

  it('maps host.docker.internal to the host gateway off the bridge', () => {
    expect(parseProxyCompose().services.traefik.extra_hosts).toEqual([
      'host.docker.internal:host-gateway',
    ]);
  });
});

describe('hostnamesFor', () => {
  it('expands a project name over the default suffixes', () => {
    expect(hostnamesFor('shop-feature-login')).toEqual([
      'shop-feature-login.localhost',
      'shop-feature-login.test',
    ]);
    expect(DEFAULT_DOMAIN_SUFFIXES).toEqual(['localhost', 'test']);
  });

  it('accepts custom suffixes', () => {
    expect(hostnamesFor('shop', ['dev'])).toEqual(['shop.dev']);
    expect(hostnamesFor('shop', [])).toEqual([]);
  });
});

describe('buildRouteConfig', () => {
  it('points the service at the app running on the host', () => {
    const config = parseRoute({ targetPort: 5835 });
    expect(config.http.services.shop.loadBalancer.servers).toEqual([
      { url: 'http://host.docker.internal:5835' },
    ]);
  });

  it('targets loopback when the proxy shares the host network', () => {
    const config = parseRoute({ targetPort: 5835, hostNetwork: true });
    expect(config.http.services.shop.loadBalancer.servers).toEqual([
      { url: 'http://127.0.0.1:5835' },
    ]);
  });

  it('matches every hostname and any subdomain of it', () => {
    const rule: string = parseRoute({}).http.routers.shop.rule;

    expect(ruleMatches(rule, 'shop.localhost')).toBe(true);
    expect(ruleMatches(rule, 'shop.test')).toBe(true);
    expect(ruleMatches(rule, 'tenant1.shop.localhost')).toBe(true);
    expect(ruleMatches(rule, 'a.b.shop.test')).toBe(true);

    expect(ruleMatches(rule, 'shop.example.com')).toBe(false);
    expect(ruleMatches(rule, 'notshop.localhost')).toBe(false);
    expect(ruleMatches(rule, 'shop.localhost.evil.com')).toBe(false);
  });

  it('escapes the dots so they cannot act as regexp wildcards', () => {
    const rule: string = parseRoute({}).http.routers.shop.rule;
    expect(rule).toContain('HostRegexp(`^(?:.+\\.)?shop\\.localhost$`)');
    expect(ruleMatches(rule, 'shopXlocalhost')).toBe(false);
  });

  it('is web-only without tls', () => {
    const routers = parseRoute({ tls: false }).http.routers;
    expect(Object.keys(routers)).toEqual(['shop']);
    expect(routers.shop.entryPoints).toEqual(['web']);
    expect(routers.shop.tls).toBeUndefined();
  });

  it('adds a websecure router with tls, keeping plain http working', () => {
    const routers = parseRoute({ tls: true }).http.routers;
    expect(Object.keys(routers).sort()).toEqual(['shop', 'shop-secure']);
    expect(routers.shop.entryPoints).toEqual(['web']);
    expect(routers.shop.tls).toBeUndefined();
    expect(routers['shop-secure'].entryPoints).toEqual(['websecure']);
    expect(routers['shop-secure'].tls).toEqual({});
    expect(routers['shop-secure'].rule).toBe(routers.shop.rule);
    expect(routers['shop-secure'].service).toBe('shop');
  });

  it('names routers and services after the project so worktrees never collide', () => {
    const config = parseRoute({ projectName: 'shop-feature-login' });
    expect(Object.keys(config.http.routers)).toEqual(['shop-feature-login']);
    expect(config.http.routers['shop-feature-login'].service).toBe('shop-feature-login');
    expect(Object.keys(config.http.services)).toEqual(['shop-feature-login']);
  });

  it('keeps the rule on a single line', () => {
    const content = buildRouteConfig({
      projectName: 'a-rather-long-project-name-from-a-worktree',
      hostnames: hostnamesFor('a-rather-long-project-name-from-a-worktree'),
      targetPort: 3333,
      tls: true,
    });
    expect(content.split('\n').some((line) => line.trimStart().startsWith('rule:'))).toBe(true);
    expect(
      parse(content).http.routers['a-rather-long-project-name-from-a-worktree'].rule,
    ).toContain('||');
  });
});

describe('sailHomeDir', () => {
  it('defaults to ~/.sail', () => {
    expect(sailHomeDir({})).toBe(join(homedir(), '.sail'));
  });

  it('honours $SAIL_HOME', () => {
    expect(sailHomeDir({ SAIL_HOME: '/tmp/sail-home' })).toBe('/tmp/sail-home');
  });

  it('ignores a blank $SAIL_HOME', () => {
    expect(sailHomeDir({ SAIL_HOME: '  ' })).toBe(join(homedir(), '.sail'));
  });
});

describe('proxyPaths', () => {
  it('lays the proxy state out under <home>/proxy', () => {
    expect(proxyPaths('/home/dev/.sail')).toEqual({
      root: '/home/dev/.sail/proxy',
      composeFile: '/home/dev/.sail/proxy/compose.yml',
      confDir: '/home/dev/.sail/proxy/conf',
      certsDir: '/home/dev/.sail/proxy/certs',
    });
  });

  it('mounts the dirs the compose file expects to find beside it', () => {
    const paths = proxyPaths('/home/dev/.sail');
    expect(paths.confDir).toBe(join(paths.root, 'conf'));
    expect(paths.certsDir).toBe(join(paths.root, 'certs'));
  });
});

describe('routeConfigPath', () => {
  it('gives each project its own file in the conf dir', () => {
    expect(routeConfigPath('/conf', 'shop')).toBe('/conf/route-shop.yml');
    expect(routeConfigPath('/conf', 'shop-feature-login')).toBe(
      '/conf/route-shop-feature-login.yml',
    );
  });
});

describe('listRegisteredProjects', () => {
  it('returns nothing when the conf dir does not exist', async () => {
    expect(await listRegisteredProjects('/nope/does/not/exist')).toEqual([]);
  });

  it('reads the registered projects back, sorted, ignoring other files', async () => {
    const confDir = await mkdtemp(join(tmpdir(), 'sail-proxy-conf-'));
    await writeFile(
      routeConfigPath(confDir, 'shop'),
      buildRouteConfig({
        projectName: 'shop',
        hostnames: hostnamesFor('shop'),
        targetPort: 3333,
        tls: false,
      }),
    );
    await writeFile(routeConfigPath(confDir, 'blog-feature-x'), 'http: {}');
    await writeFile(join(confDir, 'tls.yml'), 'tls: {}');
    await writeFile(join(confDir, 'README.md'), '');

    expect(await listRegisteredProjects(confDir)).toEqual(['blog-feature-x', 'shop']);
  });
});

describe('PROXY_PROJECT_NAME', () => {
  it('is the single shared compose project', () => {
    expect(PROXY_PROJECT_NAME).toBe('sail-proxy');
  });
});
