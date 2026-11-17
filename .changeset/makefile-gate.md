---
bump: patch
---

Restore the Compose detection `make db-up` reads, unmerge the `db-up` documentation line, and add
`make make-check` to `make check` so a Makefile variable read without a definition, a target defined
twice, and a document naming a target that no longer exists all fail the gate instead of shipping.
