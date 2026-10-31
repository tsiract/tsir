// tsir.js — canonical project configuration
//
// Phase 1 subset: where the application entry lives. Presets, managed regions
// and deploy topology are added by later phases; this file is forward-compatible
// with them because unknown keys are preserved rather than rejected.

export default {
  app: {
    name: 'minimal',
    entry: './src/app.ts',
  },
};
