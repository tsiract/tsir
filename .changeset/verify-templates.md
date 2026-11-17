---
bump: patch
---

Add `make verify-templates` and run it in CI: every shipped frontend template is installed from the
registry, typechecked and built, so a dependency version that stops resolving fails the build instead
of the first developer who copies the template.
