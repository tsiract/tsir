/**
 * What the AWS Emulator can actually prove about *our* AWS code (`07-deploy-cloud-checks.md`).
 *
 * AWS Emulator is a local, account-free emulator of the AWS APIs: a Rust program serving
 * SigV4-only HTTPS on `127.0.0.1:9297`. It is the first plausible way to exercise the AWS half of
 * the deploy checks — the places where this repository talks to Lambda, SQS, SNS and SES —
 * without a cloud account. The question here is narrower than "is the emulator good": **for each
 * AWS operation our code calls, can the emulator run it, or does it answer 501?**
 *
 * That is a question about two published artefacts, not an opinion:
 *
 *   · the **table** below — one row per AWS operation this repository calls, naming the file and
 *     function that calls it, the call as our code writes it, the emulator's handler file at a
 *     pinned release, and what that means;
 *   · the emulator's **source at that release**. [`selectorsIn`] derives the first line of code
 *     in each handler, [`verdictFor`] maps it to a verdict, and [`crossCheck`] compares the two —
 *     so the table cannot drift from the evidence without a reader seeing the disagreement.
 *
 * ## Why a verdict and not a fidelity score
 *
 * The emulator publishes a fidelity percentage per service with every release (`scores.json.gz`
 * on the releases page) and reports 56.6% overall at v1.0.322. A percentage does not answer our
 * question: SQS at 89.8% can still miss the behaviour our driver depends on, and SES v1 can score
 * well while we only ever call SES v2. The unit that matters is the operation, in the shape of
 * *our* call.
 *
 * ## The four verdicts
 *
 *   · `served` — the handler body is written: it does something and answers from state.
 *   · `written-refusal` — the body is written and answers 501 *by design* for a request member our
 *     call does not send. `SendEmail` refuses to read the sender out of a raw MIME `From` header;
 *     our transport always sends `FromEmailAddress`, so the refusal is not reached.
 *   · `stub` — the body is the scaffold's `not_implemented(...)` or an empty
 *     `Ok(Self::Output::default())`. Every request answers 501 ("scaffolded but not implemented")
 *     or a hollow success; no behaviour can be judged from it.
 *   · `absent` — no handler file at all: the operation is not in the service's allow-list, and the
 *     framework answers 501 (awsJson) or 404 (rpcv2Cbor) before any handler is reached.
 *
 * `stub` and `absent` both answer 501 for awsJson services, and the emulator's own runtime says
 * not to tell them apart by status — "a consumer tallying unimplemented operations must key on
 * that message". This file keys on the source instead, because the message is the same.
 *
 * ## What no verdict here can mean
 *
 * **A verdict is not an acceptance.** No row in this table discharges C3, C4 or C5, and the
 * reason is not that the emulator is thin — it is that two of the three checks are about things a
 * local emulator cannot hold:
 *
 *   · **C5 (`sam validate --lint`, `sam deploy --no-execute-changeset`)** is a `sam` question
 *     about a template file. The emulator answers AWS APIs; it does not read CloudFormation or SAM
 *     templates, and nothing here changes that.
 *   · **C4 (`initDuration`)** is a measurement of the real Lambda service's cold start. The
 *     emulator runs a handler in-process in QuickJS and reports no `initDuration` — a number from
 *     it would be a number about this machine.
 *   · **C3 (the invoke paths)** is the one the emulator moves, and it moves it a long way:
 *     `Invoke` is implemented and RUNS the function, the SQS event source mapping is really polled
 *     (with `ReportBatchItemFailures` read), and an EventBridge schedule rule really fires and
 *     delivers a scheduled event. What it still cannot show is that *a deploy bundle runs*: the
 *     `nodejs*` runtime is QuickJS with a curated set of core modules (`path`, `util`, `events`,
 *     `buffer`, `crypto`, `fs`, `streams`, `timers`, `os`, `assert`, `url`, …) and **no `net`,
 *     `http`, `https` or `worker_threads`**. A bundle that reaches the network at import time dies
 *     on a module the emulator does not supply. That is a real constraint on our bundle and worth
 *     measuring — but until it is measured once against a real function, C3 stays open.
 *
 * So the honest use of this emulator is: it is the first way to exercise the *control plane* —
 * SQS's own lifecycle through our driver, SES's own identity rule in front of our transport, and
 * the event-source and schedule wiring our template declares — without an account. It is not a
 * substitute for a deployed invoke, and `deploy invoke` remains the only local proof that a
 * bundle answers an event.
 *
 * ## Why the conformance kit is not run here
 *
 * `conformanceCases` looks like the obvious thing to point at the emulator, and it cannot be: the
 * kit pushes messages whose `availableAt` is a fixed virtual instant (`START`, epoch 1_000_000) and
 * then reserves at `START + 5_000`, which against a real broker is "not yet due" and "five seconds
 * ago" at the same wall-clock moment. Its retry case also asserts that `lastError` survives a
 * failed attempt, which is true of a driver that rewrites the body and false of
 * `ChangeMessageVisibility`, which is all SQS offers. Two of its `platform` cases additionally
 * need the dead-letter store that only `sql` supplies, which the probe does not carry. Run against
 * any real platform, the kit reports its own clock assumptions as driver defects.
 *
 * That is a finding about the kit, not about SQS, and it is written down — with the four limits
 * above — in the AWS Emulator review of 2026-11-13 rather than papered over. The probe drives
 * the lifecycle directly instead, and the kit keeps doing what it does well: holding fake
 * platforms to the port's rules.
 *
 * ## Using it
 *
 *   `tsir deploy:verify` — the table, the cross-check when `AWS_EMULATOR_SRC` names a
 *   checkout, and the probe when an emulator is running. `--json` prints the same as data.
 *
 * An absent emulator prints how to start one and exits 0: it is not a repository defect. The one
 * thing that fails the command is a call in `src/` with no row here ([`coverageProblems`]) — the
 * table is only worth reading while it is complete.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The four call sites this table is about, imported the way any other command imports the packages
// it drives. These are real dependencies of `@tsir/console` (not of `@tsir/deploy`), which is the
// reason this module lives here: a check that must run from the distribution cannot depend on
// another package's `src/`.
import { sqsDriver, sqsClientOf } from '@tsir/queue/sqs';
import type { SqsLike, SqsReceiveInput, SqsSendInput } from '@tsir/queue/sqs';
import { sesTransport } from '@tsir/mail';
import type { MailMessage } from '@tsir/mail';
import { signRequest } from '@tsir/storage';

import { jsonDocument } from '../output.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The table
 * ──────────────────────────────────────────────────────────────────────────── */

