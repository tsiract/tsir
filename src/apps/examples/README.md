# Example applications

Runnable applications that exercise the public framework APIs:

- `minimal/`: configuration, lifecycle and a test; it does not serve HTTP.
- `http/`: a fetch handler, validation, and `users` and `media` modules.

`make dist` includes these under `dist/src/examples/`. From the HTTP example, run
`../../../tsir route:list`, `../../../tsir test`, or `../../../tsir dev`. The distribution is
recreated on every build, so copy code you want to keep outside `dist/`. The proposed SaaS and
edge-service examples are not shipped yet.
