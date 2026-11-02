/**
 * SAM template generation (`DPL-016`) and the Lambda environment limit (`DPL-017`).
 *
 * The rule is that Tsir writes templates and **never
 * deploys them**: users own their infrastructure, and a framework that can create resources
 * in someone's account is a framework that can delete them. So this module's whole job is a
 * deterministic YAML document that a human can read in review and `sam deploy` can consume.
 *
 * Four decisions:
 *
 *   · **Secrets become parameters, not values.** A `secret` binding named `APP_KEY` emits
 *     `Parameters.AppKey` (`NoEcho: true`) and `APP_KEY: !Ref AppKey`. The artifact never
 *     contains the value — the operator passes it at deploy time — which is the Lambda half
 *     of `§ 5` and what `deploy:validate` re-checks on disk.
 *   · **The event list is the unit's triggers, not a template default.** An `http` unit gets
 *     an `HttpApi` event and no queue; a `queue` unit gets an `SQS` event with
 *     `ReportBatchItemFailures`, which is the only reason the adapter's `batchItemFailures`
 *     response means anything to AWS.
 *   · **Cron expressions are translated, not copied.** AWS wants six fields and a `?` in
 *     exactly one of day-of-month / day-of-week; a five-field crontab is what people write.
 *   · **The environment limit is enforced, not documented.** Lambda gives an invocation 4 KB
 *     of environment; a build that would exceed it fails with `DPL_ENV_LIMIT` instead of
 *     failing at `sam deploy`.
 */

import { envLimit, invalidDeployConfig } from './errors.ts';
import type { Unit, UnitTrigger } from './units.ts';

/** What the Lambda runtime defaults to. Node 20+/22. */
export const DEFAULT_LAMBDA: SamOptions = {
  runtime: 'nodejs22.x',
  memoryMb: 1024,
  timeoutSeconds: 30,
  architecture: 'arm64',
};

/** AWS's documented cap on the total size of a function's environment. */
export const LAMBDA_ENV_LIMIT_BYTES = 4096;

/**
 * Our own cap on the *count*.
 *
 * AWS does not publish a separate number (4 KB bounds it in practice); fifty is where an
 * environment stops being configuration and starts being a config file nobody reads.
 */
export const LAMBDA_ENV_LIMIT_COUNT = 50;

export interface SamOptions {
  /** `nodejs22.x` by default; not every project can move runtimes at the same speed. */
  readonly runtime?: string | undefined;
  readonly memoryMb?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly architecture?: 'x86_64' | 'arm64' | undefined;
  readonly region?: string | undefined;
  /** Non-secret configuration, merged with the unit's `var` bindings. Sorted on output. */
  readonly vars?: Readonly<Record<string, string>> | undefined;
}

/* ── helpers ──────────────────────────────────────────────────────────────────── */

/** YAML double-quoted scalar. The templates are reviewed, so escaping matters. */
function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** `http` → `Http`, `migrate:primary` → `MigratePrimary`, `drain` → `Drain`. */
export function logicalName(value: string): string {
  return (
    value
      .split(/[^A-Za-z0-9]+/u)
      .filter((part) => part !== '')
      // Lower-case the remainder: `APP_KEY` is `AppKey`, which is what CloudFormation and
      // `--parameter-overrides AppKey=…` both want. Unit and binding names are lower-case by
      // convention anyway, so this only ever fixes the shouted ones.
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
      .join('')
  );
}

/** UTF-8 byte length without `Buffer`: this module stays runtime-agnostic. */
function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The bytes Lambda counts: every name plus every value. */
export function envBytes(values: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [key, value] of Object.entries(values)) total += bytesOf(key) + bytesOf(value);
  return total;
}

const CRON_FIELD = /^[0-9*/,\-]+$/u;

/**
 * Five crontab fields → AWS's six.
 *
 * AWS wants `minute hour day-of-month month day-of-week year` with `?` in exactly one of the
 * two day fields. The translation keeps the cadence the author wrote: if they restricted the
 * day of month, the day of week becomes `?`, and the other way round. `*\/5` becomes `0/5`
 * because AWS treats a bare step as starting at zero but reads better with the origin.
 */
