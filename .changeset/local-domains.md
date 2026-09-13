---
'@adonis-agora/sail': minor
---

New `sail:domain` command: serve the app on `<project>.localhost` / `<project>.test` instead of a worktree-shifted port. Opt-in per app and per machine — until `sail:domain --enable` runs, no proxy exists and every other command behaves exactly as before.

Enabling registers the app with a shared Traefik proxy (one per machine, since ports 80 and 443 only fit once) that routes the hostname, and any subdomain of it, to the host port this worktree's `serve` listens on. Subdomains are covered on purpose: tenant-per-subdomain apps are the case bare ports hurt most. `sail:up` re-points the route when the port moves, so a renamed worktree or a changed `PORT` keeps working without intervention.

How the proxy reaches back to the host is platform-specific and generated accordingly: on Linux it shares the host network, because from the bridge the app sits behind the host's `INPUT` chain and any machine with ufw enabled drops that traffic into a 504; on macOS and Windows it publishes 80/443 off the bridge and targets `host.docker.internal`, which is what works there. `--enable` also looks the hostnames up through the system resolver and warns when they do not answer — `*.localhost` is resolved internally by browsers but not necessarily by curl, Node or a database GUI.

HTTPS is issued with mkcert when the binary is present, covering the hostnames and their wildcards; without it the proxy serves plain HTTP and says so. Sail never runs `mkcert -install` and never installs a DNS resolver — both need root, so `sail:domain --install` prints the platform's instructions instead. `SAIL_DOMAIN` in `.env` pins the hostname when a team wants to agree on one.
