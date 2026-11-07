/**
 * One-call bootstrap for `@tsir/cashier`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import type { BillingProvider } from './types.ts';

export interface CashierBootstrapOptions {
  readonly provider: BillingProvider;
}

export interface CashierBootstrap {
  readonly provider: BillingProvider;
  readonly billingProviderToken: Token<BillingProvider>;
  readonly billingProviderProvider: Provider<BillingProvider>;
}

export function createCashierBootstrap(options: CashierBootstrapOptions): CashierBootstrap {
  const provider = options.provider;
  const billingProviderToken = token<BillingProvider>('billingProvider');
  const billingProviderProvider = valueProvider(billingProviderToken, provider);
  return { provider, billingProviderToken, billingProviderProvider };
}
