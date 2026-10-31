/**
 * The `memory` stores, behind one entry point (`@tsir/auth/memory`).
 *
 * One subpath for both because they are always wanted together — a unit test that authenticates
 * needs sessions *and* keys — and because a project that imports one is not going to want the other
 * from a database in the same test.
 */

export { memorySessionStore, type MemorySessionStore } from './session-memory.ts';
export { memoryApiKeyStore, type MemoryApiKeyStore } from './keys-memory.ts';
