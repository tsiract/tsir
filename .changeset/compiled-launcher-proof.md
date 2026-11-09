---
bump: patch
---

Make `make verify-dist` compile the distribution's CLI to a single executable and scaffold an
application from it, so the compiled layout is proven by the gate rather than by hand. `make
compile-cli` runs that proof alone.
