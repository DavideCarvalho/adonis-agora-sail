---
'@adonis-agora/sail': patch
---

Commands now exit with the code of whatever actually failed. `failJsonAware` used to assign `1` after the caller had already stored the child's status, so a failing `docker compose up`, `sail:logs`, `sail:down` or one-shot `sail:psql` collapsed to `1` while the message still quoted the real code (`sail:psql failed (exit 3)`). A failing query now fails the surrounding script with the status the query produced; sail's own refusals (missing compose file, unusable docker, flag conflicts) still exit `1`.
