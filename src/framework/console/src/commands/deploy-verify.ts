/**
 * `tsir deploy:verify` — what the AWS Emulator can prove about the AWS calls this project makes.
 *
 * The AWS half of tsir is not verifiable by reading it: `sqsDriver` sends a particular four
 * operations, the SES transport posts one path by hand, and `internalTransport` publishes, lists
 * topics and invokes functions. Whether a local emulator can run *those* calls is a
 * per-operation question, and this is the command that answers it with a table, a source
 * cross-check, and a live probe when an emulator is running.
 *
 * **Why a `tsir` command and not a `make` target.** It was first written as `make aws-emulator`,
 * reasoning that it reads framework source and therefore belongs with the build. That is the wrong
 * test: `make` in this repository builds the framework (dist, gates over `src/`, packaging), and a
 * verb that answers "what is true about the project in front of me" belongs behind `tsir` — the
 * same line `deploy:build`, `deploy:plan` and `deploy:validate` sit on (ADR-0031,
 * `11-dx.md § 1`). It must also run from a distribution where `src/tools/` does not exist: the
 * verdict table and the probe ship, while the source cross-check needs the vendored emulator
 * handlers and is therefore the part that only runs in this repository.
 *
 * The report never fails on a missing emulator: absent tooling prints how to start one and exits
 * 0, because a machine without a binary is not a repository defect. It fails only when this tree
 * calls an AWS operation the table has no row for — a table that silently understates what we
 * call is worse than no table.
 */

import { verify } from './emulator.ts';

/** `tsir deploy:verify [--json] [--root <dir>]` (`DPL-033`). */
export async function deployVerifyCommand(argv: readonly string[]): Promise<number> {
  return verify(argv);
}
