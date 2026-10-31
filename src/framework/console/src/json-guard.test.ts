import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CLI-002: every JSON document the CLI writes to stdout goes through `jsonDocument`, so it is
// versioned. This guard fails if a stdout write uses plain `JSON.stringify` again.
//
// The allowlist is the exceptions, each with a reason. A file a command writes to disk (manifest,
// build.json, package.json, generated code) is not a CLI document and is not scanned for.

const COMMANDS = join(import.meta.dir, 'commands');

// `file:snippet` → why it is not a versioned document.
const ALLOWED: Record<string, string> = {
  'vault.ts:keys: plan.manifest': 'keyring manifest: the file format TSIR_KEYRING_FILE reads',
  'vault.ts:keys: plan.manifest,': 'keyring manifest: the file format TSIR_KEYRING_FILE reads',
  'notify.ts:record.payload': 'human-readable payload preview, not a --json document',
};

function scan(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of readdirSync(COMMANDS)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const lines = readFileSync(join(COMMANDS, file), 'utf8').split('\n');
    const text = lines.join('\n');
    // A stdout write whose payload is the raw JSON.stringify call, on the same or the next line.
    const pattern = /(?:info|process\.stdout\.write)\(\s*(?:`\$\{)?\s*JSON\.stringify\(/g;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      // The payload may sit on the lines that follow the call; the allowlist matches against them.
      const snippet = lines
        .slice(line - 1, line + 6)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      hits.push({ file, line, text: snippet });
    }
    // Multi-line payloads: `info(\n  JSON.stringify(` is caught above; a template with the call
    // inside `${...}` is caught here.
    const templ = /\$\{JSON\.stringify\(/g;
    for (const match of text.matchAll(templ)) {
      const before = text.slice(0, match.index);
      if (!/process\.stdout\.write\(\s*`$/m.test(before.slice(-200))) continue;
      const line = before.split('\n').length;
      hits.push({ file, line, text: lines[line - 1]?.trim() ?? '' });
    }
  }
  return hits;
}

describe('CLI-002: stdout JSON is versioned', () => {
  test('no command writes a plain JSON.stringify document to stdout', () => {
    const offending = scan().filter((hit) => {
      const allowed = Object.keys(ALLOWED).some((key) => {
        const cut = key.indexOf(':');
        const file = key.slice(0, cut);
        const snippet = key.slice(cut + 1);
        return hit.file === file && hit.text.includes(snippet);
      });
      return !allowed;
    });
    expect(offending.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([]);
  });

  test('the only raw stdout JSON left is the two keyring manifests (so the allowlist cannot go stale)', () => {
    const files = scan().map((hit) => hit.file);
    expect(files).toEqual(['vault.ts', 'vault.ts']);
  });
});
