// The storage fixture.
//
// Two disks on purpose: `assets` is a real directory under the fixture (so `storage:probe` proves
// a write reached a filesystem), and `scratch` is memory (so a test can prove the capability
// report differs between a durable disk and an ephemeral one). No `s3` disk: a test that needs
// credentials to pass is a test that fails on a laptop.
export default {
  app: {
    name: 'storage-app',
    entry: './src/app.ts',
  },
  storage: {
    default: 'assets',
    disks: {
      assets: { driver: 'local', root: '.storage' },
      scratch: { driver: 'memory' },
    },
  },
};
