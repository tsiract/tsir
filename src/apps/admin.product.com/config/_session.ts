// config/session.ts — session lifetimes.
//
// `@tsir/auth` uses these to decide when to rotate a session and when to
// expire it. The absolute lifetime is the hard cap; the idle lifetime is the
// soft cap that extends on activity.
export default {
  idleMs: 1000 * 60 * 30, // 30 minutes
  absoluteMs: 1000 * 60 * 60 * 12, // 12 hours
};
