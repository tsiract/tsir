## Example

Billing is a provider port plus one piece of cryptography that is not optional: the webhook
signature. `constructWebhookEvent` verifies it the way Stripe's own library does, with the Web Crypto
API, so a Worker can do it without a Node polyfill.

```ts
import { createHmac } from 'node:crypto';
import { constructWebhookEvent } from '@tsir/cashier';

// What Stripe sends: `t=<unix seconds>,v1=<hmac-sha256 of "<t>.<body>">`.
const secret = 'whsec_example';
const body = JSON.stringify({
  id: 'evt_1',
  type: 'invoice.paid',
  created: 1_700_000_000,
  data: { object: {} },
});
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const event = await constructWebhookEvent(body, `t=${timestamp},v1=${signature}`, secret);
console.log(event.type, event.id);

// The same header with one character changed is refused, not accepted with a warning.
const tampered = `t=${timestamp},v1=${signature.slice(0, -1)}0`;
await constructWebhookEvent(body, tampered, secret).catch((error: { format?: () => string }) => {
  console.log(error.format?.().split('\n')[0]);
});
```

## Failure modes

- `STRIPE_WEBHOOK_BAD_HEADER`: the `stripe-signature` header is missing or has no `t`/`v1` pair.
  Something in front of the application is rewriting headers — a proxy, or a body parser that consumed
  the raw body.
- `STRIPE_WEBHOOK_BAD_SIGNATURE`: the HMAC did not match. Either the signing secret is wrong (the
  common case after rotating it, or after copying the endpoint's secret instead of the one you set), or
  the body was parsed and re-serialised before verification, which changes the bytes the signature
  covers.
- `STRIPE_WEBHOOK_BAD_TIMESTAMP`: the `t` value is not a number. The header is present but malformed.
- `STRIPE_WEBHOOK_TOO_OLD`: the timestamp is outside the tolerance window. This is the replay guard:
  a captured request replayed an hour later is refused even with a valid signature.
- `STRIPE_REQUEST_FAILED`: a Stripe API call returned an error. The message carries the status and
  Stripe's own error code, because "card_declined" and "api_key_expired" need different responses and
  only one of them is the customer's problem.

## Security notes

**Verify before you read.** The webhook body is the only place where a caller can tell the application
that money arrived, so it is signed; `constructWebhookEvent` must be the first thing called with the
raw body, before any JSON parsing, because parsing and re-serialising produces different bytes and the
signature is over bytes.

The window is a replay guard, not a clock-accuracy test. It is deliberately short; a legitimate
retry that arrives outside it is dropped and Stripe sends it again.

The `v1` comparison is constant-time. A timing side channel on a signature check is theoretical on a
Worker and free to avoid, and the alternative is a function that looks correct and is not.

`stripeProvider`'s `secretKey` is read from the environment, never from a literal in `tsir.js` — the
same rule every secret in the framework follows. A restricted key (`rk_`) that can only touch the
endpoints this application uses is the right scope for a server that never needs the dashboard.
