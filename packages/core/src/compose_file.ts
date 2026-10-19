import { parseDocument, stringify } from 'yaml';

import { SERVICES } from './services.js';
import type { SailServiceDefinition, SailServiceName } from './types.js';

const HEADER = [
  '# Managed by @adonis-agora/sail (`node ace sail:install`).',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the `${VAR:-default}` here documents compose interpolation syntax, it is not a placeholder
  '# Host ports interpolate `${VAR:-default}`: sail injects per-worktree ports at',
  '# runtime, and a bare `docker compose up` falls back to the defaults. Hand',
  '# edits are preserved — sail only ever appends missing services.',
  '',
].join('\n');

/**
 * Per-run choices for generated fragments. Only newly added services are
 * affected — an existing service block is never rewritten.
 */
export interface ComposeOptions {
  /** Image per service, overriding the catalog's (`postgres` → `pgvector/pgvector:pg17`). */
  images?: Partial<Record<SailServiceName, string>>;
}

/**
 * Builds the compose fragment for one service as a plain object.
 */
function serviceFragment(
  service: SailServiceDefinition,
  options: ComposeOptions,
): Record<string, unknown> {
  const fragment: Record<string, unknown> = {
    image: options.images?.[service.name] ?? service.image,
    ports: service.ports.map(
      (port) => `\${${port.envVar}:-${port.basePort}}:${port.containerPort}`,
    ),
  };

  if (service.command) {
    fragment.command = service.command;
  }

  if (Object.keys(service.environment).length > 0) {
    fragment.environment = service.environment;
  }

  if (service.configs && service.configs.length > 0) {
    fragment.configs = service.configs.map((config) => ({
      source: config.name,
      target: config.target,
    }));
  }

  if (service.volumes.length > 0) {
    fragment.volumes = service.volumes;
  }

  if (service.healthcheck) {
    fragment.healthcheck = service.healthcheck;
  }

  return fragment;
}

/**
 * Generates a fresh compose file for the given services.
 */
export function generateComposeFile(
  services: SailServiceName[],
  options: ComposeOptions = {},
): string {
  const fragments: Record<string, unknown> = {};
  const volumes: Record<string, null> = {};
  const configs: Record<string, { content: string }> = {};

  for (const name of services) {
    const service = SERVICES[name];
    fragments[name] = serviceFragment(service, options);
    for (const volume of service.volumes) {
      const volumeName = volume.split(':')[0];
      if (volumeName) {
        volumes[volumeName] = null;
      }
    }
    for (const config of service.configs ?? []) {
      configs[config.name] = { content: config.content };
    }
  }

  const document: Record<string, unknown> = { services: fragments };
  if (Object.keys(volumes).length > 0) {
    document.volumes = volumes;
  }
  if (Object.keys(configs).length > 0) {
    document.configs = configs;
  }

  return HEADER + stringify(document, { lineWidth: 100 });
}

/**
 * Appends the selected services that are missing from an existing compose
 * file, leaving everything the user already has (including hand edits to
 * existing services) untouched. Returns the updated content and the names
 * that were actually added.
 */
export function mergeComposeFile(
  existingContent: string,
  services: SailServiceName[],
  options: ComposeOptions = {},
): { content: string; added: SailServiceName[] } {
  const document = parseDocument(existingContent);
  const added: SailServiceName[] = [];

  for (const name of services) {
    if (document.hasIn(['services', name])) {
      continue;
    }

    const service = SERVICES[name];
    document.setIn(['services', name], serviceFragment(service, options));
    for (const volume of service.volumes) {
      const volumeName = volume.split(':')[0];
      if (volumeName && !document.hasIn(['volumes', volumeName])) {
        document.setIn(['volumes', volumeName], null);
      }
    }
    for (const config of service.configs ?? []) {
      if (!document.hasIn(['configs', config.name])) {
        document.setIn(['configs', config.name], { content: config.content });
      }
    }
    added.push(name);
  }

  return { content: document.toString({ lineWidth: 100 }), added };
}

/**
 * Lists the sail-known services present in an existing compose file.
 */
export function servicesInComposeFile(existingContent: string): SailServiceName[] {
  const document = parseDocument(existingContent);
  return (Object.keys(SERVICES) as SailServiceName[]).filter((name) =>
    document.hasIn(['services', name]),
  );
}

/**
 * The image a service runs in an existing compose file, or null when the
 * service (or its `image:`) is not there.
 */
export function serviceImageInComposeFile(
  existingContent: string,
  name: SailServiceName,
): string | null {
  const image = parseDocument(existingContent).getIn(['services', name, 'image']);
  return typeof image === 'string' ? image : null;
}
