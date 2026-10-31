# Tasks — `@tsir/mail` (Phase 7)

> `Mailer` composes and sends; it does not queue. That one sentence decides the package: no worker
> to keep alive, no retry policy hidden behind a `send`, and a failure that reaches the caller
> instead of a log line nobody reads. Queuing is `@tsir/queue`'s job, composed by the caller or by
> `@tsir/notify`.
>
> **Plan:** [`15-capabilities.md § 4.3`](../modules/15-capabilities.md) · **Registry:** `CAP-001` (the
> `mail.mailers` half) · **Related:** [`queue.md`](./queue.md) (the thing that queues),
> [`storage.md`](./storage.md) (the SigV4 signer `ses` reuses).

**Status: complete.** Twelve tasks, 23 modules (thirteen in core, eight transports plus two adapter
files), a conformance kit, six test files (106 tests) and three console commands; `tsir
mail:mailers|test|preview` reads the app's own `mailers`/`templates` exports when there are any and
builds the registry from `mail.mailers` when there are not.

## Tasks

| ID        | Task                                                                                 | Status | Depends  | Acceptance                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------ | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL-1`  | `parseAddress` — the header-injection lock                                           | `[x]`  | —        | A newline anywhere in an address or a display name is `MAIL_INVALID_ADDRESS`; `Name <a@b.c>` and `"Doe, Jane" <j@x.y>` parse; a quoted local part is refused rather than guessed |
| `MAIL-2`  | `createMessage` — a message that would send nothing is refused                       | `[x]`  | `MAIL-1` | No recipient, no body, an empty subject, a duplicate recipient and a reserved header are all refusals with a reason and a hint                                                   |
| `MAIL-3`  | `html` / `raw` — the escaping boundary as a type                                     | `[x]`  | —        | Every interpolation is escaped unless it is `SafeHtml`; only `raw()` waives it; an object in a body is a `TypeError`, not `[object Object]`                                      |
| `MAIL-4`  | `defineTemplate` + registry — typed data, sample, render-time checks                 | `[x]`  | `MAIL-3` | `sendTemplate('welcome', {…})` does not compile with the wrong data; an unknown name lists the registered ones; an empty subject or body is refused at render                    |
| `MAIL-5`  | `createMailer` — compose, check, send                                                | `[x]`  | `MAIL-2` | A `false` capability throws **before** the transport is called, naming transport and feature; `from`/`replyTo` defaults are defaults, not overrides                              |
| `MAIL-6`  | `buildMime` — CRLF, base64, alternative-inside-mixed                                 | `[x]`  | `MAIL-2` | No bare LF; `Bcc` never written; text before HTML; attachments outside the alternative; RFC 2047 subjects and RFC 2231 filenames                                                 |
| `MAIL-7`  | Seven transports: `log`, `memory`, `cloudflare`, `resend`, `postmark`, `ses`, `smtp` | `[x]`  | `MAIL-6` | Each declares `delivers`/`html`/`attachments`/`customHeaders`/`tags`; a provider error is `MAIL_TRANSPORT_FAILED` with its status and message, and never the credential          |
| `MAIL-8`  | `assertDelivers` + `mail.mailers` registry                                           | `[x]`  | `MAIL-5` | `production: true` refuses a `log`/`memory` default or `required` mailer; an undeclared name is `MAIL_UNKNOWN_MAILER` listing the declared ones, never a fallback                |
| `MAIL-9`  | `mailersFromConfig` — drivers by name, secrets by `{ fromEnv }`                      | `[x]`  | `MAIL-8` | An unset variable fails at boot naming it; an unknown driver lists the seven; `cloudflare` resolves a binding from `bindings`, not from `env`                                    |
| `MAIL-10` | `tsir mail:mailers\|test\|preview`                                                   | `[x]`  | `MAIL-9` | `test` exits non-zero when any mailer fails and validates the address once; `preview` renders the sample or `--data`, and `--mime` prints the bytes a client parses              |
| `MAIL-11` | `mailConformance` — the kit a third-party transport must pass                        | `[x]`  | `MAIL-5` | Four named cases: an id, the whole envelope accounted for, a `false` capability refused, and two sends that are two sends                                                        |
| `MAIL-12` | Boundary: the barrel holds no `node:` import                                         | `[x]`  | `MAIL-7` | `smtp` loads `node:net` from `transports/adapters/` at send time; a Worker bundle that never sends SMTP never sees it                                                            |

## As built: two steps, no third

```
compose ──▶ assertCarriable ──▶ transport.send ──▶ DeliveryResult { id, accepted, rejected? }
                    │
                    └── a `false` capability throws here, before the network
