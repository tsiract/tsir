---
bump: patch
---

The AWS Emulator is read at a pinned tag and turned into a check: `tsir deploy:verify` prints one
verdict per AWS operation this repository calls — derived from the emulator's own handler sources,
cross-checked on every test run against 13 vendored files — and probes a running emulator when
there is one. Two mistakes in the first version of that check (a selector that read a function's
parameter list, and a command scan that assumed an SDK prefix and therefore found no SNS or Lambda
call in the repository) are why the reading says `Invoke` runs handlers, not why it says Lambda is
unimplemented.
