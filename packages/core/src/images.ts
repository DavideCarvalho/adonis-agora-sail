import type { SailConfig } from './sail_config.js';
import { SERVICES } from './services.js';
import type { SailServiceName } from './types.js';

/**
 * `postgres:17`, `docker.io/library/postgres:16-alpine` … → the major version.
 * Null for anything that is not the official image with a numeric tag.
 */
export function officialPostgresMajor(image: string): string | null {
  return /^(?:docker\.io\/)?(?:library\/)?postgres:(\d+)/.exec(image)?.[1] ?? null;
}

/** Whether an image already ships pgvector (the official pgvector image or a fork of it). */
export function isPgvectorImage(image: string): boolean {
  return /pgvector/i.test(image);
}

/**
 * The pgvector image matching a Postgres major: `pgvector/pgvector:pg17` is
 * `postgres:17` plus the extension, same data directory layout, so the swap
 * keeps an existing volume readable.
 */
export function pgvectorImageFor(major: string): string {
  return `pgvector/pgvector:pg${major}`;
}

/**
 * The images newly generated services run: `package.json#sail.images` over
 * the catalog, and — when a migration creates the `vector` extension — the
 * pgvector build of the same Postgres major. An explicit non-official image
 * (a custom build, an already-pgvector one) is left exactly as configured.
 */
export function resolveServiceImages(
  config: Pick<SailConfig, 'images'>,
  pgvector: boolean,
): Partial<Record<SailServiceName, string>> {
  const images: Partial<Record<SailServiceName, string>> = { ...config.images };
  if (pgvector) {
    const postgres = images.postgres ?? SERVICES.postgres.image;
    const major = officialPostgresMajor(postgres);
    if (major && !isPgvectorImage(postgres)) {
      images.postgres = pgvectorImageFor(major);
    }
  }
  return images;
}
