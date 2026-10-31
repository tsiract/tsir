# Tasks — `@tsir/storage` (Phase 7)

> Bytes in, bytes out, and a URL that says whether it is public or signed. The package owns the
> **key**, the **disk**, the **byte contract** and one **driver set** — `memory`, `local`, `s3`,
> where R2 is the third of those by endpoint rather than a fourth driver. Reserved in
> [`_capabilities.md`](./_capabilities.md) as `CAP-STOR-*`.
>
> **Plan:** [`15-capabilities.md § 6`](../modules/15-capabilities.md) · **Registry:** `CAP-001` (the
> `storage.disks` half) · **Related:** [`queue.md`](./queue.md) and [`schedule.md`](./schedule.md)
> (the same `default` + named-registry shape).

**Status: complete.** Thirteen tasks, ten source modules, three drivers, a conformance kit, four
test files (70 tests) and three console commands; `tsir storage:disks|probe|url` reads the app's own
`disks` export when there is one and builds the registry from `storage.disks` when there is not.

## Tasks

| ID        | Task                                                                       | Status | Depends   | Acceptance                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STOR-1`  | Port: `put`/`get`/`head`/`exists`/`delete`/`list`/`url`/`temporaryUrl`     | `[x]`  | —         | A string body is a `TypeError` naming `utf8()`; `contentType` defaults to `application/octet-stream` and is never sniffed; a missing key is `undefined`, not an exception               |
| `STOR-2`  | `DiskCapabilities` per disk — eight declared facts, no ambiguity           | `[x]`  | `STOR-1`  | `publicUrls`, `signedUrls`, `persistent`, `sharedAcrossInstances`, `list`, `rangeReads`, `filesystem`, `maxKeyBytes`; a `false` capability throws `STO_UNSUPPORTED_OPERATION`           |
| `STOR-3`  | `assertKey` — the traversal lock, before any driver sees a key             | `[x]`  | `STOR-1`  | Empty, leading `/`, `\`, control characters, `//`, `.`/`..` segments and > 1024 bytes are `STO_INVALID_KEY`, and the message names the disk                                             |
| `STOR-4`  | `createDisk` — the wrapper that makes the port total                       | `[x]`  | `STOR-1`  | Validates before delegating, defaults `contentType`, turns `url`/`temporaryUrl` refusals into one message naming disk and driver, and caps a presigned TTL at 7 days                    |
| `STOR-5`  | `memory` driver — a `Map` with an etag and a cursor                        | `[x]`  | `STOR-2`  | `persistent: false`, `publicUrls: false`; FNV-tagged etag; `list` cursor is the last key, so a key deleted mid-page does not shift the page                                             |
| `STOR-6`  | `local` driver — a directory, atomic writes, a sidecar                     | `[x]`  | `STOR-2`  | `put` writes `<name>.<uuid>.tmp` and renames; the root is resolved once and every path re-checked against it; `.tsir-meta` holds content type + metadata and is invisible to `list`     |
| `STOR-7`  | `s3` driver — SigV4 over `fetch`, no SDK, R2 by endpoint                   | `[x]`  | `STOR-2`  | Path-style iff `endpoint` is set; 404 → `undefined`, 412 → `STO_ALREADY_EXISTS`, 403 → `STO_REQUEST_FAILED` naming credentials; `206` is sized from `content-range`                     |
| `STOR-8`  | SigV4 — signing key, canonical request, presign                            | `[x]`  | —         | Matches AWS's published signing-key and `ListUsers` vectors byte for byte; `x-amz-content-sha256` is sent for `s3` only, because it changed the IAM vector's signature                  |
| `STOR-9`  | `createDisks` — the registry, `default`, and no silent fallback            | `[x]`  | `STOR-4`  | `STO_NO_DISKS`, `STO_UNKNOWN_DISK` lists the names that exist, `STO_UNKNOWN_DEFAULT`; an unknown disk never resolves to the default                                                     |
| `STOR-10` | `disksFromConfig` — `storage.disks`, `env` references, prod guard          | `[x]`  | `STOR-9`  | `{ fromEnv: 'R2_KEY' }` resolves from the injected `env` and names the variable when it is missing; `memory` as default or `required` in production is `STO_FORBIDDEN_IN_PRODUCTION`    |
| `STOR-11` | `diskConformance` — the kit every future disk driver must pass             | `[x]`  | `STOR-1`  | Seven named cases: exact bytes, missing key, metadata, honest `delete`, prefix-scoped paginated `list`, `ifNoneMatch`, false capabilities throwing                                      |
| `STOR-12` | `tsir storage:disks\|probe\|url` — one command family, not one per backend | `[x]`  | `STOR-10` | `disks` prints capabilities and the registry source; `probe` round-trips a random key, deletes it, and exits non-zero on any failure; `url` prefers public and signs only on demand     |
| `STOR-13` | Boundary + exports — the `local` driver states its own runtime requirement | `[x]`  | `STOR-6`  | The package is runtime-neutral; `node:path`/`node:fs` live in `drivers/adapters/local.ts`, `node:fs` loads lazily, and a runtime without a filesystem gets `STO_FILESYSTEM_UNAVAILABLE` |

