---
"@adonis-agora/sail": patch
---

The object storage validations `sail:install` adds to `start/env.ts` are `.optional()`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET` and `S3_ENDPOINT` were required, which broke production and CI boots where those keys do not exist. And sail now writes the object storage env under the names the app's s3 disk actually reads: with `accessKeyId: env.get('S3_ACCESS_KEY')` in `config/drive.ts`, install, `sail:up` and `sail:info` use `S3_ACCESS_KEY`, a literal region gets no key, and `forcePathStyle: env.get(…)` gets `true` — no more `AWS_*` keys nothing reads.
