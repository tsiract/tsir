/**
 * Ambient declarations for the AWS SDK modules used by the default internal
 * transport (`DPL-030`).
 *
 * These are *not* hard dependencies: the Lambda nodejs22.x runtime ships the SDK, and the
 * `import()` calls are lazy so the bundle only carries them when actually used. The
 * declarations here give TypeScript enough to type-check the dynamic imports without
 * forcing every install of the real packages.
 */

declare module '@aws-sdk/client-sns' {
  export class SNSClient {
    constructor(config?: Record<string, unknown>);
    send<T>(command: T): Promise<unknown>;
  }
  export class PublishCommand {
    constructor(input: { TopicArn: string; Message: string });
  }
  export class ListTopicsCommand {
    constructor();
  }
}

declare module '@aws-sdk/client-lambda' {
  export class LambdaClient {
    constructor(config?: Record<string, unknown>);
    send<T>(command: T): Promise<{ Payload?: { transformToString(): string } }>;
  }
  export class InvokeCommand {
    constructor(input: {
      FunctionName: string;
      InvocationType: 'RequestResponse' | 'Event';
      Payload: Buffer;
    });
  }
}
