import { parseDocument, stringify } from 'yaml';

import { SERVICE_COMMANDS, SERVICES } from './services.js';
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
 * Builds the compose fragment for one service as a plain object.
 */
function serviceFragment(service: SailServiceDefinition): Record<string, unknown> {
  const fragment: Record<string, unknown> = {
    image: service.image,
    ports: service.ports.map(
      (port) => `\${${port.envVar}:-${port.basePort}}:${port.containerPort}`,
    ),
  };

  const command = SERVICE_COMMANDS[service.name];
  if (command) {
    fragment.command = command;
  }

  if (Object.keys(service.environment).length > 0) {
    fragment.environment = service.environment;
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
export function generateComposeFile(services: SailServiceName[]): string {
  const fragments: Record<string, unknown> = {};
  const volumes: Record<string, null> = {};

  for (const name of services) {
    const service = SERVICES[name];
    fragments[name] = serviceFragment(service);
    for (const volume of service.volumes) {
      const volumeName = volume.split(':')[0];
      if (volumeName) {
        volumes[volumeName] = null;
      }
    }
  }

  const document: Record<string, unknown> = { services: fragments };
  if (Object.keys(volumes).length > 0) {
    document['volumes'] = volumes;
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
): { content: string; added: SailServiceName[] } {
  const document = parseDocument(existingContent);
  const added: SailServiceName[] = [];

  for (const name of services) {
    if (document.hasIn(['services', name])) {
      continue;
    }

    const service = SERVICES[name];
    document.setIn(['services', name], serviceFragment(service));
    for (const volume of service.volumes) {
      const volumeName = volume.split(':')[0];
      if (volumeName && !document.hasIn(['volumes', volumeName])) {
        document.setIn(['volumes', volumeName], null);
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
