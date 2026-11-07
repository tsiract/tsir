/**
 * @tsir/cashier — billing (Stripe-compatible).
 *
 * ```ts
 * import { createCashierBootstrap, stripeProvider } from '@tsir/cashier';
 *
 * const { provider } = createCashierBootstrap({
 *   provider: stripeProvider({ secretKey: env.STRIPE_SECRET_KEY }),
 * });
 *
 * const customer = await provider.createCustomer({ email: 'user@example.com' });
 * const sub = await provider.createSubscription({ customerId: customer.id, plan: 'price_xxx' });
 * ```
 */

export type {
  BillingProvider,
  CheckoutSession,
  Coupon,
  Customer,
  Invoice,
  PaymentMethod,
  Subscription,
  TaxRate,
} from './types.ts';

export { stripeProvider, type StripeProviderOptions } from './stripe.ts';
export { constructWebhookEvent, type WebhookEvent } from './webhooks.ts';

export { createCashierBootstrap } from './bootstrap.ts';
export type { CashierBootstrap, CashierBootstrapOptions } from './bootstrap.ts';
