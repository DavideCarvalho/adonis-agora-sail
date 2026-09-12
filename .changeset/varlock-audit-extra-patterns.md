---
'@adonis-agora/sail': patch
---

Declare the Adonis env access idioms in the `.env.schema` sail manages, so `varlock audit` stops reporting every key as unreferenced. The audit's built-in patterns only see bare `process.env.X`-style identifiers, which an Adonis app never writes — config and app code go through `env.get('DB_HOST')`, and the keys the framework itself reads (`HOST`, `PORT`, `LOG_LEVEL`) only ever appear as `KEY: Env.schema.…()` declarations in `start/env.ts`. Sail now emits two `@auditExtraPatterns()` root decorators covering both, one call per idiom so each keeps its own explanatory comment.

They are root decorators, so they only mean anything above the `# ---` divider: a schema created from scratch gets a real root section (header, the two lines, divider, then the managed item block), and an existing schema that has a divider gets them inserted right above it. A schema that already declares `@auditExtraPatterns` anywhere — sail's line or a hand-written one for your own config wrapper — is left completely alone, since calls merge additively and a second copy would just double the scan. A schema with no divider at all is reported, not rewritten: inserting one would silently reinterpret the file's leading comments as root decorators, so install prints the lines and where they go, like it already does for `MAIL_MAILER` and `DRIVE_DISK`.
