# `@tsir/link`

One package for service-to-service calls, with an entrypoint per protocol: REST (`@tsir/link`),
gRPC (`@tsir/link/grpc`), SOAP (`@tsir/link/soap`) and WebSockets + rooms (`@tsir/link/ws`).

## Capability matrix

| Capability           | Bun                     | Cloudflare Workers               | AWS Lambda                       |
| -------------------- | ----------------------- | -------------------------------- | -------------------------------- |
| REST client          | ✅ `fetch`              | ✅                               | ✅                               |
| REST server          | ✅ via `@tsir/http/bun` | ✅ via `@tsir/deploy/cloudflare` | ✅ via `@tsir/deploy/lambda`     |
| gRPC client          | ✅                      | ❌ (no raw sockets)              | ✅                               |
| gRPC server          | ✅                      | ❌                               | ✅ (ALB gRPC / API GW)           |
| SOAP client          | ✅                      | ✅ (fetch + XML)                 | ✅                               |
| SOAP server          | ✅                      | ✅                               | ✅                               |
| WS client            | ✅                      | ✅ (`fetch` upgrade, DO-backed)  | ✅ (custom domain)               |
| WS server            | ✅                      | ✅ (Durable Objects)             | ⚠️ API GW WebSocket adapter only |
| Deadline propagation | ✅                      | ✅                               | ✅                               |
| Cancellation         | ✅                      | ✅ (request abort)               | ⚠️ function timeout only         |

The matrix is a claim about code, and `src/capability.test.ts` checks the two halves of it that
can be checked mechanically:

- a ❌ for Workers must correspond to code that **refuses** there rather than failing
  mysteriously at runtime (`assertGrpcSupported`);
- a ✅ for Workers must correspond to an entrypoint that imports no `node:` or `bun:` module,
  because a bundle for Workers cannot resolve one.

What the test cannot prove is behaviour on a real Lambda. `make verify-dist` bundles and boots
every target, which is the closest a laptop gets; nothing here is a claim that a Worker or a
Lambda has been deployed.

## Failure modes

| Situation                             | Behaviour                                                  |
| ------------------------------------- | ---------------------------------------------------------- |
| gRPC requested where it cannot run    | `LNK_GRPC_UNSUPPORTED` at construction, not a mystery hang |
| A retry against a non-idempotent call | refused — the caller must mark the call idempotent         |
| A peer that never answers             | deadline enforced; the error names the deadline it hit     |
| An XML document deeper than the limit | `LNK_XML_TOO_DEEP`, never a partial parse                  |
| A response larger than the cap        | `LNK_BODY_TOO_LARGE`, read aborted mid-stream              |

## License

MIT © 2026 Tsir contributors.