/** The verdicts, strongest evidence first. See the module comment for what each one means. */
export type Verdict = 'served' | 'written-refusal' | 'stub' | 'absent';

/** The emulator release every row was read against. A different tag is a different answer. */
export const EMULATOR_RELEASE = 'v1.0.341';

/**
 * This module's own path, and the `ours.path` of every row the probe performs.
 *
 * Named once because it appears in three places that must agree: the rows below, the scan that
 * skips this file (it names clients to *describe* them and calls none), and the summary that
 * separates "the framework calls" from "the probe calls".
 */
const EMULATOR_SELF = 'src/framework/console/src/commands/emulator.ts';

/**
 * The vendored handler files the verdicts are checked against, at `EMULATOR_RELEASE`.
 *
 * Beside this module rather than under a repository-level `tools/` tree, so the table and the
 * evidence that proves it are one artefact with one owner. They are **not** shipped: `check-dist`
 * forbids a `fixtures` directory in the distribution, and rightly so — an application has no
 * emulator checkout to re-derive verdicts from. `report()` therefore cross-checks only when
 * `AWS_EMULATOR_SRC` names a source tree; the table itself prints anywhere.
 *
 * 13 handler files, ~512 kB, CC0 — each keeps its own `SPDX-License-Identifier` line, which
 * `check-license` reads and honours.
 */
export const FIXTURE_ROOT = join(import.meta.dir, 'fixtures', 'aws-emulator');

export interface OperationRow {
  /** The emulator's crate directory for the service. */
  readonly crate: string;
  /** The operation, as the SDK and the Smithy model name it. */
  readonly operation: string;
  /** Where *we* call it: the file, and the symbol inside it. */
  readonly ours: { readonly path: string; readonly function: string };
  /** The call as our code writes it: the members we actually send. */
  readonly shape: string;
  /** The emulator handler file, relative to the crate's `src/ops/`, or `undefined` when absent. */
  readonly handler: string | undefined;
  /** Bytes of that handler at `EMULATOR_RELEASE`; `0` when absent. */
  readonly bytes: number;
  readonly verdict: Verdict;
  /** One line of why, in the reader's terms. */
  readonly note: string;
}

/**
 * Every AWS operation this repository calls, at `EMULATOR_RELEASE`.
 *
 * "Every" is checkable: [`awsSurface`] scans `src/` for the SDK packages and wire calls we make,
 * and [`coverageProblems`] fails when a called operation has no row here. A new SDK call therefore
 * cannot be added without saying what the emulator can do with it.
 */
