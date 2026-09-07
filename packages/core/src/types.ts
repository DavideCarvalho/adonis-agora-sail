import type { GitWorktree } from '@poppinss/utils';

/**
 * Names of the services sail knows how to run.
 */
export type SailServiceName = 'postgres' | 'mysql' | 'redis' | 'mailpit' | 'minio';

/**
 * A host port a service publishes. The compose file interpolates
 * `${envVar:-basePort}` so the same committed file works in every worktree:
 * sail injects `envVar = basePort + worktree offset` at runtime, and plain
 * `docker compose up` (no sail, no worktree) falls back to the base port.
 */
export interface SailPortDefinition {
  /** Environment variable that overrides the host port, e.g. `SAIL_POSTGRES_PORT`. */
  envVar: string;
  /** Default host port, used as-is in the main checkout (offset 0). */
  basePort: number;
  /** Port inside the container. */
  containerPort: number;
  /** Human label shown by `sail:info`, e.g. `smtp` or `console`. */
  label: string;
}

/**
 * Static definition of a runnable service: its compose fragment plus the
 * metadata sail needs for detection, port planning and `sail:info` output.
 */
export interface SailServiceDefinition {
  name: SailServiceName;
  summary: string;
  image: string;
  ports: SailPortDefinition[];
  /** Environment for the container itself. */
  environment: Record<string, string>;
  /** Named volumes as `volume-name:/container/path`. */
  volumes: string[];
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
  /**
   * Dependencies in the app's package.json that imply this service is wanted.
   * Any match selects the service during auto-detection.
   */
  detectedBy: string[];
  /**
   * Env vars the *app* should use to reach the service, given the resolved
   * host ports (keyed by port label). Shown by `sail:info --env`.
   */
  appEnv: (ports: Record<string, number>) => Record<string, string>;
  /** Browser dashboards the service exposes, given the resolved host ports. */
  dashboards: (ports: Record<string, number>) => { label: string; url: string }[];
}

/**
 * Everything sail resolves about the current checkout before touching docker:
 * which worktree it is in, the compose project to target and the port offset.
 */
export interface SailContext {
  /** App name derived from package.json, sanitized for compose. */
  appName: string;
  /** Compose project name: `appName` or `appName-<worktree slug>`. */
  projectName: string;
  /** The linked git worktree, or null in the main checkout / non-git dirs. */
  worktree: GitWorktree | null;
  /** Deterministic port offset applied to every service (0 in the main checkout). */
  portOffset: number;
  /** Absolute path to the compose file sail manages. */
  composeFilePath: string;
}

/**
 * One row of `sail:ps` / `sail:up` output.
 */
export interface SailServiceStatus {
  name: string;
  state: string;
  health: string;
  publishers: { hostPort: number; containerPort: number }[];
}
