import { fileURLToPath } from 'node:url';
import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

import {
  checkMkcert,
  isCaInstalled,
  issueCert,
  MKCERT_CA_INSTALL_HINT,
  MKCERT_INSTALL_HINT,
} from '../src/certs.js';
import { DockerCompose } from '../src/docker.js';
import { listRegisteredProjects, proxyPaths } from '../src/proxy.js';
import {
  ensureProxyScaffold,
  hasIssuedCert,
  isDomainEnabled,
  proxyContext,
  refreshTlsConfig,
  removeRoute,
  resolveDomainHostnames,
  resolvesLocally,
  writeRoute,
} from '../src/proxy_state.js';
import { resolverInstructions, resolverSupported } from '../src/resolver.js';
import { resolveSharePort } from '../src/share.js';
import { SailBaseCommand } from './sail_base_command.js';

/**
 * `node ace sail:domain [--enable|--disable|--install] [--json]` — gives the
 * app a hostname instead of a worktree-shifted port number.
 *
 * Entirely opt-in: until `--enable` runs for this app, sail touches nothing
 * here and no proxy container exists. Enabling registers a route with a
 * shared Traefik proxy — one per machine, because port 80 only fits once —
 * pointing `<project>.localhost` and `<project>.test`, plus their subdomains,
 * at the host port this worktree's `serve` listens on. Subdomains come along
 * on purpose: tenant-per-subdomain apps are what hurts most with bare ports.
 *
 * `.localhost` needs no DNS setup on Linux and in browsers; `.test` needs a
 * one-time resolver install, which `--install` prints for your platform and
 * never runs — it needs root, and sail does not take that decision for you.
 */
export default class SailDomain extends SailBaseCommand {
  static override commandName = 'sail:domain';
  static override description = 'Serve the app on a local domain instead of a port (opt-in)';
  static override options: CommandOptions = { startApp: false };

  @flags.boolean({ description: 'Register this app with the shared proxy', default: false })
  declare enable: boolean;

  @flags.boolean({ description: 'Unregister this app from the shared proxy', default: false })
  declare disable: boolean;

  @flags.boolean({
    description: 'Print the one-time DNS setup for .test domains (never runs it)',
    default: false,
  })
  declare install: boolean;

  override async run(): Promise<void> {
    if (this.install) {
      this.#printResolverInstructions();
      return;
    }

    if (this.enable && this.disable) {
      this.failJsonAware(
        'Cannot combine --enable with --disable',
        'Pass one of them, or neither to see the current status',
      );
      return;
    }

    const context = await this.sailContext();
    const appRoot = fileURLToPath(this.app.appRoot);
    const hostnames = await resolveDomainHostnames(appRoot, context.projectName);
    const { port } = await resolveSharePort(appRoot, {
      worktreeName: context.worktree?.name ?? null,
    });

    if (this.disable) {
      await this.#disable(context.projectName, hostnames);
      return;
    }
    if (this.enable) {
      await this.#enable(context.projectName, hostnames, port);
      return;
    }
    await this.#status(context.projectName, hostnames, port);
  }

  #printResolverInstructions() {
    const suffix = 'test';
    const instructions = resolverInstructions(process.platform, suffix);

