import { describe, expect, it } from 'vitest';

import { buildSailContext } from '../src/context.js';
import { DockerCompose, parsePsEntries } from '../src/docker.js';

describe('DockerCompose.portEnvironment', () => {
  it('exposes base ports in the main checkout', () => {
    const docker = new DockerCompose(buildSailContext('/apps/shop', 'shop', null));
    expect(docker.portEnvironment()).toMatchObject({
      SAIL_POSTGRES_PORT: '5432',
      SAIL_REDIS_PORT: '6379',
      SAIL_MAILPIT_SMTP_PORT: '1025',
      SAIL_MAILPIT_UI_PORT: '8025',
      SAIL_MINIO_PORT: '9000',
    });
  });

  it('shifts every port by the worktree offset', () => {
    const context = buildSailContext('/wt/login', 'shop', {
      name: 'login',
      slug: 'login',
      hash: 'abc123',
      path: '/wt/login',
    });
    const docker = new DockerCompose(context);
    const environment = docker.portEnvironment();
    expect(environment['SAIL_POSTGRES_PORT']).toBe(String(5432 + context.portOffset));
    expect(environment['SAIL_REDIS_PORT']).toBe(String(6379 + context.portOffset));
    expect(docker.servicePorts('postgres')).toEqual({
      SAIL_POSTGRES_PORT: 5432 + context.portOffset,
    });
  });
});

describe('parsePsEntries', () => {
  // Compose v5 reports each published port twice (0.0.0.0 and :: entries).
  const duplicated = JSON.stringify([
    {
      Service: 'mailpit',
      State: 'running',
      Health: 'healthy',
      Publishers: [
        { URL: '0.0.0.0', TargetPort: 1025, PublishedPort: '1793', Protocol: 'tcp' },
        { URL: '::', TargetPort: 1025, PublishedPort: '1793', Protocol: 'tcp' },
        { URL: '0.0.0.0', TargetPort: 8025, PublishedPort: '8793', Protocol: 'tcp' },
        { URL: '::', TargetPort: 8025, PublishedPort: '8793', Protocol: 'tcp' },
      ],
    },
  ]);

  it('dedupes publishers reported per address family', () => {
    expect(parsePsEntries(duplicated)).toEqual([
      {
        name: 'mailpit',
        state: 'running',
        health: 'healthy',
        publishers: [
          { hostPort: 1793, containerPort: 1025 },
          { hostPort: 8793, containerPort: 8025 },
        ],
      },
    ]);
  });

  it('returns an empty list for blank output', () => {
    expect(parsePsEntries('  \n ')).toEqual([]);
  });
});
