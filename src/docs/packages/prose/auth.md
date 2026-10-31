## Example

Hash a password once at signup, then verify it at login. The hash carries its own algorithm and
parameters, so an old hash is still checked with the settings it was made with.

```ts
import { pbkdf2Hasher } from '@tsir/auth';

const hasher = pbkdf2Hasher();
const stored = await hasher.hash('correct horse battery staple');

console.log(await hasher.verify('correct horse battery staple', stored));
console.log(await hasher.verify('wrong guess', stored));
```

## Failure modes

- `AUTH_WEAK_PASSWORD`: the password does not meet the policy. The check runs before hashing, so it costs
  nothing. Raise `minLength` or require more character classes in the hasher options.
- `AUTH_INVALID_CREDENTIALS`: the email and password do not match an account. The message is the same
  for an unknown user and a wrong password, so the difference cannot be used to list accounts.
- `AUTH_INVALID_HASH`: the stored value is not a `$tsir$` hash. A hash from another library will not
  verify, and the package refuses rather than guess.
- `AUTH_UNSUPPORTED_HASH`: no hasher in this build can verify the stored algorithm. Such an account
  cannot log in, so the failure is explicit rather than a wrong-password message.
- `AUTH_INVALID_TOKEN`: a session or API token is malformed. It is refused before any store is read.
- `AUTH_SESSION_EXPIRED`: the absolute lifetime has passed, or the idle timeout has. Both revoke the
  session. Neither refreshes it.
- `AUTH_SESSION_REVOKED`: the session ended through logout, a password change or a rotation.
- `AUTH_SESSION_STORE_FAILED`: the session store could not be read. The request fails closed, so nobody
  is authenticated.
- `AUTH_API_KEY_INVALID`: an API key is unknown, has the wrong secret, or has expired. All three give the
  same answer.
- `AUTH_API_KEY_REVOKED`: an API key was revoked, even if its secret is correct.
- `AUTH_CONFIG_INVALID`: the `auth` block in `tsir.js` is invalid. It is checked at boot.

## Security notes

Passwords are hashed with PBKDF2-SHA256, using at least 100,000 iterations and 210,000 by default, with a
fresh random salt for each hash. Session and API tokens are opaque random bytes, and only a hash of each
token is stored. Sessions have an absolute lifetime and an idle timeout, and both revoke. Verification is
constant-time. Authentication failures are reported without saying which part was wrong.
