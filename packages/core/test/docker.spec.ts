import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildSailContext } from '../src/context.js';
import { DockerCompose, findTakenPorts, parsePortHolders, parsePsEntries } from '../src/docker.js';
import { DOCKER_METHODS, fakeDocker } from './helpers/ace.js';

describe('the fake used by the command specs', () => {
  // `private` is erased at runtime, so these still show up on the prototype.
  // They are the process-spawning plumbing every public method funnels into;
  // a fake has no business standing in for them.
  const INTERNAL = ['constructor', 'run', 'runDocker', 'runGlobal', 'spawnDocker'];

  it('answers to exactly the methods the real class exposes', () => {
    // A fake answering to a name the class does not have is worse than no
    // fake: the command's try/catch turns the TypeError into a plausible
    // failure path and the spec passes while proving nothing. That is exactly
    // how a `listProjects`/`lsProjects` slip survived into this harness.
    const real = Object.getOwnPropertyNames(DockerCompose.prototype)
      .filter((name) => !INTERNAL.includes(name))
      .sort();

    expect([...DOCKER_METHODS].sort()).toEqual(real);
    for (const method of DOCKER_METHODS) {
      expect(fakeDocker().instance).toHaveProperty(method);
    }
  });
});

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

describe('DockerCompose.wantedHostPorts', () => {
  const docker = new DockerCompose(buildSailContext('/apps/shop', 'shop', null));

  it('only probes the ports of the services it is given', () => {
    // A postgres-only stack must not refuse to start over someone else's
    // MySQL on 3306 — the preflight is scoped to the compose file.
    expect(docker.wantedHostPorts(['postgres'])).toEqual([5432]);
    expect(docker.wantedHostPorts(['postgres', 'redis'])).toEqual([5432, 6379]);
  });

  it('expands multi-port services and dedupes', () => {
    expect(docker.wantedHostPorts(['mailpit', 'minio'])).toEqual([1025, 8025, 8900, 9000]);
    expect(docker.wantedHostPorts(['redis', 'redis'])).toEqual([6379]);
    expect(docker.wantedHostPorts([])).toEqual([]);
  });

  it('applies the worktree offset', () => {
    const context = buildSailContext('/wt/login', 'shop', {
      name: 'login',
      slug: 'login',
      hash: 'abc123',
      path: '/wt/login',
    });
    expect(new DockerCompose(context).wantedHostPorts(['postgres'])).toEqual([
      5432 + context.portOffset,
    ]);
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

describe('findTakenPorts', () => {
  it('reports closed ports as free', async () => {
    await expect(findTakenPorts([1, 2])).resolves.toEqual([]);
  });

  it('reports a listening socket as taken', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(findTakenPorts([1, port])).resolves.toEqual([port]);
    server.close();
  });
});

describe('DockerCompose.composeServices', () => {
  it('scopes the preflight to the services the compose file declares', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-docker-'));
    await writeFile(
      join(dir, 'compose.yml'),
      'services:\n  postgres:\n    image: postgres:17\n',
      'utf8',
    );
    const docker = new DockerCompose(buildSailContext(dir, 'shop', null));
    await expect(docker.composeServices()).resolves.toEqual(['postgres']);

    // Only postgres is declared, so nothing else is ever probed: a foreign
    // MySQL on 3306 (or a Mailpit on 8025) cannot block this stack.
    expect(docker.wantedHostPorts(await docker.composeServices())).toEqual([5432]);
    expect(docker.wantedHostPorts(await docker.composeServices())).not.toContain(3306);
  });

  it('resolves empty when the compose file is missing', async () => {
    const docker = new DockerCompose(buildSailContext('/nope/missing', 'shop', null));
    await expect(docker.composeServices()).resolves.toEqual([]);
    await expect(docker.takenHostPorts()).resolves.toEqual([]);
  });
});

describe('parsePortHolders', () => {
  it('maps published host ports to container names', () => {
    const holders = parsePortHolders(
      JSON.stringify([
        { Names: 'shop-main-postgres-1', Ports: '0.0.0.0:5432->5432/tcp, :::5432->5432/tcp' },
        { Names: 'shop-main-redis-1', Ports: '0.0.0.0:6379->6379/tcp' },
        { Names: 'unpublished', Ports: '' },
      ]),
    );
    expect(holders.get(5432)).toEqual(['shop-main-postgres-1']);
    expect(holders.get(6379)).toEqual(['shop-main-redis-1']);
    expect(holders.has(1025)).toBe(false);
  });

  it('returns an empty map for blank or garbage output', () => {
    expect(parsePortHolders('  \n ').size).toBe(0);
    expect(parsePortHolders('not json').size).toBe(0);
  });
});