export function toAwsSchedule(expression: string): string {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length === 6) return fields.join(' ');
  if (fields.length !== 5) {
    throw invalidDeployConfig(
      `cron expression "${expression}" has ${String(fields.length)} field(s); a crontab needs 5 (AWS accepts 6)`,
      { expression },
    );
  }
  for (const field of fields) {
    if (!CRON_FIELD.test(field)) {
      throw invalidDeployConfig(
        `cron expression "${expression}" has an unsupported field "${field}"`,
        {
          expression,
        },
      );
    }
  }

  const [minute = '*', hour = '*', dayOfMonth = '*', month = '*', dayOfWeek = '*'] = fields;
  const step = (field: string): string => (field.startsWith('*/') ? `0/${field.slice(2)}` : field);

  // CloudWatch needs `?` in exactly one day field, so exactly one may be restricted. When both
  // are, crontab reads them as OR and this translation would silently keep just the day of week
  // — a cron that runs on a different day on Lambda than on Workers. That is a build error, not a
  // translation, and `@tsir/schedule` refuses the same expression at declaration for the same
  // reason (§ 4.6).
  if (dayOfMonth !== '*' && dayOfWeek !== '*') {
    throw invalidDeployConfig(
      `cron "${expression}" restricts both day-of-month (${dayOfMonth}) and day-of-week (${dayOfWeek}) — ` +
        'crontab reads that as OR and EventBridge cannot express it; declare two schedules instead',
      { expression },
    );
  }

  const dow = dayOfWeek === '*' ? '?' : dayOfWeek;
  const dom = dayOfWeek === '*' ? dayOfMonth : '?';

  return `${step(minute)} ${step(hour)} ${dom} ${step(month)} ${dow} *`;
}

/* ── the template ─────────────────────────────────────────────────────────────── */

interface NamedTrigger {
  readonly trigger: UnitTrigger;
}

function triggersOfKind(unit: Unit, kind: UnitTrigger['kind']): readonly NamedTrigger[] {
  return unit.triggers.filter((trigger) => trigger.kind === kind).map((trigger) => ({ trigger }));
}

/**
 * One unit's SAM template.
 *
 * `CodeUri: .` is deliberate: `deploy:build` writes `index.mjs` and this file into the same
 * directory, so `sam deploy --template-file dist/lambda/http/template.http.yaml` needs no
 * build step of its own and no absolute path.
 */