export const OPERATIONS: readonly OperationRow[] = [
  {
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    operation: 'SendMessage',
    ours: { path: 'src/framework/queue/src/drivers/sqs.ts', function: 'sqsDriver → backend.push' },
    shape:
      'QueueUrl, MessageBody (the driver’s JSON), and DelaySeconds only when the job is not due yet; MessageGroupId and MessageDeduplicationId on FIFO',
    handler: 'send_message.rs',
    bytes: 31297,
    verdict: 'served',
    note: 'Written: empty-body refusal, allowed-character check, then the store. The driver sends the ordinary shapes.',
  },
  {
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    operation: 'ReceiveMessage',
    ours: {
      path: 'src/framework/queue/src/drivers/sqs.ts',
      function: 'sqsDriver → backend.reserve',
    },
    shape:
      'QueueUrl, MaxNumberOfMessages ≤ 10, WaitTimeSeconds, VisibilityTimeout = lease/1000, AttributeNames: [ApproximateReceiveCount]',
    handler: 'receive_message.rs',
    bytes: 44470,
    verdict: 'served',
    note: 'The largest handler in the service: visibility windows, the long-poll wait, and the attribute the driver reads its attempt count from.',
  },
  {
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    operation: 'DeleteMessage',
    ours: {
      path: 'src/framework/queue/src/drivers/sqs.ts',
      function: 'sqsDriver → backend.complete, and the malformed-body branch of reserve',
    },
    shape: 'QueueUrl, ReceiptHandle',
    handler: 'delete_message.rs',
    bytes: 13713,
    verdict: 'served',
    note: 'Written, and the receipt handle is resolved against the queue it came from — the driver deletes with the handle it was given.',
  },
  {
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    operation: 'ChangeMessageVisibility',
    ours: {
      path: 'src/framework/queue/src/drivers/sqs.ts',
      function: 'sqsDriver → backend.fail (retryAt set)',
    },
    shape: 'QueueUrl, ReceiptHandle, VisibilityTimeout = the retry delay in seconds',
    handler: 'change_message_visibility.rs',
    bytes: 17750,
    verdict: 'served',
    note: 'Written, and out-of-range timeouts are refused with the modelled parameter error. The driver relies on the platform scheduling the retry this way.',
  },
  {
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    operation: 'CreateQueue',
    ours: {
      path: 'src/framework/console/src/commands/emulator.ts',
      function: 'probe — queue setup only',
    },
    shape: 'QueueName',
    handler: 'create_queue.rs',
    bytes: 24249,
    verdict: 'served',
    note: 'Written: queue-name rules, FIFO designation from attributes, `QueueNameExists`. Setup only — nothing in the framework creates queues at runtime.',
  },
  {
    crate: 'service-com-amazonaws-sesv2-simpleemailservice-v2',
    operation: 'SendEmail',
    ours: { path: 'src/framework/mail/src/transports/ses.ts', function: 'sesTransport → send' },
    shape:
      'FromEmailAddress, Destination.To/Cc/BccAddresses, Content.Raw.Data (base64 MIME), ReplyToAddresses, EmailTags',
    handler: 'send_email.rs',
    bytes: 30859,
    verdict: 'written-refusal',
    note: 'Written, with two 501s by design: a sender read only from the raw MIME `From` header, and a recipient list only in the MIME headers. We send both in the request, so neither is reached. It does enforce SES’s own verified-identity rule, so the transport cannot send until the identity exists.',
  },
  {
    crate: 'service-com-amazonaws-sesv2-simpleemailservice-v2',
    operation: 'CreateEmailIdentity',
    ours: {
      path: 'src/framework/console/src/commands/emulator.ts',
      function: 'probe — SES setup only',
    },
    shape: 'EmailIdentity (the address our transport will send from)',
    handler: 'create_email_identity.rs',
    bytes: 19700,
    verdict: 'served',
    note: 'Written, and not optional: `SendEmail` refuses an unverified identity, so a probe that skips this measures the refusal and not the transport.',
  },
  {
    crate: 'service-com-amazonaws-sns-amazonsimplenotificationservice',
    operation: 'Publish',
    ours: { path: 'src/framework/deploy/src/internal.ts', function: 'internalTransport → publish' },
    shape: 'TopicArn, Message',
    handler: 'publish.rs',
    bytes: 91293,
    verdict: 'served',
    note: 'Written — the largest handler in the emulator. It still cannot reach *our* Lambda: a subscription delivers to a function the emulator refuses to invoke, so a fan-out stops at the subscription.',
  },
  {
    crate: 'service-com-amazonaws-sns-amazonsimplenotificationservice',
    operation: 'ListTopics',
    ours: {
      path: 'src/framework/deploy/src/internal.ts',
      function: 'internalTransport → listTopics',
    },
    shape: 'no members',
    handler: 'list_topics.rs',
    bytes: 8377,
    verdict: 'served',
    note: 'Written. One of the Unit-input operations the scaffold declined and a human wrote out — the crate’s `src/ops/SKIPPED_STUBS.md` records the hand-authoring.',
  },
  {
    crate: 'service-com-amazonaws-lambda-awsgirapiservice',
    operation: 'Invoke',
    ours: { path: 'src/framework/deploy/src/internal.ts', function: 'internalTransport → invoke' },
    shape: 'FunctionName, InvocationType, Payload — a synchronous invoke of a deployed function',
    handler: 'invoke.rs',
    bytes: 74487,
    verdict: 'served',
    note: 'Written, and it RUNS the handler: the python* and nodejs* runtimes execute in-process (QuickJS for nodejs, whose module loader resolves ESM and CommonJS inside the deployment package). That makes a Lambda bundle actually executable here — see the four limits below, which are what keep C3 open.',
  },
  {
    crate: 'service-com-amazonaws-lambda-awsgirapiservice',
    operation: 'CreateFunction',
    ours: {
      path: 'src/framework/console/src/commands/emulator.ts',
      function: 'probe — would create the unit’s function',
    },
    shape:
      'FunctionName, Runtime nodejs22.x, Handler, Code.ZipFile (the deploy bundle), Role, Timeout, Environment.Variables',
    handler: 'create_function.rs',
    bytes: 49691,
    verdict: 'served',
    note: 'Written. A function exists before `Invoke` can resolve it, exactly as on AWS, so any real probe starts here.',
  },
  {
    crate: 'service-com-amazonaws-lambda-awsgirapiservice',
    operation: 'CreateEventSourceMapping',
    ours: {
      path: 'src/framework/console/src/commands/emulator.ts',
      function: 'probe — the SQS trigger the template declares',
    },
    shape:
      'EventSourceArn, FunctionName, BatchSize, FunctionResponseTypes: [ReportBatchItemFailures]',
    handler: 'create_event_source_mapping.rs',
    bytes: 58372,
    verdict: 'served',
    note: 'Written, and a poller really reads the queue and hands the batch to the function. `ReportBatchItemFailures` is read, so a partial-batch failure is judged from the response rather than from whether the invoke threw.',
  },
  {
    crate: 'service-com-amazonaws-eventbridge-awsevents',
    operation: 'PutRule',
    ours: {
      path: 'src/framework/console/src/commands/emulator.ts',
      function: 'probe — the schedule the template declares',
    },
    shape: 'Name, ScheduleExpression (cron or rate)',
    handler: 'put_rule.rs',
    bytes: 22684,
    verdict: 'served',
    note: 'Written, and a schedule rule fires on its own clock and delivers EventBridge’s scheduled-event envelope to its target — which is the schedule trigger our Lambda adapter has to recognise.',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Reading the emulator's source
 * ──────────────────────────────────────────────────────────────────────────── */

/** True when `text` carries a line of code, as opposed to a comment, attribute or blank. */
export function isCodeLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  return !(t.startsWith('//') || t.startsWith('#[') || t.startsWith('/*') || t.startsWith('*'));
}

/**
 * The first line of code in the BODY of the last `fn handle` in a handler file.
 *
 * The signature is skipped by counting braces from the `fn handle(` line to the one that opens
 * the body, because the scaffold writes it across four lines and its continuation lines (`&self,`
 * `input: Self::Input,`) are code by any lexical test. Missing that is not hypothetical: the first
 * version of this function reported `&self,` for every handler and so called a working `Invoke`
 * unimplemented — see the AWS Emulator review of 2026-11-13, finding 1.
 *
 * The line it lands on is what separates the verdicts, because the scaffolder is deterministic
 * about what it leaves: a written handler opens with something that reads or checks the request
 * (`if input.…`, `let region = …`, `let Some(state) = …`); an unwritten one opens with
 * `not_implemented(...)` — sometimes after the `let _ = (&input, ctx);` a Unit-input scaffold keeps
 * — or with `Ok(Self::Output::default())`. `undefined` means no `fn handle` at all.
 */
export function selectorsIn(source: string): string | undefined {
  const lines = source.split('\n');
  let signature = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').includes('fn handle')) signature = index;
  }
  if (signature === -1) return undefined;

  // The line that opens the body: the first one where the signature's brace depth becomes 1.
  let depth = 0;
  let bodyStart = -1;
  for (let index = signature; index < lines.length && bodyStart === -1; index += 1) {
    for (const character of lines[index] ?? '') {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
    }
    if (depth > 0) bodyStart = index;
  }
  if (bodyStart === -1) return undefined;

  // `fn handle(...) {` puts the first statement on the following line; a body that opens on a
  // `fn handle(` continuation puts it after that line too, because the `{` ends its line.
  for (const line of lines.slice(bodyStart + 1)) {
    if (isCodeLine(line)) return line.trim();
  }
  return undefined;
}

