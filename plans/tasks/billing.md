# Tasks — `@tsir/billing` (← cashier) (Phase 10)

> Stripe-compatible billing: customers, subscriptions, invoices, coupons, tax rates, payment
> methods, checkout sessions, and webhook verification. All eight Stripe features are complete. The
> remaining work is a second provider — Paddle — so the port is genuinely multi-provider and not a
> Stripe-shaped interface with one implementation.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) · **Related:**
> [`vault.md`](./05-vault.md) (webhook signature verification, already done).

**Status: in progress.** Stripe provider is complete (8/9 features). One feature remains: Paddle
support.

## Tasks

| ID       | Task                                                        | Status | Depends                    | Acceptance                                                                                                                                                                       |
| -------- | ----------------------------------------------------------- | ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILL-1` | `BillingProvider` port — customers, subscriptions, invoices | `[x]`  | —                          | `createCustomer`, `createSubscription`, `cancelSubscription`, `getSubscription`, `listInvoices`; the port is provider-agnostic                                                   |
| `BILL-2` | Coupons, tax rates, payment methods, checkout               | `[x]`  | `BILL-1`                   | `createCoupon`, `listCoupons`, `createTaxRate`, `listTaxRates`, `listPaymentMethods`, `attachPaymentMethod`, `detachPaymentMethod`, `createCheckoutSession`                      |
| `BILL-3` | Webhook verification — signature + timestamp tolerance      | `[x]`  | —                          | `constructWebhookEvent` verifies the signature and rejects stale timestamps; a bad signature is a coded error, not a log line                                                    |
| `BILL-4` | `stripeProvider` — full Stripe REST over `fetch`            | `[x]`  | `BILL-1`,`BILL-2`,`BILL-3` | No Stripe SDK; raw `fetch` with bearer auth; errors map to `BILLING_*` codes                                                                                                     |
| `BILL-5` | `paddleProvider` — Paddle Billing API                       | `[ ]`  | `BILL-1`                   | Follows the same app-supplied-client rule: a `PaddleLike` client with the handful of calls the port needs; no SDK dependency; webhook verification for Paddle's signature scheme |

## Design notes

**The port is the contract.** `BILL-1`–`BILL-3` define the provider-agnostic surface. `BILL-4` and
`BILL-5` are two implementations of it. A generated app picks a provider in `tsir.js` and never
touches Stripe- or Paddle-specific code.

**Paddle is the forcing function.** Without a second provider, `BillingProvider` is just Stripe's
shape with a different name. Paddle's different model (transactions vs. subscriptions, different
webhook signatures) forces the port to be genuinely abstract. If the port bends to fit Paddle,
that's a signal it was too Stripe-shaped.

**No SDKs.** Both providers use raw `fetch`. The Stripe SDK pulls in `axios`, `form-data`, and a
transitive tree that breaks the Workers bundle. Paddle's SDK has the same problem. `BILL-4` and
`BILL-5` are hand-rolled REST calls with typed responses.

**What the gates check.** `bun test src/framework/cashier` covers the Stripe provider against a
fake `fetch` and the webhook verifier against forged signatures. `BILL-5` adds the same for Paddle.
