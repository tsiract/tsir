/**
 * Stripe billing provider.
 *
 * Talks to the Stripe REST API directly via `fetch`. No SDK dependency.
 * Uses the secret key for server-side calls and the webhook signing secret
 * for event verification.
 */
import { stripeRequestFailed } from './errors.ts';
import type {
  BillingProvider,
  CheckoutSession,
  Coupon,
  Customer,
  Invoice,
  PaymentMethod,
  Subscription,
  TaxRate,
} from './types.ts';

export interface StripeProviderOptions {
  secretKey: string;
  /** Webhook signing secret (whsec_...). */
  webhookSecret?: string;
  /** API version. Default: 2024-06-20. */
  apiVersion?: string;
  baseUrl?: string;
}

/** Coerce a Stripe field to a string only when it is already a primitive. */
function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v); // coercion-ok: documented Stripe numeric field arriving as string
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Encode a flat or nested object into Stripe's form-encoded format.
 *
 * - Primitives → `key=value`
 * - Plain objects → `key[nested]=value`
 * - Arrays → `key[0][nested]=value`
 */
function encodeBody(obj: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${k}]`, v);
      }
    } else {
      params.set(prefix, asString(value));
    }
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return params.toString();
}

export function stripeProvider(options: StripeProviderOptions): BillingProvider {
  const baseUrl = options.baseUrl ?? 'https://api.stripe.com/v1';
  const apiVersion = options.apiVersion ?? '2024-06-20';
  const auth = `Bearer ${options.secretKey}`;

  async function request<T>(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        'Stripe-Version': apiVersion,
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body !== undefined ? { body: encodeBody(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw stripeRequestFailed(`Stripe ${method} ${path} failed: ${res.status} ${text}`, {
        status: res.status,
      });
    }
    return (await res.json()) as T;
  }

  function mapCustomer(raw: Record<string, unknown>): Customer {
    const email = typeof raw.email === 'string' ? raw.email : undefined;
    const name = typeof raw.name === 'string' ? raw.name : undefined;
    return {
      id: asString(raw.id),
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(raw.metadata !== undefined ? { metadata: raw.metadata as Record<string, string> } : {}),
    };
  }

  function mapSubscription(raw: Record<string, unknown>): Subscription {
    const items = raw.items as { data: Array<{ plan: { id: string } }> };
    return {
      id: asString(raw.id),
      customerId: asString(raw.customer),
      status: raw.status as Subscription['status'],
      plan: items.data[0]?.plan.id ?? '',
      // coercion-ok: Stripe's `current_period_end` is a documented Unix timestamp (integer); a successful API response guarantees a number.
      currentPeriodEnd: Number(raw.current_period_end),
      cancelAtPeriodEnd: Boolean(raw.cancel_at_period_end),
    };
  }

  function mapInvoice(raw: Record<string, unknown>): Invoice {
    const hostedInvoiceUrl =
      typeof raw.hosted_invoice_url === 'string' ? raw.hosted_invoice_url : undefined;
    return {
      id: asString(raw.id),
      customerId: asString(raw.customer),
      // coercion-ok: Stripe's `amount_due` / `amount_paid` are documented integer cents in every invoice response.
      amountDue: Number(raw.amount_due),
      amountPaid: Number(raw.amount_paid),
      status: raw.status as Invoice['status'],
      ...(hostedInvoiceUrl !== undefined ? { hostedInvoiceUrl } : {}),
    };
  }

  function mapCheckoutSession(raw: Record<string, unknown>): CheckoutSession {
    const customerId = raw.customer ? asString(raw.customer) : undefined;
    const paymentIntentId = raw.payment_intent ? asString(raw.payment_intent) : undefined;
    return {
      id: asString(raw.id),
      url: typeof raw.url === 'string' ? raw.url : null,
      status: raw.status as CheckoutSession['status'],
      ...(customerId !== undefined ? { customerId } : {}),
      ...(paymentIntentId !== undefined ? { paymentIntentId } : {}),
    };
  }

  function mapPaymentMethod(raw: Record<string, unknown>): PaymentMethod {
    const card = (raw.card ?? {}) as Record<string, unknown>;
    const result: PaymentMethod = {
      id: asString(raw.id),
      type: asString(raw.type) || 'card',
    };
    if (card.brand !== undefined) result.brand = asString(card.brand);
    if (card.last4 !== undefined) result.last4 = asString(card.last4);
    const expMonth = asNumber(card.exp_month);
    if (expMonth !== undefined) result.expMonth = expMonth;
    const expYear = asNumber(card.exp_year);
    if (expYear !== undefined) result.expYear = expYear;
    return result;
  }

  function mapCoupon(raw: Record<string, unknown>): Coupon {
    return {
      id: asString(raw.id),
      ...(raw.name !== undefined && raw.name !== null ? { name: asString(raw.name) } : {}),
      ...(raw.percent_off !== undefined && raw.percent_off !== null
        ? { percentOff: Number(raw.percent_off) } // coercion-ok: Stripe `percent_off` is a documented number
        : {}),
      ...(raw.amount_off !== undefined && raw.amount_off !== null
        ? { amountOff: Number(raw.amount_off) } // coercion-ok: Stripe `amount_off` is a documented number in cents
        : {}),
      ...(raw.currency !== undefined && raw.currency !== null
        ? { currency: asString(raw.currency) }
        : {}),
      duration: raw.duration as Coupon['duration'],
      valid: Boolean(raw.valid),
    };
  }

  function mapTaxRate(raw: Record<string, unknown>): TaxRate {
    return {
      id: asString(raw.id),
      displayName: asString(raw.display_name),
      ...(raw.description !== undefined && raw.description !== null
        ? { description: asString(raw.description) }
        : {}),
      percentage: Number(raw.percentage), // coercion-ok: Stripe `percentage` is a documented number
      inclusive: Boolean(raw.inclusive),
      active: Boolean(raw.active),
    };
  }

  return {
    async createCustomer(input) {
      const raw = await request<Record<string, unknown>>('/customers', 'POST', input);
      return mapCustomer(raw);
    },
    async getCustomer(id) {
      const raw = await request<Record<string, unknown>>(`/customers/${id}`, 'GET');
      return mapCustomer(raw);
    },
    async createSubscription(input) {
      const raw = await request<Record<string, unknown>>('/subscriptions', 'POST', {
        customer: input.customerId,
        items: [{ price: input.plan }],
      });
      return mapSubscription(raw);
    },
    async getSubscription(id) {
      const raw = await request<Record<string, unknown>>(`/subscriptions/${id}`, 'GET');
      return mapSubscription(raw);
    },
    async cancelSubscription(id, atPeriodEnd = true) {
      const raw = await request<Record<string, unknown>>(`/subscriptions/${id}`, 'POST', {
        cancel_at_period_end: atPeriodEnd,
      });
      return mapSubscription(raw);
    },
    async listInvoices(customerId) {
      const raw = await request<{ data: Record<string, unknown>[] }>(
        `/invoices?customer=${customerId}`,
        'GET',
      );
      return raw.data.map(mapInvoice);
    },

    async createCheckoutSession(input) {
      const body: Record<string, unknown> = {
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        mode: input.mode ?? 'payment',
      };
      if (input.customerId) body.customer = input.customerId;
      if (input.metadata) body.metadata = input.metadata;
      if (input.lineItems && input.lineItems.length > 0) {
        body.line_items = input.lineItems.map((li) => ({ price: li.price, quantity: li.quantity }));
      } else if (input.amount !== undefined) {
        body.line_items = [
          {
            price_data: {
              currency: input.currency ?? 'usd',
              unit_amount: input.amount,
              product_data: { name: 'Payment' },
            },
            quantity: 1,
          },
        ];
      }
      const raw = await request<Record<string, unknown>>('/checkout/sessions', 'POST', body);
      return mapCheckoutSession(raw);
    },
    async getCheckoutSession(id) {
      const raw = await request<Record<string, unknown>>(`/checkout/sessions/${id}`, 'GET');
      return mapCheckoutSession(raw);
    },

    async listPaymentMethods(customerId) {
      const raw = await request<{ data: Record<string, unknown>[] }>(
        `/customers/${customerId}/payment_methods`,
        'GET',
      );
      return raw.data.map(mapPaymentMethod);
    },
    async attachPaymentMethod(paymentMethodId, customerId) {
      const raw = await request<Record<string, unknown>>(
        `/payment_methods/${paymentMethodId}/attach`,
        'POST',
        { customer: customerId },
      );
      return mapPaymentMethod(raw);
    },
    async detachPaymentMethod(paymentMethodId) {
      const raw = await request<Record<string, unknown>>(
        `/payment_methods/${paymentMethodId}/detach`,
        'POST',
      );
      return mapPaymentMethod(raw);
    },

    async createCoupon(input) {
      const body: Record<string, unknown> = { duration: input.duration };
      if (input.name) body.name = input.name;
      if (input.percentOff !== undefined) body.percent_off = input.percentOff;
      if (input.amountOff !== undefined) body.amount_off = input.amountOff;
      if (input.currency) body.currency = input.currency;
      if (input.durationInMonths !== undefined) body.duration_in_months = input.durationInMonths;
      const raw = await request<Record<string, unknown>>('/coupons', 'POST', body);
      return mapCoupon(raw);
    },
    async getCoupon(id) {
      const raw = await request<Record<string, unknown>>(`/coupons/${id}`, 'GET');
      return mapCoupon(raw);
    },
    async listCoupons() {
      const raw = await request<{ data: Record<string, unknown>[] }>('/coupons', 'GET');
      return raw.data.map(mapCoupon);
    },

    async createTaxRate(input) {
      const raw = await request<Record<string, unknown>>('/tax_rates', 'POST', {
        display_name: input.displayName,
        ...(input.description !== undefined ? { description: input.description } : {}),
        percentage: input.percentage,
        inclusive: input.inclusive,
        ...(input.active !== undefined ? { active: input.active } : {}),
      });
      return mapTaxRate(raw);
    },
    async listTaxRates() {
      const raw = await request<{ data: Record<string, unknown>[] }>('/tax_rates', 'GET');
      return raw.data.map(mapTaxRate);
    },
  };
}
