## Example

Turn a compiled route table into a request handler. The handler takes a standard `Request` and
returns a standard `Response`, so the same code runs under Bun, Workers and Lambda.

```ts
import { createFetchHandler } from '@tsir/http';
import { Controller, Get, RouteRegistry, compileRoutes } from '@tsir/router';

const registry = new RouteRegistry();

@Controller(registry, '/hello')
class HelloController {
  @Get('/')
  greet(): { message: string } {
    return { message: 'hello' };
  }
}

const handler = createFetchHandler(compileRoutes(registry.entries()));
const response = await handler(new Request('http://localhost/hello'));

console.log(response.status, await response.text());
```

## Failure modes

Every failure is returned as an RFC 9457 problem document. The `code` field names the failure.

- `HTP_ROUTE_NOT_FOUND` (404): no route matches the path.
- `HTP_METHOD_NOT_ALLOWED` (405): the path exists, but not for this method.
- `HTP_UNSUPPORTED_MEDIA_TYPE` (415): the request body has a content type the route does not accept.
- `HTP_NOT_ACCEPTABLE` (406): the client's `Accept` header rules out every type the route can return.
- `HTP_BAD_REQUEST` (400): the request path is malformed.
- `HTP_MALFORMED_BODY` (400): the body does not parse as its declared type.
- `HTP_MIME_MISMATCH` (422): an uploaded file's content does not match its declared type.
- `HTP_BODY_TOO_LARGE` (413): the body is over the limit set for the route or the handler.
- `HTP_VALIDATION_FAILED` (422): the request's parameters, query or body fail the route's schema.
- `HTP_UNAUTHENTICATED` (401) and `HTP_FORBIDDEN` (403): a guard or policy refused the request.
- `HTP_TIMEOUT` (504): the handler did not finish within the time limit.
- `HTP_RESPONSE_INVALID` (500): the handler returned a value that does not match the route's response schema.
- `HTP_BODY_NOT_ALLOWED` (500): the handler returned a body for a status that cannot carry one, such as 204 or 304. This is a framework error, not a caller error.
- `HTP_HANDLER_ERROR` (500): the handler threw. The message is replaced with a generic one, and the
  request id is returned so the failure can be found in logs.
- `HTP_CORS_WILDCARD_CREDENTIALS`: the CORS configuration allows any origin while also allowing
  credentials. The handler is not created.
- `HTP_UNKNOWN_GUARD`, `HTP_UNKNOWN_POLICY`, `HTP_UNKNOWN_MIDDLEWARE`: the route refers to a guard,
  policy or middleware that was never registered.
- `HTP_MIDDLEWARE_NEXT_TWICE`: a middleware called `next()` more than once.
- `HTP_BAD_HANDLER`: a route's handler was missing when a request reached it. Each of these is a
  programming error.

## Security notes

Request bodies are read with a size limit before any parsing, and a body that exceeds it is refused
without being buffered in full. Validation runs before the handler, so the handler only sees values
that match its declared schema. Error responses never include stack traces or the messages of
internal exceptions; `HTP_HANDLER_ERROR` replaces them with a generic message. CORS refuses the
combination of a wildcard origin with credentials, because a browser would accept it and leak
authenticated responses to any site.
