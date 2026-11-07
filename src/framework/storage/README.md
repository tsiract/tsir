# `@tsir/storage`

Named object-storage disks over one port: bytes in, bytes out, and a URL that says whether it is
public or signed. Three drivers — `memory`, `local`, `s3` — and R2 is the third of those by
endpoint, not a fourth driver.

## Capabilities

Every disk advertises what its driver can actually do, and the port refuses what it cannot:

| Capability              | Meaning                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `persistent`            | Survives a process restart.                                                     |
| `sharedAcrossInstances` | Visible to other instances.                                                     |
| `publicUrls`            | `url()` answers without credentials — a public bucket or a CDN in front of one. |
| `signedUrls`            | `temporaryUrl()` can sign.                                                      |
| `list`                  | `list()` is a real enumeration, not a scan of the process's own keys.           |
| `rangeReads`            | `get({ range })` is a real byte-range read.                                     |
| `filesystem`            | The driver needs a filesystem (`local` only).                                   |

## Drivers

- `memoryDriver()` — in-process; `persistent` and `sharedAcrossInstances` are false.
- `localDriver({ root })` — a directory on the machine; all capabilities except public/signed URLs.
- `s3Driver({ bucket, region, credentials, endpoint? })` — S3 and R2; all capabilities.

## Visibility, copy/move, directories, streaming

Beyond the core `put`/`get`/`head`/`delete`/`list`, every driver implements:

- `setVisibility(key, 'public' | 'private')` — object ACL. Local maps it to file mode bits
  (`0o644` / `0o600`); S3 maps it to a canned ACL (`public-read` / `private`).
- `copy(source, destination)` and `move(source, destination)` — within-disk copy and rename.
- `directories(prefix?)` — immediate subdirectories (keys ending in `/`) under a prefix.
- `stream(key, options?)` — a `ReadableStream<Uint8Array>` of the object's bytes.

The `Visibility` type (`'public' | 'private'`) is exported from the package root.
