import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Scalar, stringify } from 'yaml';

/**
 * Compose project name of the shared proxy stack. Port 80 only fits once per
 * machine, so every app and every worktree drives this same project instead of
 * running a proxy of its own.
 */
export const PROXY_PROJECT_NAME = 'sail-proxy';

/**
 * Suffixes every project gets by default. `.localhost` resolves to the
 * loopback address in browsers and modern resolvers with no host file entry;
 * `.test` is the IETF-reserved development TLD, kept as a second option for
 * tooling that insists on a "real" domain.
 */
export const DEFAULT_DOMAIN_SUFFIXES: readonly string[] = ['localhost', 'test'];

/**
 * Route files carry a prefix so that reading the conf dir can tell a project's
 * route apart from the other documents that live beside it (the aggregated TLS
 * config, for one) without maintaining an index of what sail wrote.
 */
const ROUTE_FILE_PREFIX = 'route-';
const ROUTE_FILE_SUFFIX = '.yml';

/** Where the conf and certs directories are mounted inside the container. */
const CONF_MOUNT = '/etc/traefik/conf';
/**
 * Where the certs directory is mounted inside the container. Exported because
 * the TLS config Traefik reads has to name paths as *Traefik* sees them, not
 * as the host does.
 */
export const CERTS_MOUNT = '/etc/traefik/certs';

/** Entrypoint names the route files refer to. */
const WEB_ENTRYPOINT = 'web';
const WEBSECURE_ENTRYPOINT = 'websecure';

/**
 * The host, as seen from inside the proxy container. The app itself runs on
 * the host under `node ace serve --hmr`, so every route ultimately leaves
 * Docker again through the gateway declared in `extra_hosts`.
 */
const HOST_GATEWAY_NAME = 'host.docker.internal';

const PROXY_COMPOSE_HEADER = [
  '# Managed by @adonis-agora/sail — shared by every sail app on this machine.',
  '# Rewritten whenever a sail command touches the proxy, so hand edits are lost;',
  '# per-app routing lives in the hot-reloaded files under ./conf instead.',
  '',
].join('\n');

const ROUTE_HEADER = [
  '# Managed by @adonis-agora/sail — one app-worktree, one file.',
  '# Traefik watches this directory and reloads on write: changing a port or a',
  '# hostname here never restarts the proxy or disturbs the other apps.',
  '',
].join('\n');

/**
 * Root of sail's machine-wide state. Everything shared across apps and
 * worktrees — the proxy stack, its routes, its certificates — hangs off here,
 * deliberately outside any repository. `$SAIL_HOME` overrides it, which is
 * what the tests use and what lets a sandbox keep its own proxy.
 */
export function sailHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SAIL_HOME?.trim();
  return override ? resolve(override) : join(homedir(), '.sail');
}

export interface ProxyPaths {
  root: string;
  composeFile: string;
  confDir: string;
  certsDir: string;
}

/**
 * Layout of the proxy's state directory. `conf` and `certs` sit next to the
 * compose file because the compose file mounts them by relative path, which
 * keeps the generated YAML free of absolute, machine-specific paths.
 */
export function proxyPaths(home: string = sailHomeDir()): ProxyPaths {
  const root = join(home, 'proxy');
  return {
    root,
    composeFile: join(root, 'compose.yml'),
    confDir: join(root, 'conf'),
    certsDir: join(root, 'certs'),
  };
}

/**
 * A port mapping that stays a string on the way out. `80:80` left bare is read
 * as a base-60 number by YAML 1.1 parsers, which is the classic way a compose
 * file ends up publishing port 4880.
 */
function portMapping(mapping: string): Scalar<string> {
  const scalar = new Scalar(mapping);
  scalar.type = Scalar.QUOTE_SINGLE;
  return scalar;
}

/**
 * Whether the proxy should join the host's network namespace instead of
 * publishing ports off the bridge.
 *
 * This is a Linux-only answer to a Linux-only problem: from the bridge, the
 * app on the host is only reachable through the docker gateway, and any
 * machine with a default-deny `INPUT` policy (ufw enabled, which is the
 * common case) silently drops that traffic — the route resolves and then
 * times out. Host networking removes the hop entirely: Traefik binds the
 * host's ports and reaches the app on `127.0.0.1`, with nothing for a
 * firewall to block.
 *
 * Docker Desktop is the opposite case: `network_mode: host` does not publish
 * anything on macOS or Windows, while `host.docker.internal` off the bridge
 * works out of the box and no host firewall sits in between.
 */
