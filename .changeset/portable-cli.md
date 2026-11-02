---
bump: patch
---

Mark the Tsir CLI entry executable so Bun installs no longer change its tracked file mode. The
distribution now points its executable at emitted JavaScript instead of a missing source file.
