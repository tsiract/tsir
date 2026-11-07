/**
 * @tsir/cashier — billing abstraction (Stripe-compatible).
 *
 * A `BillingProvider` exposes customer, subscription, invoice, checkout,
 * payment-method, coupon, and tax-rate operations. The `stripeProvider` talks
 * to the Stripe API via `fetch` (no SDK needed).
 *
 * Webhook handling: `constructWebhookEvent()` verifies the Stripe signature
 * and returns a typed event.
 */

export interface Customer {
  id: string;
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}

export interface Subscription {
  id: string;
  customerId: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'paused';
  plan: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
}

export interface Invoice {
  id: string;
  customerId: string;
  amountDue: number;
  amountPaid: number;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  hostedInvoiceUrl?: string;
}

/** A Stripe Checkout Session — redirect the user to `url` to pay. */
export interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  customerId?: string;
  paymentIntentId?: string;
}

export interface PaymentMethod {
  id: string;
  type: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface Coupon {
  id: string;
  name?: string;
  percentOff?: number;
  amountOff?: number;
  currency?: string;
  duration: 'forever' | 'once' | 'repeating';
  valid: boolean;
}

export interface TaxRate {
  id: string;
  displayName: string;
  description?: string;
  percentage: number;
  inclusive: boolean;
  active: boolean;
}

export interface BillingProvider {
  createCustomer(input: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<Customer>;
  getCustomer(id: string): Promise<Customer | null>;
  createSubscription(input: { customerId: string; plan: string }): Promise<Subscription>;
  getSubscription(id: string): Promise<Subscription | null>;
  cancelSubscription(id: string, atPeriodEnd?: boolean): Promise<Subscription>;
  listInvoices(customerId: string): Promise<Invoice[]>;

  // Checkout
  createCheckoutSession(input: {
    customerId?: string;
    successUrl: string;
    cancelUrl: string;
    mode?: 'payment' | 'subscription' | 'setup';
    lineItems?: Array<{ price: string; quantity: number }>;
    /** One-time amount in cents when `mode` is `payment` and no price is used. */
    amount?: number;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<CheckoutSession>;
  getCheckoutSession(id: string): Promise<CheckoutSession | null>;

  // Payment methods
  listPaymentMethods(customerId: string): Promise<PaymentMethod[]>;
  attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<PaymentMethod>;
  detachPaymentMethod(paymentMethodId: string): Promise<PaymentMethod>;

  // Coupons
  createCoupon(input: {
    name?: string;
    percentOff?: number;
    amountOff?: number;
    currency?: string;
    duration: 'forever' | 'once' | 'repeating';
    durationInMonths?: number;
  }): Promise<Coupon>;
  getCoupon(id: string): Promise<Coupon | null>;
  listCoupons(): Promise<Coupon[]>;

  // Tax rates
  createTaxRate(input: {
    displayName: string;
    description?: string;
    percentage: number;
    inclusive: boolean;
    active?: boolean;
  }): Promise<TaxRate>;
  listTaxRates(): Promise<TaxRate[]>;
}
