# `@tsir/config`

Typed configuration loading, the managed-region writer used by `tsir bootstrap`, and validation of the project file (`tsir.js`).

## Project file validation

`checkProjectFile(raw)` runs before any project value is read. It applies three rules, in order:

| Rule             | Code                                                                     | What it refuses                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format           | `CFG_CONFIG_VERSION_STALE`                                               | The flat `database: { driver, … }` form. Run `tsir bootstrap --migrate-config`.                                                                                                                                                                    |
| Unknown keys     | `CFG_UNKNOWN_KEY`                                                        | Any top-level or documented nested key that is not known, with a nearest-key suggestion. Set `strict: false` to allow them.                                                                                                                        |
| Named registries | `CFG_MISSING_DEFAULT`, `CFG_UNKNOWN_DEFAULT`, `CFG_AMBIGUOUS_CONNECTION` | For each registry in `NAMED_REGISTRIES` (`database.connections`, `cache.stores`, `queue.connections`, `storage.disks`, `mail.mailers`): a missing `default`, a `default` that is not declared, or a connection that sets both `binding` and `url`. |

One declared connection is the single-connection case. It still needs an explicit `default`.

`unknownProjectKeys(raw)` returns the key problems as lines, without throwing. `suggestKey(name, known)` returns the nearest known key when it is a plausible typo.

## Managed regions

`formatConfigReport`, `configInvalid`, and `configError` build the boot report and the `TsirError` values. The managed-region writer (`managed.ts`) only rewrites text between `managed:<id>:start` and `managed:<id>:end` fence lines. It never edits unmanaged text.

## License

MIT © 2026 Tsir contributors.
