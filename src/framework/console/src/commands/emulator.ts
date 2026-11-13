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
 *   · the emulator's **source at that release**. `make emulator-check` derives the first line of
 *     code in each handler and compares it with the row — so the table cannot drift from the
 *     evidence without the repository gate failing.
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
 *   `tsir deploy:verify` — the table, and the probe when an emulator is running. `--json` prints
 *   the same as data. It describes **tsir's** AWS surface, so it needs nothing from the caller's
 *   tree and always exits 0: an absent emulator prints how to start one.
 *
 * The half that belongs to *this repository* — re-deriving each verdict from the emulator's own
 * handler files, and failing when a call in our `src/` has no row — is `make emulator-check`
 * (`src/tools/emulator-check.ts`). Keeping those apart is the point: a completeness gate over our
 * own source is a framework concern, and a command an application runs must not fail because the
 * application calls AWS.
 */

// The four call sites this table is about, imported the way any other command imports the packages
// it drives. These are real dependencies of `@tsir/console` (not of `@tsir/deploy`), which is the
// reason this module lives here: a check that must run from the distribution cannot depend on
// another package's `src/`.
import { sqsDriver, sqsClientOf } from '@tsir/queue/sqs';
import type { SqsLike, SqsReceiveInput, SqsSendInput } from '@tsir/queue/sqs';
import { sesTransport } from '@tsir/mail';
import type { MailMessage } from '@tsir/mail';
import { signRequest } from '@tsir/storage';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
 * "Every" is checkable, by the repository gate rather than by this module: `make emulator-check`
 * scans `src/` for the SDK packages and wire calls we make, and fails when a called operation has
 * no row here. A new SDK call therefore cannot be added without saying what the emulator can do
 * with it.
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

export interface Report {
  readonly lines: readonly string[];
}

/**
 * What a local emulator can prove about the AWS calls tsir itself makes — the report `tsir
 * deploy:verify` prints.
 *
 * This half is deliberately about **tsir's own surface**, not the caller's. `@tsir/queue`'s SQS
 * driver and `@tsir/mail`'s SES transport are ours; whether an emulator serves them is a fact a
 * consumer can use to decide what to test locally, and it is the same fact in every project. The
 * scan that keeps the table complete — every AWS call in *this repository's* `src/` must have a row
 * — is a different question with a different answer in every tree, so it lives in
 * `src/tools/emulator-check.ts` and runs from `make`, not from a command an application runs.
 */
export function report(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly doFetch?: typeof fetch;
  } = {},
): Promise<Report> {
  const env = options.env ?? process.env;
  const lines: string[] = [];

  lines.push(`AWS Emulator ${EMULATOR_RELEASE} — what it can prove about tsir's own AWS calls`);
  lines.push('');
  lines.push(
    `${String(OPERATIONS.length)} operations in the table: ` +
      `${String(OPERATIONS.length - OPERATIONS.filter((row) => row.ours.path === EMULATOR_SELF).length)} called by framework code, ` +
      `the rest the probe's own setup`,
  );
  for (const row of OPERATIONS) {
    lines.push(`  ${row.verdict.padEnd(15)} ${row.operation.padEnd(24)} ${row.ours.path}`);
  }

  lines.push('');
  lines.push('A verdict is not an acceptance: no row here discharges a cloud check. A local');
  lines.push(
    'emulator cannot answer `sam validate`, cannot report the real `initDuration`, and in',
  );
  lines.push(
    'the AWS Emulator `nodejs*` is QuickJS with no `net`/`http` — so a bundle that reaches',
  );
  lines.push('the network at import time fails here for a reason AWS would not have.');

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
    return { lines };
  });
}

/**
 * `tsir deploy:verify` — the table, and the probe when an emulator is running.
 *
 * `--json` prints the same thing as data. It describes **tsir's** AWS surface, so it answers the
 * same way in every project, and it needs nothing from the caller's tree: no scan of their `src/`,
 * no fixtures, no emulator checkout.
 *
 * Exit codes: `0` always, except a usage error. Nothing here is the caller's fault — a missing
 * emulator prints how to start one. The questions that *can* fail belong to the framework
 * (`make emulator-check`), not to the application running `tsir`.
 */
export async function verify(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json');
  const result = await report();

  if (json) {
    // `jsonDocument()` adds the schema version every `tsir --json` output carries (`CLI-002`).
    const setup = readSetup(process.env['HOME'] ?? '');
    process.stdout.write(
      `${jsonDocument({
        release: EMULATOR_RELEASE,
        operations: OPERATIONS,
        probe: await probe(setup),
      })}\n`,
    );
    return 0;
  }

  process.stdout.write(`${result.lines.join('\n')}\n`);
  return 0;
}
