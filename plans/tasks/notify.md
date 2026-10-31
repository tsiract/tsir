# Tasks — `@tsir/notify` (Phase 7)

> Channels, not drivers. `@tsir/mail` answers "how does a message leave the building"; this package
> answers "which of the ways we can tell somebody should this fact go out on, and what does each one
> say". The split is worth the second package: an inbox row and a Slack message are not emails, and
> a mail package that grew a Slack client would be a mail package with a Twilio bill in it.
>
> **Plan:** [`15-capabilities.md § 4.4`](../modules/15-capabilities.md) · **Related:**
> [`mail.md`](./mail.md) (the `mail` channel's transport), [`queue.md`](./queue.md) (what a queued
> delivery is), [`07-capabilities.md`](./07-capabilities.md) (`CAP-001`, `CAP-005`).

**Status: complete — 2026-10-29.** Twelve tasks, 17 modules, six channels, a conformance kit and
three console commands. Tests: **78** in the package plus **14** subprocess tests for `notify:*`,
and the coverage gate reports **96.02 % lines / 96.76 % functions**.

## Tasks

| ID          | Task                                                                   | Status | Depends     | Acceptance                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------- | ------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY-1`  | `Channel` port — payload in, `accepted` out, capabilities declared     | `[x]`  | —           | The shape is `@tsir/mail`'s transport port, deliberately: `delivers`/`html`/`attachments` declared per channel and checked before the send                     |
| `NOTIFY-2`  | `defineNotification` — a name, a channel list, one builder per channel | `[x]`  | `NOTIFY-1`  | Typed data reaches every builder; a declared channel with no builder is refused, and so is a builder nobody declares                                           |
| `NOTIFY-3`  | `mail` channel over a mailer port                                      | `[x]`  | `NOTIFY-2`  | The recipient comes from the notifiable, never from data; `template` renders in the mailer, so this package concatenates no HTML                               |
| `NOTIFY-4`  | `database` channel + inbox store + DDL                                 | `[x]`  | `NOTIFY-2`  | The row id **is** the delivery id, so a retried job cannot duplicate an inbox row; `?`/`$n` follows the engine; plain text only                                |
| `NOTIFY-5`  | `webhook` channel — allowlist, https, signed body                      | `[x]`  | `NOTIFY-2`  | A URL from data is checked against `allowHosts` before any request; credentials in the URL are refused; the signature covers the timestamp                     |
| `NOTIFY-6`  | `chat` channel — slack/discord over an incoming webhook                | `[x]`  | `NOTIFY-5`  | The room URL is configured, not data-derived, so no allowlist is needed and the difference is documented rather than hidden                                    |
| `NOTIFY-7`  | `sms` channel + `twilio` provider + E.164 refusal                      | `[x]`  | `NOTIFY-5`  | A paid channel is never implied; a number that is not E.164 is refused before the request                                                                      |
| `NOTIFY-8`  | `createNotifier` — resolve, build, check, queue or send                | `[x]`  | `NOTIFY-2`  | Queued by default, one job per channel; a notifier with no queue **refuses** rather than sending inline; production refuses a channel that does not deliver    |
| `NOTIFY-9`  | `notify:deliver:<channel>` jobs + `jobs()` for `createQueues`          | `[x]`  | `NOTIFY-8`  | One job per channel a notification uses; the delivery id is the idempotency key; a malformed envelope is a coded refusal, not a crash                          |
| `NOTIFY-10` | `channelsFromConfig` — drivers by name, secrets by `{ fromEnv }`       | `[x]`  | `NOTIFY-8`  | An unset variable fails at boot naming it; each driver says what it is missing; `webhook` without `allowHosts` cannot be built                                 |
| `NOTIFY-11` | `channelConformance` — the kit a third-party channel must pass         | `[x]`  | `NOTIFY-1`  | Four named cases, and the kit is known to fail three deliberately broken channels                                                                              |
| `NOTIFY-12` | `tsir notify:channels\|preview\|test`                                  | `[x]`  | `NOTIFY-10` | `test` reports per channel and exits non-zero when one refuses; `preview` renders every payload without sending; `channels` fails on a channel nobody declares |

## As built: four steps, and the order is the design

```
resolve ──▶ build every payload ──▶ check capabilities + shape ──▶ queue (default) │ deliver (inline)
   │                │                            │                        │
   │                │                            │                        └── one job per channel
   │                │                            └── NOTIFY_UNSUPPORTED_OPERATION / NOTIFY_INVALID_PAYLOAD
   │                └── the notification owns the payload; a channel never sees the data
   └── an undeclared channel is an error, never a fallback