export function usesHostNetwork(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

/** Where a route sends traffic, given how the proxy is attached to the host. */
export function proxyTargetHost(hostNetwork: boolean): string {
  return hostNetwork ? '127.0.0.1' : HOST_GATEWAY_NAME;
}

/**
 * The singleton proxy stack. Its entire static configuration is passed as CLI
 * flags rather than a `traefik.yml`, so the compose file is the only thing
 * that has to be kept in sync — and the only dynamic configuration is the
 * watched conf dir, which means no file in here ever has to change when an app
 * comes or goes.
 */
export function generateProxyComposeFile(options: { hostNetwork?: boolean } = {}): string {
  const hostNetwork = options.hostNetwork ?? usesHostNetwork();
  const traefik: Record<string, unknown> = {
    image: 'traefik:v3',
    restart: 'unless-stopped',
    command: [
      `--entrypoints.${WEB_ENTRYPOINT}.address=:80`,
      `--entrypoints.${WEBSECURE_ENTRYPOINT}.address=:443`,
      `--providers.file.directory=${CONF_MOUNT}`,
      '--providers.file.watch=true',
      '--global.checknewversion=false',
      '--global.sendanonymoususage=false',
      '--log.level=INFO',
    ],
    volumes: [`./conf:${CONF_MOUNT}`, `./certs:${CERTS_MOUNT}:ro`],
  };

  if (hostNetwork) {
    traefik['network_mode'] = 'host';
  } else {
    traefik['ports'] = [portMapping('80:80'), portMapping('443:443')];
    traefik['extra_hosts'] = [`${HOST_GATEWAY_NAME}:host-gateway`];
  }

  const document = { services: { traefik } };

  return PROXY_COMPOSE_HEADER + stringify(document, { lineWidth: 100 });
}

/**
 * The domains a project answers on: one per suffix.
 */
export function hostnamesFor(
  projectName: string,
  suffixes: readonly string[] = DEFAULT_DOMAIN_SUFFIXES,
): string[] {
  return suffixes.map((suffix) => `${projectName}.${suffix}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A Traefik v3 rule matching each hostname *and* anything below it, so an app
 * doing subdomain multi-tenancy resolves `tenant1.shop.localhost` through the
 * same route as `shop.localhost`. v3 rules take plain Go regexps — v2's
 * `{name:pattern}` named groups are gone — hence the optional leading label
 * instead of a wildcard host.
 */
function hostRule(hostnames: string[]): string {
  return hostnames
    .map((hostname) => `HostRegexp(\`^(?:.+\\.)?${escapeRegExp(hostname)}$\`)`)
    .join(' || ');
}

/**
 * One app-worktree's dynamic configuration.
 *
 * TLS gets a second router rather than a second entrypoint on the first one:
 * a router that declares `tls` stops accepting plain HTTP on whatever
 * entrypoint it is attached to, so serving both schemes means one router per
 * scheme, both pointing at the same service.
 */
export function buildRouteConfig(options: {
  projectName: string;
  hostnames: string[];
  targetPort: number;
  tls: boolean;
  /** Defaults to however the proxy is attached on this platform. */
  hostNetwork?: boolean | undefined;
}): string {
  const targetHost = proxyTargetHost(options.hostNetwork ?? usesHostNetwork());
  const rule = hostRule(options.hostnames);

  const routers: Record<string, unknown> = {
    [options.projectName]: {
      entryPoints: [WEB_ENTRYPOINT],
      rule,
      service: options.projectName,
    },
  };

  if (options.tls) {
    routers[`${options.projectName}-secure`] = {
      entryPoints: [WEBSECURE_ENTRYPOINT],
      rule,
      service: options.projectName,
      tls: {},
    };
  }

  const document = {
    http: {
      routers,
      services: {
        [options.projectName]: {
          loadBalancer: {
            servers: [{ url: `http://${targetHost}:${options.targetPort}` }],
          },
        },
      },
    },
  };

  return ROUTE_HEADER + stringify(document, { lineWidth: 0 });
}

/**
 * Where a project's route lives. The project name is already sanitized into a
 * compose project name upstream, so it is safe as a file name.
 */
export function routeConfigPath(confDir: string, projectName: string): string {
  return join(confDir, `${ROUTE_FILE_PREFIX}${projectName}${ROUTE_FILE_SUFFIX}`);
}

/**
 * The projects currently routed by the proxy, read back from the conf dir —
 * the route files are the registry, so nothing can drift out of sync with
 * them. A missing conf dir simply means nothing is registered yet.
 */
export async function listRegisteredProjects(confDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(confDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.startsWith(ROUTE_FILE_PREFIX) && entry.endsWith(ROUTE_FILE_SUFFIX))
    .map((entry) => entry.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length))
    .filter((name) => name.length > 0)
    .sort();
}
