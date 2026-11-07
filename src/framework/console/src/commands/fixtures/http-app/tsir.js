// The http fixture: a small app with two route modules (users, media) that the
// deploy, openapi and deploy-build suites use as a real, importable target.
export default {
  app: {
    name: 'http-example',
    entry: './src/app.ts',
  },
};
