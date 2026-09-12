---
"@adonis-agora/sail": patch
---

Correct the `DockerCompose.logs()` doc comment: it only streams to the terminal when `follow` is set, otherwise the output is returned in the `RunResult`.
