import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  buildTlsConfig,
  certPaths,
  expandCertHostnames,
  MKCERT_CA_INSTALL_HINT,
  MKCERT_INSTALL_HINT,
} from '../src/certs.js';

describe('certPaths', () => {
  it('names the pair after the project inside the cert dir', () => {
    expect(certPaths('/home/me/.sail/proxy/certs', 'shop')).toEqual({
      certFile: '/home/me/.sail/proxy/certs/shop.pem',
      keyFile: '/home/me/.sail/proxy/certs/shop-key.pem',
    });
  });

  it('normalizes the cert dir', () => {
    expect(certPaths('/tmp/certs/', 'shop').certFile).toBe('/tmp/certs/shop.pem');
  });
});

describe('expandCertHostnames', () => {
  it('covers each hostname and its wildcard', () => {
    expect(expandCertHostnames(['shop.localhost', 'shop.test'])).toEqual([
      'shop.localhost',
      '*.shop.localhost',
      'shop.test',
      '*.shop.test',
    ]);
  });

  it('deduplicates and lowercases', () => {
    expect(expandCertHostnames(['Shop.Test', 'shop.test', '*.shop.test'])).toEqual([
      'shop.test',
      '*.shop.test',
    ]);
  });

  it('never wildcards an IP literal', () => {
    expect(expandCertHostnames(['127.0.0.1', '::1'])).toEqual(['127.0.0.1', '::1']);
  });

  it('skips blanks and trims', () => {
    expect(expandCertHostnames(['  shop.test  ', '', '   '])).toEqual(['shop.test', '*.shop.test']);
  });

  it('returns nothing for no input', () => {
    expect(expandCertHostnames([])).toEqual([]);
  });
});

describe('buildTlsConfig', () => {
  it('emits a Traefik file-provider TLS config with every certificate', () => {
    const yaml = buildTlsConfig([
      { certFile: '/certs/shop.pem', keyFile: '/certs/shop-key.pem' },
      { certFile: '/certs/blog.pem', keyFile: '/certs/blog-key.pem' },
    ]);

    expect(parse(yaml)).toEqual({
      tls: {
        certificates: [
          { certFile: '/certs/shop.pem', keyFile: '/certs/shop-key.pem' },
          { certFile: '/certs/blog.pem', keyFile: '/certs/blog-key.pem' },
        ],
      },
    });
  });

  it('stays valid YAML with no certificates', () => {
    expect(parse(buildTlsConfig([]))).toEqual({ tls: { certificates: [] } });
  });

  it('marks the file as generated', () => {
    expect(buildTlsConfig([]).startsWith('# Managed by @adonis-agora/sail.')).toBe(true);
  });
});

describe('mkcert hints', () => {
  it('tells the user what to install and never claims sail installs it', () => {
    expect(MKCERT_INSTALL_HINT).toContain('brew install mkcert');
    expect(MKCERT_CA_INSTALL_HINT).toContain('mkcert -install');
    expect(MKCERT_CA_INSTALL_HINT).toContain('never touches your trust store');
  });
});
