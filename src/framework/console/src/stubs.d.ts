/**
 * Stub files are imported as text.
 *
 * `import contents from './new/app.ts.slug.txt' with { type: 'text' }` is how a template reaches the
 * bundle (`bun build --compile`) while staying an ordinary editable file on disk. Bun types text
 * imports for the extensions it does not load as code — `.txt` among them — so the template keeps its
 * own name and gains `.txt` (`new/app.ts.slug.txt` renders `new/app.ts`). See `stub-text.ts` for why
 * the imports exist at all, and `stub.test.ts` for the check that none is missing.
 */
