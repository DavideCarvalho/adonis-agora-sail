---
'@adonis-agora/sail': minor
---

Service shells and sharing. New `sail:psql`, `sail:mysql` and `sail:redis` commands open the service client's REPL on a terminal, or run a captured one-shot with a propagated exit code when given args (`sail:psql -- -c 'select 1'`) — the agent-safe form, since a bare invocation fails without a TTY instead of hanging. New `sail:share` exposes the worktree's `serve` port on a public `*.trycloudflare.com` URL via cloudflared (no account needed) for previews and webhook integrations; the port resolves exactly like `serve` does, `--json` prints one `{ url, local }` line and keeps running until killed. When the worktree port is closed but the base `PORT` answers (a core without the worktree-port patch), it shares the base port instead and says so.
