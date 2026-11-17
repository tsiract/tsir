/**
 * SAM templates (`DPL-016`) and the Lambda environment limit (`DPL-017`).
 *
 * The template is the one deploy artifact a human reads before `sam deploy`, so the tests
 * assert what a reviewer looks for: which events a unit gets, that secrets are references
 * and not values, that the cron translation keeps the cadence, and that the document is
 * byte-identical between runs (a template that reshuffles cannot be reviewed as a diff).
 */

import { describe, expect, test } from 'bun:test';

import {
  envBytes,
  LAMBDA_ENV_LIMIT_BYTES,
  logicalName,
  samTemplate,
  samTemplates,
  toAwsSchedule,
} from './sam.ts';
import type { Unit } from './units.ts';

/** A unit with everything defaulted except what the test is about. */
function unit(overrides: Partial<Unit> & Pick<Unit, 'name' | 'kind'>): Unit {
  return {
    modules: [],
    reasons: [],
    triggers: [],
    requires: [],
    bindings: [],
    private: false,
    ...overrides,
  };
}

const HTTP_UNIT = unit({
  name: 'http',
  kind: 'http',
  triggers: [{ kind: 'http', detail: ['GET /api/users'] }],
});

describe('the HTTP unit', () => {
  const template = samTemplate(HTTP_UNIT, 'acme-api');

  test('it serves through an HTTP API and nothing else', () => {
    expect(template).toContain('Type: AWS::Serverless::HttpApi');
    expect(template).toContain('Type: HttpApi');
    expect(template).toContain('Path: /{proxy+}');
    expect(template).toContain('Method: ANY');
    expect(template).not.toContain('Type: SQS');
    expect(template).not.toContain('Type: Schedule');
  });

  test('the function is named after the stack and the unit, and code lives next to it', () => {
    expect(template).toContain('FunctionName: !Sub "${AWS::StackName}-http"');
    expect(template).toContain('CodeUri: .');
    expect(template).toContain('Handler: index.handler');
  });

  test('every function carries TSIR_STACK_NAME so invokeUnit resolves peer function names', () => {
    // `invokeUnit` builds `${TSIR_STACK_NAME}-${unit}`; the env var must be present on
    // every unit, even those with no other environment variables.
    expect(template).toContain('TSIR_STACK_NAME: !Sub "${AWS::StackName}"');
  });

  test('every function may invoke peers in the same stack (DPL-030)', () => {
    // `invokeUnit` needs `lambda:InvokeFunction`; the policy is scoped to this stack's
    // functions so a unit cannot reach into another app's account.
    expect(template).toContain('Action: lambda:InvokeFunction');
    expect(template).toContain(
      'Resource: !Sub "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-*"',
    );
  });

  test('the runtime knobs are the documented defaults and are overridable', () => {
    expect(template).toContain('Runtime: "nodejs22.x"');
    expect(template).toContain('MemorySize: 1024');
    expect(template).toContain('Timeout: 30');
    expect(template).toContain('      - arm64');

    const smaller = samTemplate(HTTP_UNIT, 'acme-api', {
      runtime: 'nodejs20.x',
      memoryMb: 512,
      timeoutSeconds: 10,
      architecture: 'x86_64',
    });
    expect(smaller).toContain('Runtime: "nodejs20.x"');
    expect(smaller).toContain('MemorySize: 512');
    expect(smaller).toContain('Timeout: 10');
    expect(smaller).toContain('      - x86_64');
  });

  test('the URL output is the API the template created', () => {
    expect(template).toContain('HttpApiUrl:');
    expect(template).toContain('https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/');
  });
});

describe('queue and cron units', () => {
  test('a queue unit gets an SQS event that reports partial batch failures', () => {
    const template = samTemplate(
      unit({
        name: 'jobs',
        kind: 'queue',
        triggers: [{ kind: 'queue', detail: ['acme-jobs'] }],
      }),
      'acme-api',
    );

    expect(template).toContain('Parameters:');
    expect(template).toContain('  AcmeJobsQueueArn:');
    expect(template).toContain('Queue: !Ref AcmeJobsQueueArn');
    expect(template).toContain('ReportBatchItemFailures');
    expect(template).not.toContain('Type: HttpApi');
  });

  test('a cron unit gets a schedule event with the translated expression', () => {
    const template = samTemplate(
      unit({
        name: 'drain',
        kind: 'schedule',
        triggers: [{ kind: 'cron', detail: ['*/5 * * * *'] }],
      }),
      'acme-api',
    );

    expect(template).toContain('Type: Schedule');
    expect(template).toContain('Schedule: "0/5 * * * ? *"');
    expect(template).not.toContain('Parameters:');
  });

  test('a private unit says so in the template a human reads', () => {
    const template = samTemplate(
      unit({
        name: 'admin',
        kind: 'admin',
        private: true,
        triggers: [{ kind: 'http', detail: ['GET /health'] }],
      }),
      'acme-api',
    );

    expect(template).toContain('private unit (DPL-022)');
    // No endpoint at all: no HTTP API resource, no event, no URL output.
    expect(template).not.toContain('AWS::Serverless::HttpApi');
    expect(template).not.toContain('Type: HttpApi');
    expect(template).not.toContain('Outputs:');
  });
});

