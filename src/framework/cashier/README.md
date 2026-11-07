# `@tsir/cashier`

Billing abstraction over Stripe's REST API (no SDK dependency). Talks to Stripe via
`fetch`, verifies webhook signatures with `node:crypto`, and exposes a single
`BillingProvider` port so a second provider (Paddle, etc.) can be dropped in
without touching call sites.

## What's included

| Capability      | Methods                                                            |
| --------------- | ------------------------------------------------------------------ |
| Customers       | `createCustomer`, `getCustomer`                                    |
| Subscriptions   | `createSubscription`, `getSubscription`, `cancelSubscription`      |
| Invoices        | `listInvoices`                                                     |
| Checkout        | `createCheckoutSession`, `getCheckoutSession`                      |
| Payment methods | `listPaymentMethods`, `attachPaymentMethod`, `detachPaymentMethod` |
| Coupons         | `createCoupon`, `getCoupon`, `listCoupons`                         |
| Tax rates       | `createTaxRate`, `listTaxRates`                                    |
| Webhooks        | `constructWebhookEvent` (signature + timestamp verified)           |

## Checkout

```ts
const session = await provider.createCheckoutSession({
  customerId: 'cus_123',
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing',
  mode: 'subscription',
  lineItems: [{ price: 'price_monthly', quantity: 1 }],
});
// redirect the user to session.url
```

For one-time payments without a pre-created price, pass `amount` (cents) and
`currency`; the provider builds an inline `price_data` line item.

## Payment methods

A payment method is attached to a customer before it can be charged:

```ts
const methods = await provider.listPaymentMethods('cus_123');
await provider.attachPaymentMethod('pm_123', 'cus_123');
await provider.detachPaymentMethod('pm_123');
```

## Coupons and tax

Coupons are either `percent_off` or `amount_off`, with a `duration` of
`forever`, `once`, or `repeating`. Tax rates are `percentage` with an
`inclusive` flag; both are returned as typed objects.

## Webhooks

`constructWebhookEvent(payload, signatureHeader, secret)` verifies the Stripe
signature and rejects stale timestamps. Use it inside your webhook handler before
trusting the event type.
