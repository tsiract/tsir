## Example

Create a REST client for a service, and read its state without making a request. Each call made through
the client carries a timeout and a retry policy, and a circuit breaker that stops calls to a failing
service.

```ts
import { createRestClient } from '@tsir/link/rest';

const client = createRestClient({
  baseUrl: 'https://api.example.com',
  timeoutMs: 5_000,
});

console.log(client.target, client.breaker.state());
```

## Failure modes

- `LNK_TIMEOUT`: the call did not finish within its timeout.
- `LNK_CANCELLED`: the caller cancelled the call.
- `LNK_CIRCUIT_OPEN`: the circuit breaker is open after repeated failures, so the call was not made.
  It is retried after the cooldown.
- `LNK_RATE_LIMITED`: the service answered with a rate limit. A `Retry-After` value, when present, is
  respected.
- `LNK_UNAVAILABLE` and `LNK_SERVER`: the service is down or answered with a server error. Retries follow
  the retry policy, and only for safe or idempotent methods.
- `LNK_NOT_FOUND`, `LNK_CONFLICT`, `LNK_INVALID_ARGUMENT`, `LNK_PERMISSION_DENIED`, `LNK_UNAUTHENTICATED`:
  the service answered with a client-side refusal. These are not retried.
- `LNK_URL_NOT_ALLOWED`: the URL's host is not on the allowlist. A client refuses to talk to a host it was
  not configured for.
- `LNK_INVALID_CONFIG`: the client or endpoint configuration is invalid. It is checked at startup.
- `LNK_SCHEMA`: a SOAP message did not match its declared schema.
- `LNK_SOAP_FAULT`: the SOAP service returned a fault. The fault text is kept in the error.
- `LNK_PROTOCOL`: the service answered with something the protocol does not allow.
- `LNK_GRPC_UNAVAILABLE`: gRPC needs Node's HTTP/2 transport, which this runtime does not provide.
- `LNK_WS_CLOSED`: a WebSocket connection closed before the call completed.
- `LNK_ROOM_EMPTY`: a broadcast found no live sockets in the room. It is reported as a log entry, not thrown.
- `LNK_NETWORK`: the request never completed, for example because the connection failed. It is retried
  under the retry policy.
- `LNK_CONTENT_TYPE`: a JSON response was expected, and the server sent another content type.
- `LNK_INVALID_JSON`: the response body was not valid JSON.
- `LNK_BODY_TOO_LARGE`: the response body is over the client's `maxResponseBytes` limit.
- `LNK_WS_BACKPRESSURE`: a WebSocket's outbound buffer is over its limit. The socket closes with code
  1013, and the send may be retried.
- `LNK_WS_SEND_FAILED`: the transport refused a frame. The socket closes with code 1011, and the send is
  not retried.
- `LNK_WS_UNSERIALIZABLE`: the outbound WebSocket message cannot be serialised as JSON.
- `LNK_UNKNOWN`: the failure did not match a known kind.
- `XML_MALFORMED`: the XML is not well formed.
- `XML_UNSAFE`: the XML uses a construct that is refused, such as an external entity or a forbidden key.
- `XML_TOO_LARGE`: the XML is above the size or element limit.

## Security notes

Responses are capped in size, and XML documents are checked for entities and forbidden keys before they
are read. Credentials are supplied by a provider and are not logged. Each client has an allowlist of
hosts, so a configured URL cannot be used to reach an address the client was not set up for. Retries
apply only to methods that are safe to repeat.