    if (this.wantsJson) {
      this.printJson({
        platform: process.platform,
        suffix,
        supported: resolverSupported(process.platform),
        instructions,
      });
      return;
    }
    this.logger.log(instructions);
  }

  async #enable(projectName: string, hostnames: string[], targetPort: number) {
    if (!(await this.ensureDocker())) {
      return;
    }

    const paths = await ensureProxyScaffold();
    const mkcertProblem = await checkMkcert();
    const tls = mkcertProblem === null;
    // A certificate sail issued is only as good as the CA the browser trusts,
    // and installing that CA is a trust-store change we refuse to make for you.
    const caInstalled = tls ? await isCaInstalled() : false;
    if (tls) {
      await issueCert({ certsDir: paths.certsDir, projectName, hostnames });
    }
    await refreshTlsConfig();
    await writeRoute({ projectName, hostnames, targetPort, tls });

    const result = await new DockerCompose(proxyContext(paths)).up();
    if (result.exitCode !== 0) {
      await removeRoute(projectName);
      await refreshTlsConfig();
      this.failJsonAware(
        `Could not start the sail proxy:\n${this.tailLines(result.stderr || result.stdout)}`,
        'Ports 80 and 443 must be free — stop whatever is holding them and re-run',
        result.exitCode,
      );
      return;
    }

    const urls = this.#urls(hostnames, tls);
    // Reporting a URL the machine cannot look up is the failure mode users
    // blame on sail, so the answer comes from the system resolver, not from
    // an assumption about the platform.
    const unresolved = (
      await Promise.all(
        hostnames.map(async (hostname) => ((await resolvesLocally(hostname)) ? null : hostname)),
      )
    ).filter((hostname): hostname is string => hostname !== null);

    if (this.wantsJson) {
      this.printJson({
        status: 'enabled',
        projectName,
        hostnames,
        urls,
        targetPort,
        tls,
        caInstalled,
        unresolved,
        ...(mkcertProblem ? { notice: mkcertProblem } : {}),
      });
      return;
    }

    this.logger.success(`Domains enabled for "${projectName}" → 127.0.0.1:${targetPort}`);
    for (const url of urls) {
      this.logger.log(`  ${url}`);
    }
    if (mkcertProblem) {
      this.logger.info(`Serving HTTP only — ${MKCERT_INSTALL_HINT}`);
    } else if (!caInstalled) {
      this.logger.warning(
        `Certificate issued, but the browser will not trust it yet — ${MKCERT_CA_INSTALL_HINT}`,
      );
    }
    if (unresolved.length > 0) {
      this.logger.warning(
        `Browsers reach ${unresolved.join(', ')} on their own, but this machine's resolver does not — curl, Node and GUI clients will not`,
      );
      this.logger.info('Run `node ace sail:domain --install` for the one-time DNS setup');
    }
  }

  async #disable(projectName: string, hostnames: string[]) {
    // Nothing to remove means nothing to create: disabling an app that never
    // opted in must not be the thing that materialises ~/.sail/proxy.
    if (!(await isDomainEnabled(projectName))) {
      if (this.wantsJson) {
        this.printJson({
          status: 'disabled',
          projectName,
          hostnames,
          removed: false,
          proxyStopped: false,
        });
        return;
      }
      this.logger.success(`Domains were not enabled for "${projectName}"`);
      return;
    }

    const paths = await ensureProxyScaffold();
    const removed = await removeRoute(projectName);
    await refreshTlsConfig();

    // The proxy exists for the routes: with the last one gone it is a
    // container squatting on port 80 for nothing.
    const remaining = await listRegisteredProjects(paths.confDir);
    let proxyStopped = false;
    if (remaining.length === 0) {
      proxyStopped = (await new DockerCompose(proxyContext(paths)).down()).exitCode === 0;
    }

    if (this.wantsJson) {
      this.printJson({ status: 'disabled', projectName, hostnames, removed, proxyStopped });
      return;
    }

    this.logger.success(`Domains disabled for "${projectName}" — the app is on 127.0.0.1 again`);
    if (proxyStopped) {
      this.logger.info('No apps left on the proxy — stopped it');
    }
  }

  async #status(projectName: string, hostnames: string[], targetPort: number) {
    const enabled = await isDomainEnabled(projectName);
    // Reporting is read-only: resolve the paths, never create them.
    const paths = proxyPaths();
    const tls = enabled && (await hasIssuedCert(paths.certsDir, projectName));
    const urls = enabled ? this.#urls(hostnames, tls) : [];

    if (this.wantsJson) {
      this.printJson({
        status: enabled ? 'enabled' : 'disabled',
        projectName,
        hostnames,
        urls,
        targetPort,
        tls,
      });
      return;
    }

    if (!enabled) {
      this.logger.info(
        `Domains are off for "${projectName}" — the app is on 127.0.0.1:${targetPort}`,
      );
      this.logger.info(
        `Enable them with \`node ace sail:domain --enable\` (would serve ${hostnames[0]})`,
      );
      return;
    }

    this.logger.success(`Domains enabled for "${projectName}" → 127.0.0.1:${targetPort}`);
    for (const url of urls) {
      this.logger.log(`  ${url}`);
    }
    if (!tls) {
      this.logger.info(`Serving HTTP only — ${MKCERT_INSTALL_HINT}`);
    }
  }

  #urls(hostnames: string[], tls: boolean): string[] {
    const scheme = tls ? 'https' : 'http';
    return hostnames.map((hostname) => `${scheme}://${hostname}`);
  }
}
