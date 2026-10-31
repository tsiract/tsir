## Example

Validate an input with any Standard Schema library and read the typed result.

```ts
import { z } from 'zod';
import { validate } from '@tsir/validate';

const Signup = z.object({
  email: z.string().email(),
  age: z.number().int().min(13),
});

const result = await validate(Signup, { email: 'not-an-email', age: 12 });

if (result.ok) {
  console.log(result.value.email);
} else {
  console.log(result.issues.map((issue) => issue.path.join('.')));
}
```

## Failure modes

- `VLD_INVALID`: the input did not match the schema. `validate()` returns every issue, not only the
  first one, and each issue names its path. `parse()` throws the same issues as a `ValidationError`.
- `VLD_NOT_STANDARD_SCHEMA`: the value passed as a schema does not implement Standard Schema. Use a
  schema library that does, such as Zod 4.
- `VLD_ASYNC_SCHEMA`: `validateSync()` was given a schema that validates asynchronously. Use
  `validate()`, which awaits the schema.

## Security notes

Validation decides whether a value has the right shape. It does not decide whether the caller may
use it, and it does not sanitize strings for a particular sink such as HTML or SQL. Those belong to
the code that uses the value. Use `withUnknownKeys` or `unknownKeysPolicy` to decide what happens to
keys that the schema does not name, rather than accepting them silently.
