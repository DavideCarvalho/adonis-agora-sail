import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVICE_NAMES, SERVICES } from './services.js';
import type { SailServiceName } from './types.js';

/**
 * Picks the services implied by a dependency map (dependencies +
 * devDependencies of the app). Postgres and MySQL are mutually exclusive:
 * when both drivers are present, postgres wins and mysql must be asked for
 * explicitly.
 */
export function detectServicesFromDependencies(
  dependencies: Record<string, string>,
): SailServiceName[] {
  const detected = SERVICE_NAMES.filter((name) =>
    SERVICES[name].detectedBy.some((dependency) => dependency in dependencies),
  );

  if (detected.includes('postgres') && detected.includes('mysql')) {
    return detected.filter((name) => name !== 'mysql');
  }

  return detected;
}

/**
 * Reads the app's package.json and detects which services it likely needs.
 * Returns an empty list when there is no package.json or nothing matches.
 */
export async function detectServices(appRoot: URL): Promise<SailServiceName[]> {
  try {
    const raw = await readFile(join(fileURLToPath(appRoot), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return detectServicesFromDependencies({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    });
  } catch {
    return [];
  }
}