describe('SNS units (DPL-027, DPL-028)', () => {
  test('a direct SNS unit subscribes the function to the topic (DPL-027)', () => {
    const template = samTemplate(
      unit({
        name: 'notify',
        kind: 'queue',
        triggers: [{ kind: 'sns', detail: ['orders'] }],
      }),
      'acme-api',
    );

    // The topic ARN is a parameter — the topic lives outside this stack.
    expect(template).toContain('  OrdersTopicArn:');
    expect(template).toContain('Type: SNS');
    expect(template).toContain('Topic: !Ref OrdersTopicArn');
    // No SQS queue or subscription resource is created for a direct subscription.
    expect(template).not.toContain('AWS::SQS::Queue');
    expect(template).not.toContain('RawMessageDelivery');
  });

  test('an SNS → SQS → Lambda fan-out creates topic, queue, DLQ and raw subscription (DPL-028)', () => {
    const template = samTemplate(
      unit({
        name: 'notify',
        kind: 'queue',
        triggers: [{ kind: 'sns', detail: ['orders:sqs'] }],
      }),
      'acme-api',
    );

    // The fan-out owns its own topic, queue, DLQ and subscription.
    expect(template).toContain('Type: AWS::SNS::Topic');
    expect(template).toContain('OrdersTopic:');
    expect(template).toContain('OrdersQueue:');
    expect(template).toContain('OrdersDlq:');
    expect(template).toContain('RawMessageDelivery: true');
    // The function consumes from the queue, not from the topic directly.
    expect(template).toContain('Type: SQS');
    expect(template).toContain('Queue: !GetAtt OrdersQueue.Arn');
    // No topic-ARN parameter: the topic is created in this stack.
    expect(template).not.toContain('OrdersTopicArn:');
  });
});

describe('EventBridge units (DPL-026)', () => {
  test('an @OnEventBridge listener becomes an Events::Rule matching its detail-type', () => {
    const template = samTemplate(
      unit({
        name: 'events',
        kind: 'schedule',
        triggers: [{ kind: 'eventbridge', detail: ['orders:order.placed'] }],
      }),
      'acme-api',
    );

    expect(template).toContain('Type: AWS::Events::Rule');
    expect(template).toContain('OrdersRule:');
    // The rule filters by detail-type on the default bus; the Lambda dispatches inside.
    expect(template).toContain('EventBusName: default');
    expect(template).toContain('detail-type: ["order.placed"]');
    // `EventPattern` is a JSON document, and `detail-type` is a **top-level** key in it.
    // Nesting it under `source:` produced a pattern CloudFormation rejects, and an empty
    // `source:` mapping, which is a rule that matches nothing — a silent no-op after deploy.
    expect(template).not.toMatch(/EventPattern:\s*\n\s+source:/u);
    // The function is the rule's target, with a Lambda permission to be invoked.
    expect(template).toContain('- Arn: !GetAtt EventsFunction.Arn');
    expect(template).toContain('OrdersPermission:');
    expect(template).toContain('Principal: events.amazonaws.com');
  });
});

describe('secrets and configuration (§ 5)', () => {
  const unitWithSecrets = unit({
    name: 'http',
    kind: 'http',
    triggers: [{ kind: 'http', detail: ['GET /'] }],
    bindings: [
      { kind: 'secret', name: 'APP_KEY' },
      { kind: 'var', name: 'APP_ENV', resource: 'production' },
    ],
  });

  test('a secret binding is a parameter reference, never a value', () => {
    const template = samTemplate(unitWithSecrets, 'acme-api');

    expect(template).toContain('  AppKey:');
    expect(template).toContain('NoEcho: true');
    expect(template).toContain('APP_KEY: !Ref AppKey');
    // Nothing in the document could be mistaken for the key's material.
    expect(template).not.toContain('= "');
  });

  test('vars are sorted and quoted, and target vars merge over unit vars', () => {
    const template = samTemplate(unitWithSecrets, 'acme-api', {
      vars: { ZONE: 'eu-west-1', APP_ENV: 'staging' },
    });

    expect(template).toContain('APP_ENV: "staging"');
    expect(template).toContain('ZONE: "eu-west-1"');
    expect(template.indexOf('APP_ENV:')).toBeLessThan(template.indexOf('ZONE:'));
    expect(template).not.toContain('"production"');
  });

  test('an environment over Lambda’s 4 KB fails the build, not the deploy (DPL_ENV_LIMIT)', () => {
    const big = { BIG: 'x'.repeat(LAMBDA_ENV_LIMIT_BYTES) };

    expect(() => samTemplate(HTTP_UNIT, 'acme-api', { vars: big })).toThrow();
    try {
      samTemplate(HTTP_UNIT, 'acme-api', { vars: big });
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('DPL_ENV_LIMIT');
      expect((error as { hint?: string }).hint).toContain('secret store');
    }
  });

  test('the byte count is name + value, as AWS counts it', () => {
    expect(envBytes({ A: 'b' })).toBe(2);
    expect(envBytes({})).toBe(0);
    expect(envBytes({ KEY: 'v'.repeat(10) })).toBe(13);
  });
});