```

Four decisions the package makes rather than documents:

- **Queued by default, and "no queue" is a refusal.** `send` on a notifier built without a queue
  throws `NOTIFY_NO_QUEUE` and names both escape hatches (`immediately: true`, `queued: false`).
  The alternative — sending inline — puts a provider's latency inside the request that was
  supposed to be finished with it, and does it silently.
- **One job per channel, not per notification.** A mail provider having a bad afternoon retries the
  email and does not re-post the webhook that already arrived. The job name says where it goes
  (`notify:deliver:mail`), so `tsir queue:failed` reads like a list of destinations.
- **Payloads are built before anything is queued.** A payload the channel cannot carry fails in the
  request that produced it, not in a worker three retries later. That is what `Channel.check` is
  for — and it is also why the channel validates _again_ at delivery: the queue is a JSON boundary.
- **`delivers` is a capability.** `memory` reaches nobody, so `production: true` refuses it as a
  target (the same rule `@tsir/mail` applies to `log`), and `notify:channels` prints a warning for
  any notification that uses it.

## As built: six channels, three facts each

| Channel    | Delivers | HTML | Attachments | Notes                                                                              |
| ---------- | -------- | ---- | ----------- | ---------------------------------------------------------------------------------- |
| `mail`     | yes      | yes  | yes         | Through a `@tsir/mail` mailer; the recipient is the notifiable's `email`           |
| `database` | yes      | no   | no          | `notification_inbox`; plain text, because an inbox that renders HTML is stored XSS |
| `webhook`  | yes      | no   | no          | Signed POST; `allowHosts` is mandatory (the URL comes from data)                   |
| `chat`     | yes      | no   | no          | Slack `text` / Discord `content`; the room URL is configured                       |
| `sms`      | yes      | no   | no          | Provider port + `twilio`; E.164 only; never enabled by a default                   |
| `memory`   | **no**   | yes  | yes         | Records deliveries for tests; refused in production                                |

`mail` and `database` inherit mail's own capability facts, so a project whose mailer is `log` has a
`mail` channel that reports `delivers: false` — the truth travels rather than being restated.

## As built: the security work is in one file

`webhook` is the only channel whose destination comes from business data, and that is the whole
reason `channels/webhook.ts` is longer than the others:

- **`allowHosts` is required at construction.** An empty list is a `TypeError` — there is no way to
  build an unfiltered webhook channel. `*.example.com` matches subdomains, exact hosts match
  exactly, and `example.org` does not match `evilexample.org` (both tested).
- **`https:` only**, unless the project sets `allowHttp` for a local receiver.
- **A URL with credentials is refused** — a token in a URL ends up in a log line and a proxy's cache
  key; `headers` is where it belongs.
- **The body is signed when a secret is configured**, as `t=<seconds>,v1=<hex HMAC-SHA256>` over
  `${t}.${body}`, so the timestamp cannot be edited, and verifies in constant time. `verifySignature`
  is exported because the _receiver_ on the other end needs the same twenty lines.

## As built: what is deliberately not here

`§ 4.4` lists `push` among the channels. It is not built, and the reason is not time: FCM v1 needs a
service-account JWT (a key format, a signing algorithm and a credential to rotate) and APNs needs
HTTP/2 with a key and a token. Shipping either would put a credential format inside a package whose
job is to route a fact to a destination — ahead of a user asking for it. The port is the seam: a
project writes `defineChannel` and passes `push` a provider, and `notify:channels` lists it like any
other. This paragraph is the record, not a promise to be inferred from silence.

`Q39` (merge `mail` and `notify`) is answered by the shape of this package: `notify` imports two
ports — `mail`'s mailer and `queue`'s `dispatch` — and owns no transport. The `database` channel is a
row in an app's own table and the `webhook` channel is a signed POST; neither is an email, which is
exactly what a merge would have to pretend.
