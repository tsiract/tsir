/**
 * The test that every `make:*` generator writes next to the file it creates (`CLI-015`).
 *
 * It fails on purpose. A generated part is a skeleton, and a skeleton that passes `bun test` would
 * let an unimplemented rule ship green. So a fresh project is red until each part is implemented,
 * and the failure names the part that is still open. Replace the throw with a real assertion and
 * the file is ordinary test code from then on.
 */

import type { GeneratedFile } from '../generator.ts';
import { renderStub } from '../stub.ts';

/** `services/audit.service.ts` → `services/audit.service.test.ts`. */
export function pendingTestPath(generatedPath: string): string {
  return generatedPath.replace(/\.ts$/, '.test.ts');
}

export function pendingTestFile(generatedPath: string, subject: string): GeneratedFile {
  const label = subject.replace(/['\\]/g, '');
  return {
    path: pendingTestPath(generatedPath),
    contents: renderStub('pending-test.ts', { label }),
  };
}
