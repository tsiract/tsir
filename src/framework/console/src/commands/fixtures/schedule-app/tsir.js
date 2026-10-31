// The schedule fixture (`§ 4.6`).
//
// No `schedule.lock` block: the interesting default is the one a fresh project gets, and the
// tests prove both halves of it — `schedule:list` works with the per-process lock, and
// `schedule:work --production` refuses it, because on four isolates that lock prevents nothing.
export default {
  app: {
    name: 'schedule-app',
    entry: './src/app.ts',
  },
};
