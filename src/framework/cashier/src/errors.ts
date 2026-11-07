/**
 * Cashier (Stripe) error codes.
 *
 * API request failures and webhook verification failures.
 */
import { TsirError } from '@tsir/container';

export type CashierErrorCode =
  | 'STRIPE_REQUEST_FAILED'
  | 'STRIPE_WEBHOOK_BAD_HEADER'
  | 'STRIPE_WEBHOOK_BAD_SIGNATURE'
  | 'STRIPE_WEBHOOK_BAD_TIMESTAMP'
  | 'STRIPE_WEBHOOK_TOO_OLD';

/** A Stripe API request failed. */
export function stripeRequestFailed(
  message: string,
  context?: Record<string, string | number | boolean>,
): TsirError {
  return new TsirError('STRIPE_REQUEST_FAILED', message, {
    kind: 'internal',
    ...(context !== undefined ? { context } : {}),
  });
}

/** The Stripe webhook signature header is missing or malformed. */
export function stripeWebhookBadHeader(): TsirError {
  return new TsirError(
    'STRIPE_WEBHOOK_BAD_HEADER',
    'stripe webhook signature header is missing or malformed',
    {
      kind: 'internal',
    },
  );
}

/** The Stripe webhook signature did not verify. */
export function stripeWebhookBadSignature(): TsirError {
  return new TsirError(
    'STRIPE_WEBHOOK_BAD_SIGNATURE',
    'stripe webhook signature verification failed',
    {
      kind: 'internal',
    },
  );
}

/** The Stripe webhook timestamp could not be parsed. */
export function stripeWebhookBadTimestamp(): TsirError {
  return new TsirError('STRIPE_WEBHOOK_BAD_TIMESTAMP', 'stripe webhook timestamp is invalid', {
    kind: 'internal',
  });
}

/** The Stripe webhook timestamp is outside the tolerance window. */
export function stripeWebhookTooOld(): TsirError {
  return new TsirError(
    'STRIPE_WEBHOOK_TOO_OLD',
    'stripe webhook timestamp is outside the tolerance window',
    {
      kind: 'internal',
    },
  );
}
