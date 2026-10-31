## Example

Create a mailer on a transport and send a message through it. The memory transport keeps messages
in the process, so a test can check what was sent without a provider.

```ts
import { createMailer } from '@tsir/mail';
import { memoryTransport } from '@tsir/mail/memory';

const transport = memoryTransport();
const mailer = createMailer({ transport, from: 'Tsir <no-reply@tsir.local>' });

await mailer.send({
  to: ['ana@example.com'],
  subject: 'Your receipt',
  text: 'Thanks for your order.',
});

console.log(transport.count());
```

## Failure modes

- `MAIL_UNKNOWN_MAILER`: a mailer name was used that is not declared. A mailer is never resolved by
  falling back to the default.
- `MAIL_UNKNOWN_DEFAULT`: the default names a mailer that is not declared.
- `MAIL_NO_MAILERS`: no mailers are declared.
- `MAIL_DRIVER_MISSING`: a mailer names a transport this build does not ship.
- `MAIL_CONFIG_INVALID`: a mailer cannot be built, for example because a required key or environment
  variable is missing.
- `MAIL_INVALID_ADDRESS`: an address was refused. An address is `local@domain` or
  `Name <local@domain>`. A display name is quoted, so it cannot inject a second header.
- `MAIL_INVALID_MESSAGE`: a message was refused before it was sent. The message names the rule.
- `MAIL_UNKNOWN_TEMPLATE`: a template name was used that is not exported.
- `MAIL_UNSUPPORTED_OPERATION`: the transport cannot carry something the message asks for, such as an
  attachment or a tag. The message names the transport and the feature.
- `MAIL_FORBIDDEN_IN_PRODUCTION`: a mailer uses the `log` transport in production, which delivers
  nothing.
- `MAIL_TRANSPORT_FAILED`: the provider refused the message. The message carries the provider's own
  answer, so check the key, the verified sender domain and the recipient.

## Security notes

Addresses and subjects are validated before a transport sees them, so user input cannot add a header.
The `log` transport writes message content to its output, so it is for development only, and it is
refused in production. Provider keys are read from named environment references and are not written
to the message. Keep templates free of secrets, because the rendered text is delivered to the
recipient and may be forwarded.
