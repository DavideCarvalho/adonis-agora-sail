/**
 * Wildcard DNS for a development suffix is a machine-wide, root-owned change:
 * a DNS server on loopback plus a resolver rule that routes the suffix to it.
 * Sail only ever *prints* those steps — same rule as `mkcert -install`.
 */

/**
 * `.localhost` is the one suffix that mostly resolves itself, so leading with
 * "you probably need nothing" saves people a dnsmasq install they will have to
 * undo later.
 */
function localhostNote(platform: NodeJS.Platform): string {
  const resolverNote =
    platform === 'linux'
      ? '\nsystemd-resolved synthesizes every *.localhost name to 127.0.0.1 and ::1 — but\nonly for clients that ask it. Check `getent hosts app.localhost`: if that comes\nback empty while `resolvectl query app.localhost` answers, your\n/etc/nsswitch.conf `hosts:` line is missing the `resolve` module, and the steps\nbelow (or adding `resolve` to that line) are what fix curl and friends.'
      : '';

  return `Heads-up: *.localhost usually needs no setup — Chrome, Edge and Firefox send
every *.localhost name straight to 127.0.0.1 without asking DNS.${resolverNote}
Follow the steps below only if clients that use the system resolver (curl, Node,
a database GUI) also have to resolve these names.

`;
}

function macosInstructions(suffix: string): string {
  return `macOS — resolve *.${suffix} to 127.0.0.1

Sail does not edit /etc/resolver or install services. Run these once, yourself:

1. Answer the suffix from a local dnsmasq. Port 5300 keeps it off privileged
   port 53, so the service needs no root:

     brew install dnsmasq
     printf 'port=5300\\naddress=/${suffix}/127.0.0.1\\n' >> "$(brew --prefix)/etc/dnsmasq.conf"
     brew services start dnsmasq

2. Point macOS at it for that suffix only. /etc/resolver/<suffix> covers the
   suffix and every subdomain of it, and writing there needs root:

     sudo mkdir -p /etc/resolver
     printf 'nameserver 127.0.0.1\\nport 5300\\n' | sudo tee /etc/resolver/${suffix}

3. Check it. dig talks to a nameserver directly and ignores /etc/resolver, so
   test both layers:

     dig -p 5300 @127.0.0.1 app.${suffix}
     dscacheutil -q host -a name app.${suffix}

Known breakage: macOS 26 made mDNSResponder answer TLDs that are not in the
IANA root zone (.test, .lan, .internal, .home.arpa) over multicast DNS and never
consult the nameserver in /etc/resolver. If step 3's dig works but dscacheutil
does not, that is this bug — use *.localhost, which browsers resolve on their
own, or add one line per hostname to /etc/hosts.`;
}

function linuxInstructions(suffix: string): string {
  return `Linux (systemd-resolved) — resolve *.${suffix} to 127.0.0.1

Sail does not edit system DNS configuration. Run these once, yourself:

1. Answer the suffix from a local dnsmasq bound to 127.0.0.2, so it never
   competes with systemd-resolved's stub listener on 127.0.0.53:53:

     sudo apt install dnsmasq   # or: sudo dnf install dnsmasq / sudo pacman -S dnsmasq
     printf 'listen-address=127.0.0.2\\nbind-interfaces\\naddress=/${suffix}/127.0.0.1\\n' \\
       | sudo tee /etc/dnsmasq.d/sail-${suffix}.conf
     sudo systemctl restart dnsmasq

2. Route just that suffix to it with a resolved drop-in. The leading "~" makes
   it a routing-only domain: nothing else changes about your DNS:

     sudo mkdir -p /etc/systemd/resolved.conf.d
     printf '[Resolve]\\nDNS=127.0.0.2\\nDomains=~${suffix}\\n' \\
       | sudo tee /etc/systemd/resolved.conf.d/sail-${suffix}.conf
     sudo systemctl restart systemd-resolved

3. Check it:

     resolvectl query app.${suffix}

Alternative: if your machine resolves through NetworkManager rather than
systemd-resolved, use NetworkManager's own dnsmasq instead of steps 1 and 2 —
no second service and no port juggling:

     printf '[main]\\ndns=dnsmasq\\n' | sudo tee /etc/NetworkManager/conf.d/00-dnsmasq.conf
     printf 'address=/${suffix}/127.0.0.1\\n' \\
       | sudo tee /etc/NetworkManager/dnsmasq.d/sail-${suffix}.conf
     sudo systemctl restart NetworkManager`;
}

function windowsInstructions(suffix: string): string {
  return `Windows — resolve *.${suffix} to 127.0.0.1

Windows has no wildcard name resolution of its own. The hosts file
(C:\\Windows\\System32\\drivers\\etc\\hosts) matches exact names only, so a line
like "127.0.0.1 *.${suffix}" does nothing at all. Two options, both run by you:

A. List the hostnames you actually use. Open an elevated editor and add one
   line per name:

     127.0.0.1 app.${suffix}

B. For real wildcards, run a local DNS proxy. Acrylic DNS Proxy is what people
   use for this (https://mayakron.altervista.org/support/acrylic/Home.htm):

     1. Install Acrylic DNS Proxy.
     2. Add "127.0.0.1 *.${suffix}" to AcrylicHosts.txt — "Open Acrylic Hosts"
        in the Start menu, in an elevated editor.
     3. Restart the "Acrylic DNS Proxy" service so the file is re-read.
     4. Set the network adapter's preferred DNS server to 127.0.0.1.

Zero-setup alternative: use *.localhost. Chrome, Edge and Firefox route every
*.localhost name to 127.0.0.1 themselves, with no DNS changes.`;
}

/**
 * Copy-pasteable, per-platform instructions for pointing `*.<suffix>` at
 * 127.0.0.1. Every privileged step is written as a command for the user to
 * run; sail runs none of them.
 */
export function resolverInstructions(platform: NodeJS.Platform, suffix: string): string {
  const prefix = suffix === 'localhost' ? localhostNote(platform) : '';

  switch (platform) {
    case 'darwin':
      return prefix + macosInstructions(suffix);
    case 'linux':
      return prefix + linuxInstructions(suffix);
    case 'win32':
      return prefix + windowsInstructions(suffix);
    default:
      return `${prefix}Sail has no wildcard DNS recipe for this platform (${platform}).

Point *.${suffix} at 127.0.0.1 with whatever resolver your system uses, or stick
to *.localhost — browsers resolve those to 127.0.0.1 with no configuration.`;
  }
}

/**
 * Whether the platform has a first-class way to resolve a whole suffix to
 * loopback (macOS /etc/resolver, systemd-resolved routing domains). False for
 * Windows: nothing in the OS does wildcards, so the only answer there is a
 * third-party DNS proxy or one hosts entry per hostname.
 */
export function resolverSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}
