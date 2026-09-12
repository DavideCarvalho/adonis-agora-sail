---
"@adonis-agora/sail": patch
---

Correct the `buildSailEnvBlock` doc comment: the `.env.local` block it builds does carry the services' fixed dev credentials, which is why the file is git-ignored.
