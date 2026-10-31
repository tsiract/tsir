// The bootstrap fixture (`DPL-023`): an app with no deploy block yet.
//
// `tsir bootstrap` is supposed to add one — inside a managed region, without touching
// `app` or this comment.
export default {
  app: {
    name: 'bootstrap-app',
    entry: './src/app.ts',
  },
};