export function samTemplate(unit: Unit, appName: string, options: SamOptions = {}): string {
  const runtime = options.runtime ?? DEFAULT_LAMBDA.runtime ?? 'nodejs22.x';
  const memoryMb = options.memoryMb ?? DEFAULT_LAMBDA.memoryMb ?? 1024;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_LAMBDA.timeoutSeconds ?? 30;
  const architecture = options.architecture ?? DEFAULT_LAMBDA.architecture ?? 'arm64';

  const secrets = unit.bindings
    .filter((binding) => binding.kind === 'secret')
    .map((binding) => binding.name)
    .sort();
  const secretsByName = new Map(secrets.map((name) => [name, logicalName(name)]));

  const queues = triggersOfKind(unit, 'queue')
    .flatMap(({ trigger }) => trigger.detail)
    .sort();
  const schedules = triggersOfKind(unit, 'cron')
    .flatMap(({ trigger }) => trigger.detail)
    .sort();
  // SNS triggers: `orders` is a direct SNS → Lambda subscription;
  // `orders:sqs` is an SNS → SQS → Lambda fan-out (DPL-028).
  const snsTriggers = triggersOfKind(unit, 'sns')
    .flatMap(({ trigger }) => trigger.detail)
    .sort();
  const snsTopics = snsTriggers
    .map((detail) => {
      const parts = detail.split(':');
      const topic = parts[0];
      if (!topic) return undefined;
      return { topic, via: parts[1] === 'sqs' ? ('sqs' as const) : undefined };
    })
    .filter((t): t is { topic: string; via: 'sqs' | undefined } => t !== undefined);
  // EventBridge rules: detail is `name:detailType` (folded in units.ts). Each becomes an
  // `AWS::Events::Rule` matching the detail-type, with the function as a target.
  const eventbridgeRules = triggersOfKind(unit, 'eventbridge')
    .flatMap(({ trigger }) => trigger.detail)
    .map((detail) => {
      const colon = detail.indexOf(':');
      const name = colon === -1 ? detail : detail.slice(0, colon);
      const detailType = colon === -1 ? undefined : detail.slice(colon + 1);
      return { name, detailType };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const serves = triggersOfKind(unit, 'http').concat(triggersOfKind(unit, 'websocket'));

  const vars: Record<string, string> = {};
  for (const binding of unit.bindings) {
    if (binding.kind === 'var' && binding.resource !== undefined)
      vars[binding.name] = binding.resource;
  }
  for (const [name, value] of Object.entries(options.vars ?? {})) vars[name] = value;

  const count = Object.keys(vars).length + secrets.length;
  const bytes = envBytes(vars) + secrets.reduce((total, name) => total + bytesOf(name) + 8, 0);
  if (bytes > LAMBDA_ENV_LIMIT_BYTES || count > LAMBDA_ENV_LIMIT_COUNT) {
    throw envLimit({
      target: 'lambda',
      count,
      bytes,
      maxCount: LAMBDA_ENV_LIMIT_COUNT,
      maxBytes: LAMBDA_ENV_LIMIT_BYTES,
    });
  }

  const fn = `${logicalName(unit.name)}Function`;
  // A private unit is still deployed — it just has no public endpoint (`DPL-022`). On
  // Lambda that means no `HttpApi` event and no URL output: the function is reachable only
  // by something that is already inside the account.
  const exposes = serves.length > 0 && !unit.private;
  const lines: string[] = [
    `# Generated by \`tsir deploy:build\` for unit ${quoted(unit.name)} — do not edit.`,
    '# Tsir writes this template and never deploys it: `sam deploy` is yours to run.',
    "AWSTemplateFormatVersion: '2010-09-09'",
    'Transform: AWS::Serverless-2016-10-31',
    `Description: ${quoted(`${appName} · unit ${unit.name} (${unit.kind})`)}`,
    '',
  ];

  if (secrets.length > 0) {
    lines.push('Parameters:');
    for (const name of secrets) {
      lines.push(
        `  ${secretsByName.get(name) ?? logicalName(name)}:`,
        '    Type: String',
        '    NoEcho: true',
        `    Description: ${quoted(`secret binding ${name} — pass it with \`sam deploy --parameter-overrides\``)}`,
      );
    }
    lines.push('');
  }

  if (queues.length > 0) {
    if (secrets.length === 0) lines.push('Parameters:');
    for (const queue of queues) {
      lines.push(
        `  ${logicalName(queue)}QueueArn:`,
        '    Type: String',
        `    Description: ${quoted(`ARN of the ${queue} queue this unit consumes`)}`,
      );
    }
    lines.push('');
  }

  const directSns = snsTopics.filter((t) => t.via === undefined);
  if (directSns.length > 0) {
    if (secrets.length === 0 && queues.length === 0) lines.push('Parameters:');
    for (const { topic } of directSns) {
      lines.push(
        `  ${logicalName(topic)}TopicArn:`,
        '    Type: String',
        `    Description: ${quoted(`ARN of the ${topic} SNS topic this unit subscribes to`)}`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Globals:',
    '  Function:',
    `    Runtime: ${quoted(runtime)}`,
    '    Handler: index.handler',
    `    MemorySize: ${String(memoryMb)}`,
    `    Timeout: ${String(timeoutSeconds)}`,
    '    Architectures:',
    `      - ${architecture}`,
    '',
  );

  lines.push('Resources:');
  if (exposes) {
    lines.push(
      '  HttpApi:',
      '    Type: AWS::Serverless::HttpApi',
      '    Properties:',
      '      StageName: $default',
    );
  }

  // SNS → SQS → Lambda fan-out (DPL-028): the topic, the queue it delivers to,
  // a DLQ for messages the queue cannot process, and a raw-message subscription
  // so the Lambda sees the published body directly, not the SNS envelope.
  const fanoutSns = snsTopics.filter((t) => t.via === 'sqs');
  for (const { topic } of fanoutSns) {
    const topicName = logicalName(topic);
    const queueName = logicalName(topic);
    lines.push(
      `  ${topicName}Topic:`,
      '    Type: AWS::SNS::Topic',
      '    Properties:',
      `      TopicName: !Sub "\${AWS::StackName}-${topic}"`,
      '',
      `  ${queueName}Queue:`,
      '    Type: AWS::SQS::Queue',
      '    Properties:',
      `      QueueName: !Sub "\${AWS::StackName}-${topic}"`,
      '      VisibilityTimeout: 60',
      '',
      `  ${queueName}Dlq:`,
      '    Type: AWS::SQS::Queue',
      '    Properties:',
      `      QueueName: !Sub "\${AWS::StackName}-${topic}-dlq"`,
      '',
      `  ${topicName}Subscription:`,
      '    Type: AWS::SNS::Subscription',
      '    Properties:',
      `      TopicArn: !Ref ${topicName}Topic`,
      '      Protocol: sqs',
      `      Endpoint: !GetAtt ${queueName}Queue.Arn`,
      '      RawMessageDelivery: true',
      '',
      `  ${queueName}Policy:`,
      '    Type: AWS::SQS::QueuePolicy',
      '    Properties:',
      `      Queues: [!Ref ${queueName}Queue]`,
      '      PolicyDocument:',
      '        Version: "2012-10-17"',
      '        Statement:',
      '          - Effect: Allow',
      '            Principal: { Service: sns.amazonaws.com }',
      '            Action: sqs:SendMessage',
      `            Resource: !GetAtt ${queueName}Queue.Arn`,
      `            Condition: { ArnEquals: { "aws:SourceArn": !Ref ${topicName}Topic } }`,
      '',
    );
  }

  // EventBridge rules: each `@OnEventBridge` listener becomes a rule on the default bus
  // matching its `detail-type`, with the function as its target. The bus-level filter
  // lives here; the Lambda only dispatches by `detail-type` (lambda.ts).
  for (const { name, detailType } of eventbridgeRules) {
    const ruleName = logicalName(name);
    const detailTypePattern = detailType === undefined ? '*' : detailType;
    lines.push(
      `  ${ruleName}Rule:`,
      '    Type: AWS::Events::Rule',
      '    Properties:',
      `      Name: !Sub "\${AWS::StackName}-${name}"`,
      '      EventBusName: default',
      '      EventPattern:',
      '        source:',
      `          detail-type: [${quoted(detailTypePattern)}]`,
      '      State: ENABLED',
      '      Targets:',
      `        - Arn: !GetAtt ${fn}.Arn`,
      `          Id: ${ruleName}Target`,
      '',
      `  ${ruleName}Permission:`,
      '    Type: AWS::Lambda::Permission',
      '    Properties:',
      '      Action: lambda:InvokeFunction',
      `      FunctionName: !GetAtt ${fn}.Arn`,
      '      Principal: events.amazonaws.com',
      `      SourceArn: !GetAtt ${ruleName}Rule.Arn`,
      '',
    );
  }

  lines.push(
    `  ${fn}:`,
    '    Type: AWS::Serverless::Function',
    '    Properties:',
    `      FunctionName: !Sub "\${AWS::StackName}-${unit.name}"`,
    '      CodeUri: .',
  );

  // Per-unit memory and timeout override the shared `Globals.Function` defaults
  // (`DPL-031`). A unit that sets neither inherits the app-wide values.
  if (unit.memoryMb !== undefined) {
    lines.push(`      MemorySize: ${String(unit.memoryMb)}`);
  }
  if (unit.timeoutSeconds !== undefined) {
    lines.push(`      Timeout: ${String(unit.timeoutSeconds)}`);
  }

  if (unit.private) {
    // `DPL-022`: health and metrics are not public because nobody typed them into a path.
    lines.push(
      '      # private unit (DPL-022): no HTTP API and no function URL — attach an authorizer',
      '      # or reach it from inside the account',
    );
  }

  const events: string[] = [];
  if (exposes) {
    events.push(
      '        HttpApi:',
      '          Type: HttpApi',
      '          Properties:',
      '            ApiId: !Ref HttpApi',
      '            Path: /{proxy+}',
      '            Method: ANY',
    );
  }
  for (const queue of queues) {
    events.push(
      `        Consume${logicalName(queue)}:`,
      '          Type: SQS',
      '          Properties:',
      `            Queue: !Ref ${logicalName(queue)}QueueArn`,
      '            BatchSize: 10',
      // Without this AWS retries the whole batch: the adapter's `batchItemFailures` would
      // be ignored and one poison message would redeliver its healthy neighbours forever.
      '            FunctionResponseTypes:',
      '              - ReportBatchItemFailures',
    );
  }
  for (const schedule of schedules) {
    events.push(
      `        Schedule${String(schedules.indexOf(schedule))}:`,
      '          Type: Schedule',
      '          Properties:',
      `            Schedule: ${quoted(toAwsSchedule(schedule))}`,
      '            Description: !Sub "${AWS::StackName} ${unit.name} cron"',
    );
  }
  for (const { topic, via } of snsTopics) {
    if (via === 'sqs') {
      // Fan-out: the function consumes from the SQS queue the SNS topic feeds.
      events.push(
        `        Consume${logicalName(topic)}Sns:`,
        '          Type: SQS',
        '          Properties:',
        `            Queue: !GetAtt ${logicalName(topic)}Queue.Arn`,
        '            BatchSize: 10',
        '            FunctionResponseTypes:',
        '              - ReportBatchItemFailures',
      );
    } else {
      // Direct SNS → Lambda subscription (DPL-027).
      events.push(
        `        Subscribe${logicalName(topic)}:`,
        '          Type: SNS',
        '          Properties:',
        `            Topic: !Ref ${logicalName(topic)}TopicArn`,
      );
    }
  }

  if (events.length > 0) {
    lines.push('      Events:', ...events);
  }

  if (Object.keys(vars).length > 0 || secrets.length > 0) {
    lines.push('      Environment:', '        Variables:');
    for (const name of Object.keys(vars).sort()) {
      lines.push(`          ${name}: ${quoted(vars[name] ?? '')}`);
    }
    for (const name of secrets) {
      lines.push(`          ${name}: !Ref ${secretsByName.get(name) ?? logicalName(name)}`);
    }
    // `TSIR_STACK_NAME` lets `invokeUnit` build the deployed function name
    // `${AWS::StackName}-${unit}` (internal.ts). Emitted unconditionally so a unit that
    // calls another unit resolves the right function name at runtime.
    lines.push('          TSIR_STACK_NAME: !Sub "${AWS::StackName}"');
  } else {
    lines.push(
      '      Environment:',
      '        Variables:',
      '          TSIR_STACK_NAME: !Sub "${AWS::StackName}"',
    );
  }

  // `invokeUnit` (DPL-030) lets one Lambda call another synchronously. The source
  // Lambda needs `lambda:InvokeFunction` on the functions in this stack. Scoped to
  // `${AWS::StackName}-*` so it covers every unit deployed together.
  lines.push(
    '      Policies:',
    '        - Version: "2012-10-17"',
    '          Statement:',
    '            - Effect: Allow',
    '              Action: lambda:InvokeFunction',
    '              Resource: !Sub "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-*"',
  );

  if (exposes) {
    lines.push(
      '',
      'Outputs:',
      '  HttpApiUrl:',
      '    Description: base URL of the HTTP API this unit serves',
      '    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/"',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Every unit's template, keyed by filename. The emitter writes these next to the bundles. */
export function samTemplates(
  units: readonly Unit[],
  appName: string,
  options: SamOptions = {},
): ReadonlyMap<string, string> {
  const templates = new Map<string, string>();
  for (const unit of units) {
    templates.set(`template.${unit.name}.yaml`, samTemplate(unit, appName, options));
  }
  return templates;
}