/** A body that succeeds without doing anything. */
const HOLLOW = /^Ok\(\s*(Self::Output::)?default\(\)\s*\)/u;
/** The scaffold's refusal, directly or through the service's wrapper. */
const REFUSAL = /(not_implemented\s*\(|scaffolded::)/u;
/** The `let _ = (&input, ctx);` a Unit-input scaffold places before whatever follows it. */
const UNIT_INPUT = /^let _ ?= ?\(?&input, ?&?ctx\)?;?$/u;

/**
 * The verdict a handler's first code line implies, or `written`/`unknown` when only a reader can
 * judge the rest — a written body whose *refusals* decide the answer, which is the `SendEmail` row.
 */
export function verdictFor(firstCodeLine: string | undefined): Verdict | 'written' | 'unknown' {
  if (firstCodeLine === undefined) return 'absent';
  if (REFUSAL.test(firstCodeLine)) return 'stub';
  if (HOLLOW.test(firstCodeLine)) return 'stub';
  if (UNIT_INPUT.test(firstCodeLine)) return 'unknown';
  return 'written';
}

export interface CrossCheck {
  readonly operation: string;
  readonly claimed: Verdict;
  readonly derived: Verdict | 'written' | 'unknown';
  /** `agrees` — the source says what the row says. `reviewed` — the row needed a reader. */
  readonly outcome: 'agrees' | 'reviewed' | 'disagrees';
  readonly firstCodeLine: string | undefined;
  /** `undefined` when the claimed size matches; otherwise `claimed → actual`. */
  readonly sizeMismatch: string | undefined;
}

/** The rule, stated once: what a row may claim, given what its handler's first code line derives. */
export function agreesWith(claimed: Verdict, derived: Verdict | 'written' | 'unknown'): boolean {
  if (derived === 'unknown') return true;
  if (claimed === 'served' || claimed === 'written-refusal') return derived === 'written';
  if (claimed === 'stub') return derived === 'stub';
  // `absent` is derived from a missing file; a present-but-hollow one is the same fact on the wire.
  return derived === 'absent' || derived === 'stub';
}

/**
 * Re-derive every verdict and every size from a checkout of the emulator at `EMULATOR_RELEASE`.
 *
 * It reads `services/<crate>/src/ops/<handler>` only — not the whole tree — so a shallow checkout
 * of `services/` is enough, which is what a CI job would fetch.
 */
export function crossCheck(root: string = FIXTURE_ROOT): readonly CrossCheck[] {
  return OPERATIONS.map((row) => {
    const dir = join(root, 'services', row.crate, 'src', 'ops');
    const file = row.handler === undefined ? undefined : join(dir, row.handler);
    const present = file !== undefined && existsSync(file);
    const source = present ? readFileSync(file, 'utf8') : undefined;
    const firstCodeLine = source === undefined ? undefined : selectorsIn(source);
    const derived: Verdict | 'written' | 'unknown' =
      source === undefined ? 'absent' : verdictFor(firstCodeLine);
    const actual = present ? statSync(file).size : 0;
    return {
      operation: row.operation,
      claimed: row.verdict,
      derived,
      outcome: agreesWith(row.verdict, derived)
        ? derived === 'written' || derived === 'unknown'
          ? 'reviewed'
          : 'agrees'
        : 'disagrees',
      firstCodeLine,
      sizeMismatch: actual === row.bytes ? undefined : `${String(row.bytes)} → ${String(actual)}`,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. What our own source calls
 * ──────────────────────────────────────────────────────────────────────────── */

/** The SDK client modules, the crate their operations live in, and the command prefix they use. */
const SDK_PACKAGES: readonly {
  readonly pattern: RegExp;
  readonly crate: string;
  readonly prefix: string;
}[] = [
  {
    pattern: /@aws-sdk\/client-sqs\b/u,
    crate: 'service-com-amazonaws-sqs-amazonsqs',
    prefix: 'SQS',
  },
  {
    pattern: /@aws-sdk\/client-sesv2\b/u,
    crate: 'service-com-amazonaws-sesv2-simpleemailservice-v2',
    prefix: 'SESv2',
  },
  {
    pattern: /@aws-sdk\/client-ses\b/u,
    crate: 'service-com-amazonaws-ses-simpleemailservice',
    prefix: 'SES',
  },
  {
    pattern: /@aws-sdk\/client-sns\b/u,
    crate: 'service-com-amazonaws-sns-amazonsimplenotificationservice',
    prefix: 'SNS',
  },
  {
    pattern: /@aws-sdk\/client-lambda\b/u,
    crate: 'service-com-amazonaws-lambda-awsgirapiservice',
    prefix: 'Lambda',
  },
];

export interface SurfaceFinding {
  readonly path: string;
  /** `<crate>:<Operation>` — the emulator-side identity of the call. */
  readonly operation: string;
}

/** The command-class suffix every AWS SDK v3 command carries. */
const COMMAND_SUFFIX = 'Command';

/** The crates whose clients a file imports. Exported because it is the half worth testing alone. */
export function observedCrates(
  text: string,
): readonly { readonly crate: string; readonly prefix: string }[] {
  return SDK_PACKAGES.filter((entry) => entry.pattern.test(text)).map(({ crate, prefix }) => ({
    crate,
    prefix,
  }));
}

export interface SurfaceFinding {
  readonly path: string;
  /** `<crate>:<Operation>` — the emulator-side identity of the call. */
  readonly operation: string;
  /**
   * True when the file imports more than one AWS client and the command sat on a line that named
   * none of them. The call is real; which service it belongs to is then a guess, so the scan says
   * so rather than picking one.
   */
  readonly ambiguous?: boolean;
}

/**
 * Every AWS operation `src/` calls, found two ways because our call sites use two shapes:
 *
 *   · **the SDK** — a command class such as `new PublishCommand(…)`. The class name carries NO
 *     service prefix (`PublishCommand`, not `SNSPublishCommand`), so the service comes from the
 *     import statement the command is destructured from, and otherwise from the single client the
 *     file imports. A file that imports two clients and names a command on neither's line is
 *     reported `ambiguous` rather than attributed by guesswork — the first version of this scan
 *     assumed a prefix, matched nothing at all, and reported the repository as calling only SES.
 *   · **the wire** — a service we call by hand. `src/framework/mail/src/transports/ses.ts` posts
 *     SES v2's `/v2/email/outbound-emails` itself, so there is no SDK import to find and the
 *     operation is only visible in the path it posts to.
 *
 * Scanning is textual on purpose: a scan that needed the type checker would only run when
 * `make check` runs, and this has to answer "what would the emulator have to serve" in a checkout
 * that cannot install its dependencies. This file is skipped: it names client modules and the SES
 * path to describe them, and it calls none of them.
 */
export function awsSurface(
  files: readonly { readonly path: string; readonly text: string }[],
): readonly SurfaceFinding[] {
  const found: SurfaceFinding[] = [];
  const add = (path: string, operation: string, ambiguous = false): void => {
    if (!found.some((entry) => entry.path === path && entry.operation === operation)) {
      found.push({ path, operation, ...(ambiguous ? { ambiguous: true } : {}) });
    }
  };

  for (const file of files) {
    if (
      file.path.endsWith(EMULATOR_SELF) ||
      file.path.endsWith('.d.ts') ||
      file.path.endsWith('.test.ts')
    ) {
      continue;
    }

    const crates = observedCrates(file.text);
    /** Commands whose service the file's own import statement names. */
    const attributed = new Map<string, string>();
    for (const line of file.text.split('\n')) {
      const onThisLine = SDK_PACKAGES.filter((entry) => entry.pattern.test(line));
      if (onThisLine.length !== 1) continue;
      const crate = onThisLine[0]?.crate;
      if (crate === undefined) continue;
      for (const match of line.matchAll(/\b([A-Z]\w+)Command\b/gu)) {
        const operation = match[1];
        if (operation !== undefined) attributed.set(`${operation}${COMMAND_SUFFIX}`, crate);
      }
    }

    for (const match of file.text.matchAll(/\b([A-Z]\w+)Command\b/gu)) {
      // The capture is already the operation: the literal `Command` after it is the suffix.
      const operation = match[1];
      if (operation === undefined || operation === COMMAND_SUFFIX) continue;
      const name = `${operation}${COMMAND_SUFFIX}`;
      const exact = attributed.get(name);
      if (exact !== undefined) {
        add(file.path, `${exact}:${operation}`);
        continue;
      }
      if (crates.length === 1) {
        const only = crates[0];
        if (only !== undefined) add(file.path, `${only.crate}:${operation}`);
        continue;
      }
      for (const crate of crates) add(file.path, `${crate.crate}:${operation}`, true);
    }

    // The one hand-written AWS call: SES v2 SendEmail at /v2/email/outbound-emails.
    if (/email\/outbound-emails/u.test(file.text)) {
      add(file.path, 'service-com-amazonaws-sesv2-simpleemailservice-v2:SendEmail');
    }
  }
  return found;
}

/**
 * Every called operation has a row in [`OPERATIONS`]. Sorted, so the message is stable.
 *
 * An `ambiguous` finding is one call whose service the scan could not name; it is covered when
 * any of its candidate services has the row, and reported with its candidates when none does.
 */
export function coverageProblems(surface: readonly SurfaceFinding[]): readonly string[] {
  const rows = new Set(OPERATIONS.map((row) => `${row.crate}:${row.operation}`));
  const missing = new Map<string, Set<string>>();
  const ambiguous = new Map<string, SurfaceFinding[]>();

  for (const call of surface) {
    if (call.ambiguous === true) {
      const operation = call.operation.slice(call.operation.indexOf(':') + 1);
      const group = ambiguous.get(`${call.path}#${operation}`) ?? [];
      group.push(call);
      ambiguous.set(`${call.path}#${operation}`, group);
      continue;
    }
    if (!rows.has(call.operation)) missing.set(call.operation, new Set([call.path]));
  }

  for (const group of ambiguous.values()) {
    if (group.some((entry) => rows.has(entry.operation))) continue;
    const first = group[0];
    if (first === undefined) continue;
    const operation = first.operation.slice(first.operation.indexOf(':') + 1);
    const candidates = group.map((entry) => entry.operation.slice(0, entry.operation.indexOf(':')));
    missing.set(`${operation} (could be ${candidates.join(' or ')})`, new Set([first.path]));
  }

  return [...missing.entries()]
    .map(([operation, paths]) => `${operation} (called from ${[...paths].join(', ')})`)
    .sort();
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. The live probe
 * ──────────────────────────────────────────────────────────────────────────── */

export const EMULATOR_HOME = join('.aws', 'emulator');
export const DEFAULT_PORT = 9297;

export interface EmulatorSetup {
  readonly endpoint: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** PEM the client must trust: `ca_bundle` in the shared config the emulator writes. */
  readonly caBundle: string | undefined;
}

/**
 * Read the setup the emulator leaves in its home folder: an ini carrying the generated key pair
 * and a PEM certificate authority beside it, under `<home>/.aws/emulator/<port>/`.
 *
 * The file names are discovered rather than assumed — the ini is whichever file in that directory
 * carries `aws_access_key_id`, and the CA is the single `*.pem` or `*.crt`. The documentation site
 * is not reachable from this sandbox, so the only honest options are to read the layout from the
 * source (which writes the ini and the CA into one directory) or to guess; this does the former and
 * gives up cleanly when the directory is absent.
 */
export function readSetup(home: string, port: number = DEFAULT_PORT): EmulatorSetup | undefined {
  const dir = join(home, EMULATOR_HOME, String(port));
  if (!existsSync(dir)) return undefined;

  const entries = readdirSync(dir);
  const certificate = entries.find((name) => name.endsWith('.pem') || name.endsWith('.crt'));

  for (const name of entries) {
    const candidate = join(dir, name);
    if (statSync(candidate).isDirectory()) continue;
    let text: string;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const values: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = /^([A-Za-z_]+)\s*=\s*(.+)$/u.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].trim();
    }
    const accessKeyId = values['aws_access_key_id'];
    const secretAccessKey = values['aws_secret_access_key'];
    if (accessKeyId === undefined || secretAccessKey === undefined) continue;
    return {
      endpoint: `https://127.0.0.1:${String(port)}`,
      credentials: { accessKeyId, secretAccessKey },
      caBundle: certificate === undefined ? undefined : join(dir, certificate),
    };
  }
  return undefined;
}

export interface ProbeStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ProbeResult {
  /** Set when there is nothing to run; `steps` is then empty and this is not a failure. */
  readonly skipped?: string;
  readonly steps: readonly ProbeStep[];
  /** The emulator's own answer for the operation C3 depends on. */
  readonly refusals: readonly string[];
}

/** One SigV4-signed awsJson 1.0 POST — the protocol SQS and SES v2 share. */
async function callAwsJson(
  doFetch: typeof fetch,
  setup: EmulatorSetup,
  service: string,
  target: string,
  operation: string,
  input: Record<string, unknown>,
  path = '/',
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(input);
  const url = `${setup.endpoint}${path}`;
  const headers = await signRequest({
    method: 'POST',
    url,
    service,
    region: 'us-east-1',
    credentials: setup.credentials,
    date: Date.now(),
    headers:
      path === '/'
        ? { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `${target}.${operation}` }
        : { 'content-type': 'application/json' },
    body: new TextEncoder().encode(body),
  });
  const response = await doFetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    throw new Error(`${operation} answered HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** The `SqsLike` the driver requires, built on our own SigV4 and one HTTP call per member. */
export function liveSqsClient(setup: EmulatorSetup, doFetch: typeof fetch = fetch): SqsLike {
  return sqsClientOf(
    {
      send: async (command: unknown) => {
        const { target, input } = command as {
          readonly target: string;
          readonly input: Record<string, unknown>;
        };
        return callAwsJson(doFetch, setup, 'sqs', 'AmazonSQS', target, input);
      },
    },
    {
      SendMessageCommand: sdkCommand<SqsSendInput>('SendMessage'),
      ReceiveMessageCommand: sdkCommand<SqsReceiveInput>('ReceiveMessage'),
      DeleteMessageCommand: sdkCommand<Record<string, unknown>>('DeleteMessage'),
      ChangeMessageVisibilityCommand:
        sdkCommand<Record<string, unknown>>('ChangeMessageVisibility'),
    },
  );
}

/** A stand-in for an SDK command object: the client above reads `.target` and `.input`. */
function sdkCommand<Input>(operation: string): new (input: Input) => unknown {
  return class {
    readonly target = operation;
    constructor(readonly input: Input) {}
  };
}

/** The message the probe sends: the transport's real composer runs, so the MIME is the product's. */
const PROBE_MESSAGE: MailMessage = {
  from: { email: 'probe@tsir.test' },
  to: [{ email: 'to@tsir.test' }],
  subject: 'AWS Emulator probe',
  text: 'Sent by tsir deploy:verify through the ses transport.',
};

/**
 * Exercise the two AWS paths the framework really owns, against a running emulator.
 *
 * The queue half is the driver's own lifecycle — push → reserve → complete, a message held
 * invisible, and a body the driver did not write, which it must delete rather than redeliver
 * forever. The mail half is the transport's own `send`, after creating the identity SES requires.
 * The Lambda half is measured by refusal: a synchronous `Invoke` is what C3 depends on, and the
 * emulator's answer is the evidence that C3 cannot move here.
 */
export async function probe(
  setup: EmulatorSetup | undefined,
  options: { readonly fetch?: typeof fetch } = {},
): Promise<ProbeResult> {
  if (setup === undefined) {
    return {
      skipped: `no emulator credentials under ~/${EMULATOR_HOME}/<port>/ — start one with \`aws-emulator --telemetry off\``,
      steps: [],
      refusals: [],
    };
  }
  const doFetch = options.fetch ?? fetch;
  const steps: ProbeStep[] = [];
  const refusals: string[] = [];
  const record = async (step: string, run: () => Promise<string>): Promise<boolean> => {
    try {
      steps.push({ step, ok: true, detail: await run() });
      return true;
    } catch (error: unknown) {
      steps.push({
        step,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const health = await doFetch(`${setup.endpoint}/__admin/health`).catch((error: unknown) => error);
  if (health instanceof Error) {
    return {
      skipped: `emulator not answering at ${setup.endpoint} (${health.message})`,
      steps,
      refusals,
    };
  }
  steps.push({ step: 'health', ok: true, detail: `${setup.endpoint}/__admin/health` });

  const queueName = `tsir-probe-${String(Date.now())}`;
  let queueUrl = '';
  const created = await record('CreateQueue', async () => {
    const answer = await callAwsJson(doFetch, setup, 'sqs', 'AmazonSQS', 'CreateQueue', {
      QueueName: queueName,
    });
    const url = answer['QueueUrl'];
    if (typeof url !== 'string' || url === '') {
      // A probe step's own failure: `record()` below turns it into a step detail the user reads,
      // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(`no QueueUrl in the answer: ${JSON.stringify(answer).slice(0, 200)}`);
    }
    queueUrl = url;
    return url;
  });
  if (!created) return { steps, refusals };

  // The driver, opened once: its receipt handles live on the backend it opened them on.
  const backend = sqsDriver({ client: liveSqsClient(setup, doFetch), queueUrl }).open();
  const jobMessage = {
    id: 'probe-round-trip',
    name: 'Probe',
    payload: '{"ok":true}',
    connection: 'probe',
    attempts: 0,
    maxAttempts: 3,
    availableAt: 0,
    createdAt: 0,
  } as const;

  await record('push → reserve → complete', async () => {
    await backend.push({ ...jobMessage });
    const reserved = await backend.reserve({
      connection: 'probe',
      limit: 1,
      now: Date.now(),
      leaseMs: 30_000,
    });
    const first = reserved[0];
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (first === undefined) throw new Error('nothing was reservable after a push');
    if (first.attempts !== 1) {
      // A probe step's own failure: `record()` below turns it into a step detail the user reads,
      // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(
        `attempts is ${String(first.attempts)}; the worker does not increment, so this must be 1`,
      );
    }
    if (first.payload !== jobMessage.payload)
      // A probe step's own failure: `record()` below turns it into a step detail the user reads,
      // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
      // eslint-disable-next-line no-restricted-syntax
      throw new Error('the payload did not survive the round trip');
    await backend.complete(first);
    const again = await backend.reserve({
      connection: 'probe',
      limit: 1,
      now: Date.now(),
      leaseMs: 30_000,
    });
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (again.length !== 0) throw new Error('a completed message was delivered again');
    return `attempts=${String(first.attempts)}, payload intact, gone after complete`;
  });

  await record('a reserved message is invisible until its lease lapses', async () => {
    await backend.push({ ...jobMessage, id: 'probe-invisible' });
    const [reserved] = await backend.reserve({
      connection: 'probe',
      limit: 1,
      now: Date.now(),
      leaseMs: 30_000,
    });
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (reserved === undefined) throw new Error('nothing reserved for the visibility step');
    const seen = await backend.reserve({
      connection: 'probe',
      limit: 10,
      now: Date.now(),
      leaseMs: 30_000,
    });
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (seen.length !== 0) throw new Error('the leased message was delivered to a second reserve');
    return 'a 30 s lease held for the second reserve';
  });

  await record('a body the driver did not write is deleted, not redelivered', async () => {
    const foreign = `not the driver's JSON ${String(Date.now())}`;
    await callAwsJson(doFetch, setup, 'sqs', 'AmazonSQS', 'SendMessage', {
      QueueUrl: queueUrl,
      MessageBody: foreign,
    });
    const claimed = await backend.reserve({
      connection: 'probe',
      limit: 10,
      now: Date.now(),
      leaseMs: 30_000,
    });
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (claimed.length !== 0) throw new Error('a body the driver did not write became a job');
    const left = await callAwsJson(doFetch, setup, 'sqs', 'AmazonSQS', 'ReceiveMessage', {
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 30,
    });
    const bodies = (
      (left['Messages'] as readonly { readonly Body?: string }[] | undefined) ?? []
    ).map((entry) => entry.Body);
    // A probe step's own failure: `record()` below turns it into a step detail the user reads,
    // not an error that escapes this module — hence no TsirError code (ERR-003's boundary).
    // eslint-disable-next-line no-restricted-syntax
    if (bodies.includes(foreign)) throw new Error('the foreign body is still in the queue');
    return 'dropped, and the queue no longer holds it';
  });

  await record('CreateEmailIdentity', async () => {
    await callAwsJson(doFetch, setup, 'ses', 'SimpleEmailService_v2', 'CreateEmailIdentity', {
      EmailIdentity: PROBE_MESSAGE.from.email,
    });
    return PROBE_MESSAGE.from.email;
  });

  await record('ses transport send', async () => {
    const transport = sesTransport({
      region: 'us-east-1',
      credentials: setup.credentials,
      endpoint: `${setup.endpoint}/v2/email/outbound-emails`,
    });
    const delivered = await transport.send(PROBE_MESSAGE);
    return `MessageId ${delivered.id}`;
  });

  // ── the invoke path C3 needs, when a bundle is on hand ────────────────────
  //
  // `Invoke` really runs a handler here, so it is worth measuring — but the artifact is the
  // caller's: a zip of a `nodejs22.x` bundle. The probe takes its path from `TSIR_LAMBDA_ZIP`
  // rather than building one, because which unit to ship is a `deploy:build` decision, not a
  // probe's. Without it the step says so rather than inventing a function.
  const zip = process.env['TSIR_LAMBDA_ZIP'];
  if (zip === undefined || !existsSync(zip)) {
    steps.push({
      step: 'lambda Invoke',
      ok: true,
      detail:
        'skipped — set TSIR_LAMBDA_ZIP to a nodejs22.x bundle (a zip whose index.mjs exports handler) to measure the invoke path',
    });
  } else {
    await record('lambda Invoke', async () => {
      const functionName = 'tsir-probe';
      await callAwsJson(
        doFetch,
        setup,
        'lambda',
        'Lambda',
        'CreateFunction',
        {
          FunctionName: functionName,
          Runtime: 'nodejs22.x',
          Handler: 'index.handler',
          Role: 'arn:aws:iam::000000000000:role/tsir-probe',
          Timeout: 10,
          Code: { ZipFile: readFileSync(zip).toString('base64') },
        },
        '/2015-03-31/functions',
      );
      const answer = await callAwsJson(
        doFetch,
        setup,
        'lambda',
        'Lambda',
        'Invoke',
        {
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ probe: 'tsir' }),
        },
        `/2015-03-31/functions/${functionName}/invocations`,
      );
      return `Payload ${JSON.stringify(answer['Payload'] ?? answer).slice(0, 160)}`;
    });
  }

  return { steps, refusals };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. CLI
 * ──────────────────────────────────────────────────────────────────────────── */

/** `src/` TypeScript that is not a test, so a test's SDK use is not counted as a call. */
export function sourceFiles(
  root: string,
): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
        walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push({ path: path.replace(`${root}/`, ''), text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(join(root, 'src'));
  return found;
}

export interface Report {
  readonly lines: readonly string[];
  /** Non-zero when the table is incomplete — a call `src/` makes with no row here. */
  readonly exitCode: number;
}

/** The whole report as text, so the CLI and its test render the same thing. */
export function report(
  root: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly doFetch?: typeof fetch;
  } = {},
): Promise<Report> {
  const env = options.env ?? process.env;
  const surface = awsSurface(sourceFiles(root));
  const missing = coverageProblems(surface);
  const lines: string[] = [];

  lines.push(`AWS Emulator ${EMULATOR_RELEASE} — what it can prove about this repository`);
  lines.push('');
  lines.push(
    `${String(OPERATIONS.length)} operations in the table: ` +
      `${String(OPERATIONS.length - OPERATIONS.filter((row) => row.ours.path === EMULATOR_SELF).length)} the framework calls, ` +
      `the rest the probe's own setup; ${String(surface.length)} call sites found in src/`,
  );
  for (const row of OPERATIONS) {
    lines.push(`  ${row.verdict.padEnd(15)} ${row.operation.padEnd(24)} ${row.ours.path}`);
  }

  if (missing.length > 0) {
    lines.push('');
    lines.push(`Called with no row in ${EMULATOR_SELF} — the table is incomplete:`);
    for (const entry of missing) lines.push(`  ${entry}`);
  }

  const src = env['AWS_EMULATOR_SRC'];
  if (src !== undefined && existsSync(src)) {
    const checks = crossCheck(src);
    lines.push('');
    lines.push(`Cross-check against the checkout at ${src}:`);
    for (const check of checks) {
      const detail =
        check.outcome === 'agrees'
          ? 'source agrees'
          : check.outcome === 'reviewed'
            ? `body written; the refusal is the reader’s — first code line: ${check.firstCodeLine ?? '(none)'}`
            : `DISAGREES — derived ${check.derived}, first code line: ${check.firstCodeLine ?? '(none)'}`;
      const size = check.sizeMismatch === undefined ? '' : ` [size ${check.sizeMismatch}]`;
      lines.push(`  ${check.outcome.padEnd(10)} ${check.operation.padEnd(14)} ${detail}${size}`);
    }
  } else {
    lines.push('');
    lines.push(
      'Cross-check skipped: point AWS_EMULATOR_SRC at a checkout of the emulator at this tag to',
    );
    lines.push(
      're-derive every verdict from the source. Only `services/` is read, so a shallow clone of',
    );
    lines.push('that subtree is enough.');
  }

  // coercion-ok: `EMULATOR_PORT` is the operator's own port number (the emulator prints it), and
  // `readSetup` only joins it into a path.
  return probe(readSetup(env['HOME'] ?? '', Number(env['EMULATOR_PORT'] ?? DEFAULT_PORT)), {
    ...(options.doFetch === undefined ? {} : { fetch: options.doFetch }),
  }).then((result) => {
    lines.push('');
    if (result.skipped !== undefined) {
      lines.push(`Probe skipped: ${result.skipped}`);
    } else {
      lines.push('Probe against the running emulator:');
      for (const step of result.steps)
        lines.push(`  ${step.ok ? '✓' : '✗'} ${step.step} — ${step.detail}`);
      for (const refusal of result.refusals) lines.push(`  · ${refusal}`);
    }
    return { lines, exitCode: missing.length > 0 ? 1 : 0 };
  });
}

/**
 * `tsir deploy:verify` — the row table, the cross-check, and the probe when one is running.
 *
 * `--json` prints the same thing as data. `--root <dir>` points the source scan at another
 * checkout, which is what the fast test suite uses: the default is the working directory, because
 * every other `deploy:` command describes *the project you are standing in*.
 *
 * Exit codes follow the rest of the deploy surface: `0` when the table covers every call the
 * scanned tree makes, `1` when it does not. An emulator that is not running is **not** a failure —
 * it prints how to start one — because absent tooling must not fail a repository gate.
 */
export async function verify(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? process.cwd() : (argv[rootFlag + 1] ?? process.cwd());

  const result = await report(root);
  if (!json) {
    process.stdout.write(`${result.lines.join('\n')}\n`);
  } else {
    const surface = awsSurface(sourceFiles(root));
    const src = process.env['AWS_EMULATOR_SRC'];
    // `jsonDocument()` adds the schema version every `tsir --json` output carries (`CLI-002`).
    process.stdout.write(
      `${jsonDocument({
        release: EMULATOR_RELEASE,
        operations: OPERATIONS,
        surface,
        missing: coverageProblems(surface),
        crossCheck: src === undefined ? [] : crossCheck(src),
        probe: await probe(readSetup(process.env['HOME'] ?? '')),
      })}\n`,
    );
  }
  return result.exitCode;
}
