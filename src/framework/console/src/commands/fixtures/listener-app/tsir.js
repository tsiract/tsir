// The listener fixture: an app whose only deployable unit exists because of a decorator
// (`@OnSns` / `@OnEventBridge` / `@OnStepTask`), so `deploy:build` has to compile the unit
// from the app's own controllers rather than from an entry export (DPL-026, INF-005).
export default {
  app: {
    name: 'listener-example',
    entry: './src/app.ts',
  },
};
