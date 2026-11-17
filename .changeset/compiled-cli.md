---
bump: patch
---

Make the CLI work as a single-file executable: templates reach the bundle through text imports
(`stubs/*.slug.txt`) instead of a `stubs/` directory that `bun build --compile` does not carry, and
the framework version is baked in at build time so `tsir --version` and `tsir about` stop answering
"unknown".
