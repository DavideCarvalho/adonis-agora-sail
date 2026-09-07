import { readFile } from 'node:fs/promises';

import { type AppScan, scanAppConfig } from './app_scan.js';
import { servicesInComposeFile } from './compose_file.js';
import { resolveSailContext } from './context.js';
import { resolveHostPorts } from './ports.js';
import { SERVICES } from './services.js';
import type { SailContext, SailServiceName } from './types.js';

export interface SailServiceInfo {
  name: SailServiceName;
  summary: string;
  ports: { label: string; envVar: string; hostPort: number; containerPort: number }[];
  dashboards: { label: string; url: string }[];
  appEnv: Record<string, string>;
}

export interface SailStackInfo {
  appName: string;
  projectName: string;
  worktree: { name: string; slug: string; path: string } | null;
  portOffset: number;
  composeFilePath: string;
  services: SailServiceInfo[];
  /** Union of every service's suggested app env, offset applied. */
  appEnv: Record<string, string>;
}

/**
 * Computes everything `sail:info` (and the post-`sail:up` summary) shows for
 * a stack: per-service host ports with the worktree offset applied, dashboard
 * URLs and the env vars the app should use to reach each service.
 */
export function buildStackInfo(context: SailContext, services: SailServiceName[]): SailStackInfo {
  const serviceInfos: SailServiceInfo[] = services.map((name) => {
    const service = SERVICES[name];
    const hostPorts = resolveHostPorts(service.ports, context.portOffset);
    return {
      name,
      summary: service.summary,
      ports: service.ports.map((port) => ({
        label: port.label,
        envVar: port.envVar,
        hostPort: hostPorts[port.envVar] ?? port.basePort,
        containerPort: port.containerPort,
      })),
      dashboards: service.dashboards(hostPorts),
      appEnv: service.appEnv(hostPorts),
    };
  });

  const appEnv: Record<string, string> = {};
  for (const serviceInfo of serviceInfos) {
    Object.assign(appEnv, serviceInfo.appEnv);
  }

  return {
    appName: context.appName,
    projectName: context.projectName,
    worktree: context.worktree
      ? { name: context.worktree.name, slug: context.worktree.slug, path: context.worktree.path }
      : null,
    portOffset: context.portOffset,
    composeFilePath: context.composeFilePath,
    services: serviceInfos,
    appEnv,
  };
}

/**
 * Resolves the full stack description for an app root: the worktree-aware
 * context, the app scan (`start/env.ts` + `config/*.ts` + dependencies) and
 * the services enabled in the managed compose file. When the compose file
 * does not exist yet (fresh checkout, pre-install), it falls back to the
 * scan so `sail:info` can preview what `sail:install` would create.
 */
export async function resolveStackInfo(appRoot: URL): Promise<{
  context: SailContext;
  services: SailServiceName[];
  scan: AppScan;
  info: SailStackInfo;
}> {
  const [context, scan] = await Promise.all([resolveSailContext(appRoot), scanAppConfig(appRoot)]);

  let services: SailServiceName[] = [];
  try {
    services = servicesInComposeFile(await readFile(context.composeFilePath, 'utf8'));
  } catch {
    services = scan.services;
  }

  return { context, services, scan, info: buildStackInfo(context, services) };
}

/**
 * Renders a {@link SailStackInfo} as plain human-readable text: one section
 * per service with its host ports and dashboards, plus the union app env.
 * Plain text on purpose — no ANSI, no spinners — so the output stays useful
 * when piped, and agents just use `--json` instead.
 */
export function formatStackInfo(info: SailStackInfo): string {
  const lines: string[] = [];
  const where = info.worktree
    ? `worktree "${info.worktree.name}" (port offset +${info.portOffset})`
    : 'main checkout (default ports)';

  lines.push(`Sail stack "${info.projectName}" — ${where}`);
  lines.push(`Compose file: ${info.composeFilePath}`);
  lines.push('');

  if (info.services.length === 0) {
    lines.push('No services enabled. Run "node ace sail:install" first.');
    return lines.join('\n');
  }

  lines.push('SERVICES');
  for (const service of info.services) {
    lines.push(`  ${service.name} — ${service.summary}`);
    for (const port of service.ports) {
      lines.push(`    ${port.label}: localhost:${port.hostPort} -> ${port.containerPort}`);
    }
    for (const dashboard of service.dashboards) {
      lines.push(`    ${dashboard.label}: ${dashboard.url}`);
    }
  }

  lines.push('');
  lines.push('APP ENV (synced to .env.local by sail:up / sail:sync-env)');
  for (const [key, value] of Object.entries(info.appEnv).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`  ${key}=${value}`);
  }

  return lines.join('\n');
}

/**
 * Renders the stack's union app env as `KEY=value` lines, sorted by key.
 * Meant for `eval $(node ace sail:info --env)` — no header, no decoration.
 */
export function formatAppEnv(info: SailStackInfo): string {
  return Object.entries(info.appEnv)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
