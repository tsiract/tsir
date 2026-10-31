# ADR-0023 — SOAP parses XML with a bounded reader we own, not a general parser

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `@tsir/link/soap`, `src/framework/link/src/xml.ts`, `plans/modules/07-link.md` § 5
- **Amends:** [ADR-0012](./0012-dependency-policy.md) (dependency policy) — by declining a dependency rather than adding one

---

## Context

`plans/modules/07-link.md` § 5 named `fast-xml-parser` for SOAP, with the hardening requirements
spelled out: no attribute auto-merge, XXE hardened, entity expansion disabled, DTD
rejected. The requirement is not "parse XML" — it is "parse XML in a way that cannot be
talked into reading a file, expanding a billion laughs, or fetching a URL".

Two things changed the calculus when the task came up:

1. **The dependency grew.** The current `fast-xml-parser` release depends on six
   transitive packages (`strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`,
   `@nodable/entities`, `path-expression-matcher`). ADR-0012 asks each runtime dependency
   to earn its bytes; six packages to parse an envelope whose schema we already know does
   not.
2. **The safety we need is subtractive.** Every SOAP request and response this package
   will ever handle is an `<Envelope>` around one body element. It needs elements,
   attributes, namespaces, text and CDATA. It must never needs DTDs, entity declarations,
   conditional sections or external references — and "support it, then disable it" is a
   configuration that a future version can change back.

## Decision

`@tsir/link/soap` parses XML with a reader in this repository (`src/framework/link/src/xml.ts`),
and **refuses to parse anything outside that subset**:

- `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION` and conditional sections
  are `XML_UNSAFE` — the whole markup-declaration class fails at the first `<!`. There is
  no entity table to expand and no external identifier to resolve, because the grammar
  never admits one.
- Five predefined entities and numeric character references are decoded by us. Anything
  else (`&xxe;`, `&lol;`, a bare `&`) is `XML_UNSAFE`, not text.
- Byte (1 MiB), depth (64) and element-count (20 000) ceilings are enforced **while
  scanning**, so a hostile document fails at its first violation instead of after a tree
  is allocated.
- Values are strings. `"007"` stays `"007"`; numbers and booleans come from a schema or
  from the operation's `decode`, never from a parser guessing (VLD-007).
- No `node:` import: the module bundles for Workers unchanged, which is what makes a
  Workers SOAP client a real claim rather than a matrix cell.

The reader is not a general XML implementation and does not try to be: it is a
**conformance-tested subset**, and its refusals are the security control. `xml.test.ts`
covers XXE, billion laughs, depth, size and malformed structure by payload.

## Consequences

**Good**

- The hardening story is a grammar, not a configuration: no upgrade can re-enable DTDs.
- Zero runtime dependencies for the SOAP subpath, so the Workers bundle stays at our own
  code (measured in `make verify-dist`).
- The refusals are testable, and they are tests a reviewer can read without knowing a
  third party's option names.
- Non-XML SOAP attachments (MTOM/XOP) are already out of scope (§ 5), so the subset is not
  going to grow under pressure.

**Bad, and accepted**

- We own a parser. It is ~520 lines with a payload matrix, and it will need care when SOAP
  services in the wild use a construct we refused. The mitigation is that refusal is loud:
  every rejection names what it refused and why, and the fix is a decision here rather
  than a silent acceptance.
- No streaming: the body is read to a string, then parsed. The 8 MiB response cap and the
  1 MiB parse cap bound the memory; a streaming reader is a later task if a real service
  needs one.
- XSD type decoding is not here. Operations declare their shape (`encode`/`decode`) or use
  the flat-record default; `LNK-016`'s WSDL compiler is what will generate richer ones.

## Alternatives considered

- **`fast-xml-parser` as planned.** Rejected above: six transitive dependencies and a
  feature set whose dangerous half must be turned off by configuration.
- **`saxes`.** Small, well-tested, one dependency — but CommonJS and no `sideEffects`
  declaration, so it cannot pass ADR-0012 without an exception, and it still needs a DOM
  layer on top plus our own DTD pre-check to satisfy § 5. At that point we were already
  writing the interesting half.
- **A `DOMParser` from a platform polyfill.** Not available in Workers, and inconsistent
  between Bun and Node — a SOAP client that behaves differently per runtime is worse than
  one that refuses.