describe('cron translation', () => {
  test('five fields become six, with `?` in the day the author did not constrain', () => {
    expect(toAwsSchedule('*/5 * * * *')).toBe('0/5 * * * ? *');
    expect(toAwsSchedule('0 3 * * 1')).toBe('0 3 ? * 1 *');
    expect(toAwsSchedule('15 2 1 * *')).toBe('15 2 1 * ? *');
  });

  test('both day fields restricted is refused, not silently narrowed', () => {
    // `0 0 1 * 1` is "the 1st, or any Monday" in crontab. The old translation kept the day of
    // week and dropped the day of the month, so the same cron ran on a different day on Lambda
    // than on Workers — silently, and only ever visible as a report that did not arrive.
    expect(() => toAwsSchedule('0 0 1 * 1')).toThrow(/both day-of-month/u);
    expect(() => toAwsSchedule('0 0 1 * 1')).toThrow(/two schedules/u);
  });

  test('a six-field expression is already AWS-shaped', () => {
    expect(toAwsSchedule('0 3 ? * MON *')).toBe('0 3 ? * MON *');
  });

  test('what it cannot read, it says out loud', () => {
    expect(() => toAwsSchedule('every five minutes')).toThrow(/crontab needs 5/u);
    expect(() => toAwsSchedule('*/5 * * *')).toThrow(/crontab needs 5/u);
    expect(() => toAwsSchedule('@daily')).toThrow(/crontab needs 5/u);
    expect(() => toAwsSchedule('*/5 * * * MON')).toThrow(/unsupported field "MON"/u);
  });
});

describe('the document itself', () => {
  test('same unit, same bytes', () => {
    expect(samTemplate(HTTP_UNIT, 'acme-api')).toBe(samTemplate(HTTP_UNIT, 'acme-api'));
  });

  test('no tabs, no trailing whitespace, no leading blank line', () => {
    const template = samTemplate(HTTP_UNIT, 'acme-api');

    expect(template).not.toContain('\t');
    expect(template.split('\n').every((line) => line === line.trimEnd())).toBe(true);
    expect(template.startsWith('# Generated by')).toBe(true);
    expect(template.endsWith('\n')).toBe(true);
    expect(template.endsWith('\n\n')).toBe(false);
  });

  test('it says who owns the deploy', () => {
    expect(samTemplate(HTTP_UNIT, 'acme-api')).toContain('`sam deploy` is yours to run');
  });

  test('logical names are stable and readable in `--parameter-overrides`', () => {
    expect(logicalName('http')).toBe('Http');
    expect(logicalName('migrate:primary')).toBe('MigratePrimary');
    expect(logicalName('drain-queue')).toBe('DrainQueue');
  });

  test('every unit gets a file named after it', () => {
    const templates = samTemplates(
      [HTTP_UNIT, unit({ name: 'drain', kind: 'schedule' })],
      'acme-api',
    );

    expect([...templates.keys()].sort()).toEqual(['template.drain.yaml', 'template.http.yaml']);
    expect(templates.get('template.http.yaml')).toContain('unit "http"');
  });
});

describe('per-unit memory and timeout (DPL-031)', () => {
  test('a unit without overrides keeps the shared default', () => {
    const template = samTemplate(HTTP_UNIT, 'acme-api', { memoryMb: 512, timeoutSeconds: 10 });

    // The default lives in `Globals.Function` only — not on the function resource.
    expect(template).toContain('    MemorySize: 512');
    expect(template).toContain('    Timeout: 10');
    // No per-unit override, so the function resource does NOT re-declare MemorySize/Timeout.
    const functionBlock = template.split('Properties:\n      FunctionName');
    expect(functionBlock.at(1)?.split('Events:').at(0)).not.toContain('MemorySize');
  });

  test('a unit with overrides emits its own MemorySize and Timeout', () => {
    const heavy = unit({
      name: 'heavy',
      kind: 'schedule',
      memoryMb: 2048,
      timeoutSeconds: 120,
    });
    const template = samTemplate(heavy, 'acme-api', { memoryMb: 512, timeoutSeconds: 10 });

    expect(template).toContain('MemorySize: 2048');
    expect(template).toContain('Timeout: 120');
    // The shared default is still present in `Globals.Function`.
    expect(template).toContain('    MemorySize: 512');
    expect(template).toContain('    Timeout: 10');
  });
});
