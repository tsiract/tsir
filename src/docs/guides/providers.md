# Moving between Cloudflare and AWS

## The mental model

Tsir separates **what your app does** from **where it runs**. Your controllers, jobs, and
schedules are declared in plain TypeScript. The deploy layer maps those declarations onto a
specific cloud: Cloudflare Workers, AWS Lambda, or both.

Your job code stays the same; only the connection changes. In Tsir, your HTTP handler stays the
same; only the deploy target changes.

The goal is **portable application code**, not identical infrastructure. A Cloudflare Worker and
an AWS Lambda function are different runtimes with different constraints. Tsir abstracts the
common parts (HTTP dispatch, queue dispatch, scheduled events) but you are still responsible for
provisioning the cloud resources each target needs.

The graph serialization is deterministic for the same declarations: collections are sorted and
the graph can be reviewed and checked for drift. Artifacts, timestamps, bundled bytes,
credentials, remote data, service availability and deployed behavior are not guaranteed identical.
Real Workers and Lambda deployment verification is still open; generated artifacts and mocked
tests are not proof of a live cloud deployment.

## What exists today

| Concern   | Cloudflare                                                               | AWS / Lambda                                                                         | What you must do                                                                                                                                         |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | Workers fetch adapter and Wrangler artifact                              | API Gateway v2 / Function URL adapter and SAM artifact                               | Supply an exported fetch handler, configure bindings and deploy externally.                                                                              |
| Jobs      | `cloudflare-queues` producer/consumer port                               | `sqs` driver with app-supplied client, Lambda SQS event adapter                      | Create brokers, permissions, consumers, outbox/relay and DLQ; validate retry behavior.                                                                   |
| Database  | D1 binding; Postgres may use an application client/appropriate transport | Postgres client supplied by the application; D1 is not available as a Lambda binding | Migrate schema and data, replace SQLite schema/dialect when needed, verify transactions and pooling.                                                     |
| Cache     | D1/database or Cloudflare KV binding                                     | Database or app-supplied Redis client                                                | Choose semantics, provision clients and storage, warm or invalidate data. KV is eventually consistent.                                                   |
| Objects   | `s3` driver with R2 endpoint and credentials                             | Same `s3` driver against S3                                                          | Supply bucket, region, credentials and permissions; copy objects and verify URLs.                                                                        |
| Schedules | Workers scheduled handler                                                | EventBridge schedule adapter and SAM event                                           | Declare UTC-compatible schedules and operate the handler.                                                                                                |
| Logs      | stdout, collected by Workers Logs                                        | stdout, collected by Lambda/CloudWatch Logs; optional `cloudwatch` JSON format       | Configure permissions, retention, dashboards and alerts; there is no direct CloudWatch Logs API sink here.                                               |
| SNS       | No built-in equivalent                                                   | **No SNS publisher or SNS-trigger adapter is shipped**                               | Implement an application-owned integration or use an appropriate separate consumer; do not pass SNS events to the Lambda adapter expecting them to work. |

The Lambda adapter recognizes API Gateway v2, SQS and EventBridge event shapes, not arbitrary AWS
events. For SQS it reports only errors explicitly marked `retryable: true` or with a retryable
`kind`; an ordinary thrown error is reported but **not** returned as a failed item. Generated SAM
configures `ReportBatchItemFailures`. Verify your handler's failure classification, redrive,
visibility timeout and idempotency under real AWS before production; the adapter does not itself
turn an arbitrary queue callback into the `@tsir/queue` worker.

`@tsir/pulse` supports `createLogger({ format: 'cloudwatch' })` with stdout. This is CloudWatch
Logs-shaped JSON, **not** a direct CloudWatch API integration, metrics exporter or Embedded Metric
Format implementation. CloudWatch log groups, IAM, retention and alarms are operator-owned. Other
AWS services—including SNS—need an application adapter unless a shipped package explicitly says
otherwise. `@tsir/mail` includes an SES transport; consult its reference for its own limits.

## Practical migration checklist

1. Inventory routes, jobs, schedules, data, bindings, secrets, retries, latency and costs. Identify
   non-portable capabilities and any vendor-specific API calls inside application code.
2. Choose AWS resources and explicitly configure them. For SQS, construct an app-supplied
   `SqsLike` client (or wrap SDK calls with `sqsClientOf` from `@tsir/queue/sqs`), provide the queue
   URL and `outbox: true` to `createQueues`, and bind it as `bindings.sqs.<connection>`. The
   current `tsir.js` queue schema does not expose `queueUrl`/FIFO settings, so pass them to the
   runtime builder yourself. Credentials/IAM remain your responsibility.
3. Implement the transactional outbox described in [jobs and queues](./queues.md). Export and wire
   the actual queue/event handlers, not just config flags. Provision DLQs, triggers and relay
   scheduling. Compare retry/delay, visibility, ordering and dedupe semantics.
4. Move D1 data to an AWS-accessible database using an engine-aware migration; review schemas,
   constraints and transaction differences. Move objects separately, validate counts and hashes,
   and rebuild or invalidate caches. Plan a freeze or change capture and a tested rollback; changing
   a driver does **not** copy state.
5. From your application directory, review the graph and build locally:

```sh
tsir deploy:plan --explain
tsir deploy:diff
tsir deploy:build --target lambda
tsir deploy:validate
```

Review graph drift before accepting it with `tsir deploy:plan --write` from your app directory.
Inspect generated SAM templates, binding names, IAM, secrets and costs. Build and validate each
chosen target with its own appropriate configuration; a Cloudflare Queues connection cannot be
triggered on Lambda, and an SQS connection is not a native Workers queue. The graph may reject an
incompatible set of targets; use separate target-specific configurations where necessary.

6. Deploy with your own SAM/Wrangler and infrastructure pipeline, then smoke-test HTTP, SQS partial
   failures, outbox recovery, schedules, logs, alarms, database and storage against real services.
   Perform a staged cutover and keep a verified rollback. Build/validation commands emit and check
   artifacts; they do **not** provision or deploy cloud resources.

See [deployment](../packages/deploy.md), [queues](../packages/queue.md),
[storage](../packages/storage.md), [observability](../packages/pulse.md) and the
[compatibility policy](../compatibility.md).