```

Four decisions the package makes rather than documents:

- **A capability is a refusal, not a warning.** `log` cannot carry tags, a transport without
  attachment support cannot carry a file, and both say so with `MAIL_UNSUPPORTED_OPERATION` naming
  the transport and the feature. The alternative is a message the caller believes was delivered.
- **`delivers` is a capability.** `log` and `memory` are honest about reaching nobody, which is what
  production reads to refuse them: a password-reset link written to a terminal is a user who cannot
  get in, and that is worse than a bounced message.
- **The address is a security boundary.** `assertKey` is to storage what `parseAddress` is here: a
  newline in an address is a second header, so it is refused before a transport exists.
- **Nothing is guessed.** A content type defaults to `application/octet-stream` and a body has to be
  text or HTML explicitly; a duplicate recipient is a refusal, because two copies of one receipt is
  never what the caller meant.

## As built: seven transports, five facts each

| Transport    | Delivers | HTML | Attachments | Custom headers | Tags | Notes                                                                       |
| ------------ | -------- | ---- | ----------- | -------------- | ---- | --------------------------------------------------------------------------- |
| `log`        | no       | yes  | yes         | yes            | no   | The development default. Prints the message; refused in production          |
| `memory`     | no       | yes  | yes         | yes            | yes  | Collects for tests: `sent()`, `last()`, `find()`                            |
| `cloudflare` | yes      | yes  | yes         | yes            | no   | The Workers Email Sending binding; 50 recipients per message, enforced      |
| `resend`     | yes      | yes  | yes         | yes            | yes  | `fetch`, one `POST /emails`, base64 attachments                             |
| `postmark`   | yes      | yes  | yes         | yes            | no   | `Tags: false` because Postmark has **one `Tag`**, not a map                 |
| `ses`        | yes      | yes  | yes         | yes            | yes  | SES v2, raw MIME, SigV4 borrowed from `@tsir/storage` — no AWS SDK          |
| `smtp`       | yes      | yes  | yes         | yes            | no   | The protocol over an injectable connection; `node:net` lives in the adapter |

Two facts about the table are worth stating: `tags: false` is per-transport (a transport can carry a
body and a file and still have nowhere to put provider metadata), and `ses` sending **raw MIME** is
what makes its capability claims true — the structured SES API has no attachments and no custom
headers, so a transport built on it would be right about everything except what the caller asked for.

## As built: the SMTP client is a conversation, not a socket

`smtp.ts` is the protocol — greeting, `EHLO`, `STARTTLS`, `AUTH PLAIN`/`LOGIN`, `MAIL`, `RCPT`,
`DATA`, `QUIT` — written against a five-method connection object. `transports/adapters/smtp-node.ts`
is the only file in the package that imports `node:net`, and it is loaded **when a send happens**.

That split buys three things:

- the protocol is tested with a scripted connection — every line asserted, no server, no sleep;
- a Worker bundle that sends through Resend never sees `node:net`, which is the sentence
  `§ 4.3` writes about SMTP being a Bun/Lambda transport;
- the buffering bug that matters (a multi-line `250-STARTTLS` reply read as one line) is isolated
  in a file with nothing else in it.

`requireTls` defaults to `true` and refuses to `AUTH` over a plaintext connection. A server that
offers no STARTTLS is a failure with a message, not a password sent in the clear with a warning.

## What the gates check

`bun test src/framework/mail` — 106 tests, six files. `address.test.ts` and `message.test.ts` are
the refusals; `mime.test.ts` asserts the **bytes** (CRLF, no `Bcc`, the alternative inside mixed,
the encoded words); `transports.test.ts` drives five transports through a recording `fetch` and a
recording binding; `smtp.test.ts` drives the protocol with a script; `mailers.test.ts` covers the
registry, the config half and the conformance kit, run over the `memory` transport **and** over two
deliberately broken ones, so the kit is known to fail what it should.

`mail.test.ts` in the console (14 tests) runs each command as a subprocess against a fixture with a
`log`, a `memory` and an unreachable `smtp` mailer — the last one is what a `mail:test` exit code
means, and it is tested by a mailer that really cannot connect.

`make coverage` reports **93.76 % lines / 90.77 % functions** for the package.
