---
'@adonis-agora/sail': patch
---

`sail:install` reports the env wiring it actually performed. The AdonisJS codemods catch their own failures — a missing `@adonisjs/assembler`, no `tsconfig.json` in the app root, a `start/env.ts` without `Env.create`, a `.env` that does not exist yet — and report them through the logger rather than throwing, so "it did not throw" was never evidence of a write. Install now reads the files back and, when nothing changed, says so and prints the snippet to paste instead of claiming `start/env.ts validations added (…)` for a file it never touched. The degradation branch that message lives in was unreachable until now.

Under `--json` the codemods are muted through their own `useLogger()` hook, so stdout stays the single parseable document the flag promises — their progress lines used to sit next to the report and break every consumer that pipes it into a parser.
