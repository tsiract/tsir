# Capability matrix

What runs where. Each cell is either supported (the entrypoint imports no
`node:`/`bun:` module the target rejects, and a probe boots it), refused (code
that throws on the target), or partial.

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

## How this is kept honest

- A ❌ for Workers must correspond to code that refuses there (`assertGrpcSupported`).
- A ✅ must correspond to an entrypoint that imports no `node:`/`bun:` module.
- The link half of this table is asserted by `capability.test.ts` in
  `@tsir/link`. The deploy half — that each ✅ actually boots on the target — is
  exercised by `make verify-dist` (bundle-level probe) and, for AWS, by the
  deploy conformance suite.
