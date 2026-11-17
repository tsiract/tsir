---
bump: patch
---

Make generated modules actually serve: the route table moves to `registry.ts` to
break the registry/controller import cycle, controllers carry their DI token and
the module binds it with a `classProvider`, and `make:migration` finds the models
`make:model` writes. Also stop bundling Node-only imports for workerd.
