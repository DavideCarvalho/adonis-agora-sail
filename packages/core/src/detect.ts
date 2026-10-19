import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_OBJECT_STORAGE,
  OBJECT_STORAGE_DEPENDENCIES,
  SERVICE_NAMES,
  SERVICES,
} from './services.js';
import type { ObjectStorageBackend, SailServiceName } from './types.js';

/**
 * Picks the services implied by a dependency map (dependencies +
 * devDependencies of the app). Postgres and MySQL are mutually exclusive:
 * when both drivers are present, postgres wins and mysql must be asked for
 * explicitly. An object storage dependency selects `objectStorage` (the
 * default backend unless the caller says otherwise).
 */
export function detectServicesFromDependencies(
  dependencies: Record<string, string>,
  objectStorage: ObjectStorageBackend = DEFAULT_OBJECT_STORAGE,
): SailServiceName[] {
  const wantsObjectStorage = OBJECT_STORAGE_DEPENDENCIES.some(
    (dependency) => dependency in dependencies,
  );
  const detected = SERVICE_NAMES.filter(
    (name) =>
      SERVICES[name].detectedBy.some((dependency) => dependency in dependencies) ||
      (name === objectStorage && wantsObjectStorage),
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
