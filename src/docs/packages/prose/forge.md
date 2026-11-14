## Example

A server provider is four methods — list, create, destroy, run — and a deploy is a list of commands
run in order, stopping at the first non-zero exit. The local provider runs them on this machine, which
is what makes the recipe testable without a server.

```ts
import { deploy, localProvider } from '@tsir/forge';

const provider = localProvider();
const server = await provider.create('web-1');

const results = await deploy(provider, server.id, {
  steps: [
    { name: 'check', command: 'echo ready' },
    { name: 'count', command: 'echo three' },
  ],
});

console.log(server.name, server.ip);
for (const result of results) console.log(result.step, '→', result.output.trim());

await provider.destroy(server.id);
console.log('servers left:', (await provider.list()).length);
```

## Failure modes

- `FORGE_DEPLOY_FAILED`: a step in the recipe exited non-zero. The message names the step and carries
  its stderr, and the deploy stops — a recipe that continued past a failed `build` would deploy the
  previous artefact and report success. Nothing is rolled back, because a deploy that mutated a server
  half-way is not something a framework can undo safely; the step name is what makes it fixable.

## Security notes

`sshProvider` runs commands on another machine, so the command string is the boundary: it comes from
the recipe, which is code, and never from a request. A deploy route that took a command from its
body would be remote code execution with extra steps.

The SSH provider authenticates with a key file and does not accept a password. A key is a file with
permissions and a lifetime; a password in configuration is a secret in four places — the config, the
process environment, a log line, and whoever reads the repository — and it survives every key rotation
the rest of the system does.

`localProvider` shells out with `node:child_process`, which a Worker cannot load. It is the
development and CI provider; a production deploy uses `sshProvider` from a long-running worker unit,
which is the same constraint every native dependency in this framework has.
