// The ract fixture (CLI-020): `console.commands` is the allow-list `ract` enforces.
// `make:job` is a framework command that this project did not list, so `ract` refuses it.
export default {
  app: {
    name: 'ract-app',
    entry: './src/app.ts',
  },
  console: {
    commands: ['help', 'doctor', 'ping'],
  },
};
