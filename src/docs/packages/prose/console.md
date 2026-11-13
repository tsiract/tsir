## Example

Define a command with a name and a summary, register it, and run it through the CLI. The command's
exit code is the value the CLI returns.

```ts
import { defineCommand, registerCommands, runCli } from '@tsir/console';

const hello = defineCommand({
  name: 'hello:world',
  summary: 'Print a greeting',
  run: async () => {
    console.log('hello');
    return 0;
  },
});

registerCommands([hello]);
console.log(await runCli(['hello:world']));
```

## Checking what a local emulator can prove

`tsir deploy:verify` answers a narrow question for the AWS half of an application: for each AWS
operation this tree calls, can a local emulator run it, or does it refuse? It prints a verdict per
operation — `served`, `written-refusal`, `stub` or `absent` — and probes a running emulator when one
is up. `--json` emits the same as a versioned document.

It exits `0` when the table covers every call the tree makes and `1` when it does not, so a new
AWS call cannot be added without a row describing it. A missing emulator is not a failure: the
command says how to start one and exits `0`.

The source cross-check — re-deriving each verdict from the emulator's own handler files — runs
when `AWS_EMULATOR_SRC` names a checkout of the emulator at the pinned tag. Those files live with
this package in the repository and are not shipped, so in a distribution the table prints and the
cross-check reports itself as skipped.

## Failure modes

- `CLI_WSDL_INVALID`: the WSDL file given to the SOAP client generator is invalid. The message gives the
  reason. The generator refuses rather than writing a client that cannot work.
- `CLI_STUB_MISSING`: a generator asked for a template that this build does not carry — neither
  beside the CLI on disk nor in the bundle. The hint names `stub-text.ts`, because a template that is
  only on disk works in a source run and fails in a compiled binary, which is how `tsir new` came to
  print `ENOENT` into the bundled filesystem on its first run.
- `CLI_STUB_MISSING_VAR`: a stub template references a `{{placeholder}}` that the generator did not
  pass a value for. This is an internal inconsistency in the stub, not a user error — the hint names
  `renderStub()`, because the caller is the generator author.
- A command name that does not match the naming rule (lowercase words joined by `:` or `-`) is refused
  when it is defined, and the error is a usage error, so the CLI prints the usage and exits.
- An unknown command name is a usage error, which exits with code 2.

## Security notes

A command runs with the rights of the user who runs it, so it does not add rights of its own. Commands
are defined in code and registered explicitly, so a command cannot be added by a file that happens to sit
in the project. Output is written to the terminal, so a command should not print secrets it was given.
