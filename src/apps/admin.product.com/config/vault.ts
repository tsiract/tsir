// config/vault.ts — the encryption keyring.
//
// The vault encrypts PII columns (e.g. `users.tax_id`) with AES-256-GCM. The
// active key is read from the `APP_KEY_NOW` environment variable by the vault
// service; generate one with `tsir vault:key:generate`. For local dev and
// tests, the service falls back to a generated local key so the app boots
// without a secret.
//
// Never commit a real key. The `now` field below is only a placeholder; the
// actual key material comes from `APP_KEY_NOW`.
export default {
  // The active key id used for new encryptions. The service reads the key
  // material from `APP_KEY_NOW`.
  now: '',
  // Decrypt-only key ids (for key rotation). Empty until a key is retired.
  previous: [] as string[],
};
