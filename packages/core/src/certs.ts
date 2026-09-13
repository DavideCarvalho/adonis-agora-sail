import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { stringify } from 'yaml';

export const MKCERT_INSTALL_HINT =
  'Install mkcert (`brew install mkcert`, `sudo apt install mkcert`, or `choco install mkcert`) and re-run';

/**
 * Printed, never executed: `mkcert -install` writes to the machine's trust
 * stores (and asks for sudo / a keychain password), which is the user's call,
 * not a dev tool's.
 */
export const MKCERT_CA_INSTALL_HINT =
  'Run `mkcert -install` once so the local CA is trusted — sail never touches your trust store';

/** The file name mkcert gives the local CA certificate inside its CAROOT. */
const CA_CERT_FILE = 'rootCA.pem';

const execFileAsync = promisify(execFile);

/**
 * Returns null when `mkcert` is usable, otherwise a human-readable reason with
 * the install hint. `-version` is the one flag that neither reads nor writes
 * the CAROOT.
 */
export async function checkMkcert(): Promise<string | null> {
  try {
    await execFileAsync('mkcert', ['-version']);
    return null;
  } catch {
    return `mkcert is not installed or not on PATH. ${MKCERT_INSTALL_HINT}`;
  }
}

export interface CertPaths {
  certFile: string;
  keyFile: string;
}

/**
 * Where the project's key pair lives inside the shared proxy cert dir. Named
 * after the project so every worktree of the same app reuses one certificate.
 */
export function certPaths(certsDir: string, projectName: string): CertPaths {
  return {
    certFile: join(certsDir, `${projectName}.pem`),
    keyFile: join(certsDir, `${projectName}-key.pem`),
  };
}

/**
 * The SAN list the certificate needs: every hostname plus its one-level
 * wildcard, because subdomain multi-tenancy (`acme.shop.test`) is a headline
 * use case and a cert for `shop.test` alone does not cover it. IP literals and
 * names that are already wildcards are passed through untouched — `*.127.0.0.1`
 * is not a thing, and mkcert rejects it.
 */
export function expandCertHostnames(hostnames: string[]): string[] {
  const expanded: string[] = [];

  for (const raw of hostnames) {
    const hostname = raw.trim().toLowerCase();
    if (hostname.length === 0) {
      continue;
    }

    const names = [hostname];
    if (!hostname.startsWith('*.') && isIP(hostname) === 0) {
      names.push(`*.${hostname}`);
    }

    for (const name of names) {
      if (!expanded.includes(name)) {
        expanded.push(name);
      }
    }
  }

  return expanded;
}

/**
 * Issues (or silently re-issues) the project certificate. Re-issuing is the
 * normal path: the hostname set grows as worktrees appear, and mkcert is fast
 * enough that diffing the existing SANs would cost more than it saves.
 *
 * mkcert creates the local CA on first use, so this works before the user has
 * run `mkcert -install` — the certificate is simply untrusted until they do.
 */
export async function issueCert(options: {
  certsDir: string;
  projectName: string;
  hostnames: string[];
}): Promise<CertPaths> {
  const names = expandCertHostnames(options.hostnames);
  if (names.length === 0) {
    throw new Error('issueCert needs at least one hostname');
  }

  const paths = certPaths(options.certsDir, options.projectName);
  await mkdir(options.certsDir, { recursive: true });
  await execFileAsync('mkcert', [
    '-cert-file',
    paths.certFile,
    '-key-file',
    paths.keyFile,
    ...names,
  ]);

  return paths;
}

/**
 * The dynamic TLS configuration for Traefik's file provider. Paths are emitted
 * exactly as given, so the caller decides whether they are host paths or the
 * container-side paths the cert dir is mounted at. Traefik then picks a
 * certificate per request by SNI.
 */
export function buildTlsConfig(certs: CertPaths[]): string {
  const header =
    '# Managed by @adonis-agora/sail. Regenerated on every run — hand edits are lost.\n';
  const document = {
    tls: {
      certificates: certs.map((cert) => ({ certFile: cert.certFile, keyFile: cert.keyFile })),
    },
  };

  return header + stringify(document, { lineWidth: 100 });
}

/**
 * Whether `mkcert -install` has been run, i.e. the local CA is actually
 * trusted.
 *
 * `mkcert -CAROOT` alone cannot answer this: it only prints a directory, and
 * *every* mkcert invocation — issuing a certificate included — creates
 * `rootCA.pem` there. Its existence proves the CA was generated, never that it
 * was installed. What is authoritative is mkcert's own check: run with no
 * arguments it verifies the CA against the trust stores and logs
 * `Note: the local CA is not installed in the ... trust store.` when it is
 * missing. That run is side-effect-free only once the CA file exists, which is
 * why the file check comes first (no CA file also means definitely not
 * installed).
 *
 * Any doubt — mkcert missing, the command failing, a note about *any* store —
 * resolves to false, since the cost of a wrong `true` is a browser security
 * interstitial the user has no explanation for.
 */
export async function isCaInstalled(): Promise<boolean> {
  let caRoot: string;
  try {
    const { stdout } = await execFileAsync('mkcert', ['-CAROOT']);
    caRoot = stdout.trim();
  } catch {
    return false;
  }

  if (caRoot.length === 0) {
    return false;
  }

  try {
    await readFile(join(caRoot, CA_CERT_FILE), 'utf8');
  } catch {
    return false;
  }

  try {
    const { stderr } = await execFileAsync('mkcert', []);
    return !/is not installed in the/i.test(stderr);
  } catch {
    return false;
  }
}
