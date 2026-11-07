import { afterEach, describe, expect, test } from 'bun:test';
import { stripeProvider } from './stripe.ts';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

function mockFetch(responses: Record<string, unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const body = responses[key];
    if (body === undefined) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = original);
  return calls;
}

function formBody(init: RequestInit): Record<string, string> {
  const params = new URLSearchParams(init.body as string);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

describe('stripe provider', () => {
  test('createCheckoutSession with line items maps the response', async () => {
    mockFetch({
      'POST https://api.stripe.com/v1/checkout/sessions': {
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/pay/cs_test_1',
        status: 'open',
        customer: 'cus_1',
        payment_intent: 'pi_1',
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const session = await provider.createCheckoutSession({
      customerId: 'cus_1',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      mode: 'subscription',
      lineItems: [{ price: 'price_1', quantity: 1 }],
    });
    expect(session.id).toBe('cs_test_1');
    expect(session.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(session.status).toBe('open');
    expect(session.customerId).toBe('cus_1');
    expect(session.paymentIntentId).toBe('pi_1');
  });

  test('createCheckoutSession with amount builds a price_data line item', async () => {
    const calls = mockFetch({
      'POST https://api.stripe.com/v1/checkout/sessions': {
        id: 'cs_test_2',
        url: null,
        status: 'open',
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    await provider.createCheckoutSession({
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      amount: 5000,
      currency: 'usd',
    });
    const body = formBody(calls[0]!.init);
    expect(body['line_items[0][price_data][unit_amount]']!).toBe('5000');
    expect(body['line_items[0][price_data][currency]']!).toBe('usd');
    expect(body['line_items[0][price_data][product_data][name]']!).toBe('Payment');
  });

  test('getCheckoutSession maps the response', async () => {
    mockFetch({
      'GET https://api.stripe.com/v1/checkout/sessions/cs_1': {
        id: 'cs_1',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
        status: 'complete',
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const session = await provider.getCheckoutSession('cs_1');
    expect(session?.status).toBe('complete');
  });

  test('listPaymentMethods maps card fields', async () => {
    mockFetch({
      'GET https://api.stripe.com/v1/customers/cus_1/payment_methods': {
        data: [
          {
            id: 'pm_1',
            type: 'card',
            card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 },
          },
        ],
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const methods = await provider.listPaymentMethods('cus_1');
    expect(methods).toHaveLength(1);
    expect(methods[0]!.brand).toBe('visa');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]!.expMonth).toBe(12);
    expect(methods[0]!.expYear).toBe(2028);
  });

  test('attachPaymentMethod posts the customer id', async () => {
    const calls = mockFetch({
      'POST https://api.stripe.com/v1/payment_methods/pm_1/attach': {
        id: 'pm_1',
        type: 'card',
        card: { brand: 'visa', last4: '4242' },
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const pm = await provider.attachPaymentMethod('pm_1', 'cus_1');
    expect(pm.id).toBe('pm_1');
    expect(formBody(calls[0]!.init).customer!).toBe('cus_1');
  });

  test('detachPaymentMethod hits the detach endpoint', async () => {
    mockFetch({
      'POST https://api.stripe.com/v1/payment_methods/pm_1/detach': {
        id: 'pm_1',
        type: 'card',
        card: {},
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const pm = await provider.detachPaymentMethod('pm_1');
    expect(pm.id).toBe('pm_1');
  });

  test('createCoupon with percent_off maps correctly', async () => {
    mockFetch({
      'POST https://api.stripe.com/v1/coupons': {
        id: 'co_1',
        name: 'Summer Sale',
        percent_off: 20,
        duration: 'once',
        valid: true,
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const coupon = await provider.createCoupon({
      name: 'Summer Sale',
      percentOff: 20,
      duration: 'once',
    });
    expect(coupon.id).toBe('co_1');
    expect(coupon.percentOff).toBe(20);
    expect(coupon.duration).toBe('once');
    expect(coupon.valid).toBe(true);
  });

  test('getCoupon and listCoupons map responses', async () => {
    mockFetch({
      'GET https://api.stripe.com/v1/coupons/co_1': {
        id: 'co_1',
        amount_off: 500,
        currency: 'usd',
        duration: 'forever',
        valid: true,
      },
      'GET https://api.stripe.com/v1/coupons': {
        data: [{ id: 'co_1', duration: 'forever', valid: true }],
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const coupon = await provider.getCoupon('co_1');
    expect(coupon?.amountOff).toBe(500);
    expect(coupon?.currency).toBe('usd');
    const list = await provider.listCoupons();
    expect(list).toHaveLength(1);
  });

  test('createTaxRate and listTaxRates map responses', async () => {
    mockFetch({
      'POST https://api.stripe.com/v1/tax_rates': {
        id: 'txr_1',
        display_name: 'VAT',
        description: 'EU VAT',
        percentage: 20,
        inclusive: false,
        active: true,
      },
      'GET https://api.stripe.com/v1/tax_rates': {
        data: [
          { id: 'txr_1', display_name: 'VAT', percentage: 20, inclusive: false, active: true },
        ],
      },
    });
    const provider = stripeProvider({ secretKey: 'sk_test' });
    const rate = await provider.createTaxRate({
      displayName: 'VAT',
      description: 'EU VAT',
      percentage: 20,
      inclusive: false,
    });
    expect(rate.id).toBe('txr_1');
    expect(rate.percentage).toBe(20);
    expect(rate.inclusive).toBe(false);
    const list = await provider.listTaxRates();
    expect(list).toHaveLength(1);
    expect(list[0]!.displayName).toBe('VAT');
  });
});
