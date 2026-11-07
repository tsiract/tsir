// config/storage.ts — the storage disk registry.
//
// `memory` is the default driver so uploads work in tests and local dev
// without S3 or a filesystem. Swap to `s3` or `local` in production. Disks
// are named, so a request can only write to a disk declared here.
export default {
  default: 'memory',
  disks: {
    memory: { driver: 'memory' },
    // A local disk for development uploads. Not available on Workers — use
    // `s3` there.
    // local: { driver: 'local', root: './storage' },
  },
};