## As built: the byte contract

```
key ──assertKey──▶ driver ──▶ bytes + content type + etag
```

Two rules do most of the work, and both are about **not guessing**:

- **A content type is declared, never sniffed.** `application/octet-stream` is the default, and a
  caller that wants HTML to render in a browser says `text/html` itself. A framework that sniffs
  is a framework that decides a user's upload is HTML because it starts with `<`.
- **The port is bytes.** A string body is refused with a `TypeError` that names `utf8()`, because
  silently encoding is how a driver ends up corrupting every JPEG while every text test passes.

`url` and `temporaryUrl` are one method pair apart for the same reason: a disk that can publish
says `publicUrls: true`, and a disk that cannot says so in the error rather than returning a path
that happens to work locally and 403s in production. `publicBaseUrl` is the only way to get
`publicUrls: true`, and only the `s3` driver has it.

## As built: three drivers, one kind of honesty

| Driver   | Durable | Shared | Public URLs   | Signed URLs | Filesystem | Notes                                                                                |
| -------- | ------- | ------ | ------------- | ----------- | ---------- | ------------------------------------------------------------------------------------ |
| `memory` | no      | no     | no            | no          | no         | Development and tests. `persistent: false` is why production refuses it as a default |
| `local`  | yes     | yes    | no            | no          | yes        | Atomic rename, `.tsir-meta` sidecar, sorted walk for a stable `list`                 |
| `s3`     | yes     | yes    | if configured | yes         | no         | SigV4 in WebCrypto, no SDK, path-style for R2, seven-day presign cap                 |

`s3` is the default where a bucket exists, `memory` is the default where one does not — which is
what makes `tsir storage:probe` run on a fresh checkout — and production refuses a `memory` default
or `required` disk outright, because "the uploads vanished" is not a bug you debug twice.

`local` is the one driver that needs a filesystem, so it is the one driver whose source lives in
`drivers/adapters/` (the boundary rule's declared escape hatch) and whose `node:fs` import is lazy:
a Worker bundle that merely declares a dev disk still builds, and using that disk on such a runtime
answers `STO_FILESYSTEM_UNAVAILABLE` — a coded refusal that names the fix — instead of
`fs.readFile is not a function`.

## As built: one registry, read two ways

```
app entry ──export const disks──┬─▶ tsir storage:disks|probe|url
                                └─▶ (nothing else yet: `deploy` does not build buckets)
tsir.js ────storage.disks───────┴─▶ disksFromConfig()   ← when the entry has no `disks` export
```

The console reads the **entry export** first and `storage.disks` second, and prints which one it
used. That line exists because the two sources are not equivalent: an export is live code that can
compose drivers, while a config block can only describe one. A project that edits `storage.disks`
while its entry exports a registry gets the export, and the command says so.

`tsir storage:url` takes the public URL when the disk has `publicUrls` and no `--expires`, and
otherwise asks for a signed one — so `--expires 900` is the whole difference between "hand this to
a browser" and "hand this to a browser in fifteen minutes". `probe` writes one object per disk at
the root, reads it back, compares the bytes, deletes it, and exits non-zero if any disk failed —
which is the only storage check worth running in a pipeline.

## What the gates check

`bun test src/framework/storage` — 70 tests, four files. `sigv4.test.ts` checks the implementation
against AWS's own vectors rather than against itself (signing key `f4780e2d…`, `ListUsers` signature
`5d672d79…`); `s3.test.ts` drives the driver through a recording `fetch` that asserts the URL shape,
the headers and the signature for R2 and AWS, plus 404/412/403/range/list/public-URL cases;
`disks.test.ts` runs the conformance kit over **two** drivers, so the kit is known to be passable by
more than the driver it was written against. `storage.test.ts` in the console (11 tests) runs each
command as a subprocess against a fixture with one `local` and one `memory` disk — a probe that
passed in-process and failed on the machine would be a probe that tests the test.
`numbers.test.ts` covers the two functions that turn a string into a number, because their
_refusals_ are the point: `Number("")` is `0` and `Number("12abc")` is `NaN`, and both would end up
in a `Range` header. `make coverage` includes the package against the same floor as the rest of
`src/framework`.
