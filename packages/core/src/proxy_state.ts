import { lookup } from 'node:dns/promises';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildTlsConfig, type CertPaths, certPaths } from './certs.js';
import { DOTENV_FILE_NAME } from './dotenv.js';
import {
  buildRouteConfig,
  CERTS_MOUNT,
  generateProxyComposeFile,
  hostnamesFor,
  PROXY_PROJECT_NAME,
  type ProxyPaths,
  proxyPaths,
  routeConfigPath,
} from './proxy.js';
import type { SailContext } from './types.js';
import { LOCAL_ENV_FILE_NAME } from './varlock.js';

/** Name of the aggregated TLS config Traefik picks up from the conf dir. */
export const TLS_CONFIG_FILE_NAME = 'tls.yml';

/**
 * Creates `~/.sail/proxy` and refreshes the proxy's compose file. Writing the
 * compose file on every call is deliberate: an app that upgrades sail brings
 * the shared proxy along with it, without a separate migration step.
 */
export async function ensureProxyScaffold(home?: string): Promise<ProxyPaths> {
  const paths = proxyPaths(home);
  await mkdir(paths.confDir, { recursive: true });
  await mkdir(paths.certsDir, { recursive: true });
  await writeFile(paths.composeFile, generateProxyComposeFile(), 'utf8');
  return paths;
}

/**
 * True when this project has a route registered — which is also how sail
 * remembers that domains are enabled here. There is no config file to keep in
 * sync: the route's existence *is* the setting, so enabling and disabling are
 * a single filesystem operation each.
 */
export async function isDomainEnabled(projectName: string, home?: string): Promise<boolean> {
  try {
    await readFile(routeConfigPath(proxyPaths(home).confDir, projectName), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes (or refreshes) this project's route. Traefik's file provider reloads
 * on its own, so a port that moved — a renamed worktree, a changed `PORT` —
 * takes effect without restarting the proxy or dropping other apps' routes.
 */
export async function writeRoute(options: {
  projectName: string;
  hostnames: string[];
  targetPort: number;
  tls: boolean;
  home?: string | undefined;
}): Promise<string> {
  const paths = proxyPaths(options.home);
  const path = routeConfigPath(paths.confDir, options.projectName);
  await writeFile(
    path,
    buildRouteConfig({
      projectName: options.projectName,
      hostnames: options.hostnames,
      targetPort: options.targetPort,
      tls: options.tls,
    }),
    'utf8',
  );
  return path;
}

/**
 * Removes this project's route. Certificates are left behind on purpose:
 * re-enabling later reuses them, and a stale cert for a domain nothing routes
 * to is inert.
 */
export async function removeRoute(projectName: string, home?: string): Promise<boolean> {
  const path = routeConfigPath(proxyPaths(home).confDir, projectName);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites the aggregated TLS config from the certificates on disk, so a
 * project that was just issued a cert starts serving HTTPS and one whose cert
 * was removed stops being advertised.
 */
export async function refreshTlsConfig(home?: string): Promise<CertPaths[]> {
  const paths = proxyPaths(home);
  let entries: string[];
  try {
    entries = await readdir(paths.certsDir);
  } catch {
    entries = [];
  }

  // Traefik resolves these paths inside the container, so the config names the
  // mount point — writing the host path here produces a proxy that starts
  // clean and then serves a self-signed default certificate instead.
  const certs = entries
    .filter((entry) => entry.endsWith('.pem') && !entry.endsWith('-key.pem'))
    .map((entry) => certPaths(CERTS_MOUNT, entry.slice(0, -'.pem'.length)));

  await writeFile(join(paths.confDir, TLS_CONFIG_FILE_NAME), buildTlsConfig(certs), 'utf8');
  return certs;
}

/**
 * Whether a certificate was issued for this project. Sail serves HTTPS only
 * when one exists, so a machine without mkcert degrades to plain HTTP instead
 * of advertising a scheme nothing can complete.
 */
export async function hasIssuedCert(certsDir: string, projectName: string): Promise<boolean> {
  try {
    await access(certPaths(certsDir, projectName).certFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the system resolver answers for a hostname — which is not the same
 * question as whether a browser will load it.
 *
 * Chrome, Edge and Firefox short-circuit `*.localhost` internally, so they
 * work regardless. Everything else (curl, Node, a database GUI) goes through
 * nsswitch, and a Linux box whose `hosts:` line lacks the `resolve` module
 * never asks systemd-resolved — which is exactly where its `*.localhost`
 * synthesis lives. Same practical outcome as macOS, which does not synthesize
 * `*.localhost` at all: the browser works and the terminal does not.
 */
export async function resolvesLocally(hostname: string): Promise<boolean> {
  try {
    const { address } = await lookup(hostname);
    return address === '127.0.0.1' || address === '::1';
  } catch {
    return false;
  }
}

/** Dotenv key letting a team pin the app's hostname in the repo. */
export const DOMAIN_ENV_KEY = 'SAIL_DOMAIN';

/**
 * The hostnames this app answers on. `SAIL_DOMAIN` in `.env.local` or `.env`
 * wins when set, so a team can commit *which* domain the app uses while each
 * developer still decides *whether* to run the proxy at all; otherwise the
 * compose project name drives the default `<project>.localhost` /
 * `<project>.test` pair.
 */
export async function resolveDomainHostnames(
  appRootPath: string,
  projectName: string,
): Promise<string[]> {
  for (const file of [LOCAL_ENV_FILE_NAME, DOTENV_FILE_NAME]) {
    try {
      const content = await readFile(join(appRootPath, file), 'utf8');
      const match = content.match(
        new RegExp(`^\\s*(?:export\\s+)?${DOMAIN_ENV_KEY}\\s*=\\s*(.+?)\\s*$`, 'm'),
      );
      const value = match?.[1]?.replace(/^['"]|['"]$/g, '').trim();
      if (value) {
        return [value];
      }
    } catch {
      // missing file — next candidate
    }
  }
  return hostnamesFor(projectName);
}

/**
 * A {@link SailContext} pointing at the shared proxy stack, so the regular
 * `DockerCompose` runner can drive it. The proxy is deliberately outside the
 * per-worktree model — port 80 only fits once per machine — so it carries no
 * worktree and no port offset.
 */
export function proxyContext(paths: ProxyPaths): SailContext {
  return {
    appName: PROXY_PROJECT_NAME,
    projectName: PROXY_PROJECT_NAME,
    worktree: null,
    portOffset: 0,
    composeFilePath: paths.composeFile,
  };
}
