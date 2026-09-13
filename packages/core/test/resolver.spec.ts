import { describe, expect, it } from 'vitest';

import { resolverInstructions, resolverSupported } from '../src/resolver.js';

describe('resolverInstructions', () => {
  it('gives macOS the /etc/resolver file and the dnsmasq it needs', () => {
    const text = resolverInstructions('darwin', 'test');

    expect(text).toContain('brew install dnsmasq');
    expect(text).toContain('address=/test/127.0.0.1');
    expect(text).toContain('sudo tee /etc/resolver/test');
    expect(text).toContain('nameserver 127.0.0.1');
    expect(text).toContain('dscacheutil -q host -a name app.test');
    expect(text).toContain('macOS 26');
  });

  it('gives Linux a systemd-resolved drop-in with a routing-only domain', () => {
    const text = resolverInstructions('linux', 'test');

    expect(text).toContain('/etc/systemd/resolved.conf.d/sail-test.conf');
    expect(text).toContain('[Resolve]');
    expect(text).toContain('DNS=127.0.0.2');
    expect(text).toContain('Domains=~test');
    expect(text).toContain('listen-address=127.0.0.2');
    expect(text).toContain('resolvectl query app.test');
  });

  it('mentions the NetworkManager/dnsmasq alternative on Linux', () => {
    const text = resolverInstructions('linux', 'test');

    expect(text).toContain('/etc/NetworkManager/conf.d/00-dnsmasq.conf');
    expect(text).toContain('dns=dnsmasq');
    expect(text).toContain('/etc/NetworkManager/dnsmasq.d/sail-test.conf');
  });

  it('says plainly that Windows has no wildcard hosts support and names Acrylic', () => {
    const text = resolverInstructions('win32', 'test');

    expect(text).toContain('C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(text).toContain('matches exact names only');
    expect(text).toContain('Acrylic DNS Proxy');
    expect(text).toContain('AcrylicHosts.txt');
    expect(text).toContain('127.0.0.1 *.test');
  });

  it('falls back to a generic note on unknown platforms', () => {
    const text = resolverInstructions('aix', 'test');

    expect(text).toContain('no wildcard DNS recipe');
    expect(text).toContain('aix');
  });

  it('interpolates the suffix everywhere', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const text = resolverInstructions(platform, 'sail');
      expect(text).toContain('*.sail');
      expect(text).not.toContain('app.test');
    }
  });

  it('leads with the zero-setup note for .localhost', () => {
    expect(resolverInstructions('darwin', 'localhost')).toMatch(/^Heads-up: \*\.localhost/);
    expect(resolverInstructions('linux', 'localhost')).toContain('systemd-resolved synthesizes');
    expect(resolverInstructions('win32', 'localhost')).toMatch(/^Heads-up: \*\.localhost/);
    expect(resolverInstructions('darwin', 'test')).not.toContain('Heads-up: *.localhost');
  });

  it('asks the user to run every privileged command instead of claiming sail does', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const text = resolverInstructions(platform, 'test');
      expect(text).toContain('sudo ');
      expect(text).toMatch(/Sail does not edit/);
      expect(text).not.toMatch(/sail will/i);
    }
  });
});

describe('resolverSupported', () => {
  it('is true where the OS itself can route a suffix to loopback', () => {
    expect(resolverSupported('darwin')).toBe(true);
    expect(resolverSupported('linux')).toBe(true);
  });

  it('is false on Windows and anything exotic', () => {
    expect(resolverSupported('win32')).toBe(false);
    expect(resolverSupported('freebsd')).toBe(false);
  });
});
