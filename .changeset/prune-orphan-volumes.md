---
"@adonis-agora/sail": minor
---

`sail:prune` now finds what deleted worktrees really leave behind. It lists stopped compose projects too (`docker compose ls --all`), so a worktree whose stack was stopped before it was deleted is no longer invisible, and it looks for orphan **volumes** on their own: the volumes of orphan stacks, plus sail's volumes (`sail-postgres`, `sail-redis`, …) of projects that have no container left and match no worktree `git worktree list` still knows — the case of a worktree that was `sail:down`-ed and then removed, where only the data remains.

`--dry-run` lists those volumes next to the stacks (`volumes` in the JSON payload), and `--volumes` — the same opt-in as `sail:down --volumes` — deletes them, by name when `compose down --volumes` can no longer reach them (`removedVolumes`). Without the flag, prune ends by saying how many volumes it kept and how to delete them. When git cannot list the worktrees, only the orphan stacks' own volumes are considered.
