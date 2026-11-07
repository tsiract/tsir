# Tasks — `@tsir/browser` (← nightwatch) (Phase 10)

> Browser automation: navigate, click, type, screenshot, and wait. The package wraps a headless
> browser (Playwright-compatible) with a small, typed API. Three of six features are complete. The
> remaining work is assertions and page objects — the two things that turn a click script into a
> test.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md).

**Status: in progress.** Navigation, interaction, and screenshots are complete (3/6). Three
features remain: assertions, page objects, and the test harness integration.

## Tasks

| ID       | Task                                                              | Status | Depends  | Acceptance                                                                                                                                      |
| -------- | ----------------------------------------------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROW-1` | Navigation — `goto`, `reload`, `back`, `forward`, `url`           | `[x]`  | —        | Every method returns a `Page`; a navigation failure throws with the URL                                                                         |
| `BROW-2` | Interaction — `click`, `type`, `fill`, `select`, `check`, `hover` | `[x]`  | `BROW-1` | Locators are CSS selectors or role-based; a missing element throws a coded error, not a timeout                                                 |
| `BROW-3` | Screenshots + `waitFor`                                           | `[x]`  | `BROW-1` | `screenshot()` returns a buffer; `waitFor(selectorOrFn)` polls with a configurable timeout                                                      |
| `BROW-4` | Assertions — `assertVisible`, `assertText`, `assertUrl`, etc.     | `[ ]`  | `BROW-2` | A fluent assertion API (`page.expect(selector).toBeVisible()`) that fails with the actual state; a failing assertion includes a screenshot path |
| `BROW-5` | Page objects — `PageObject` base class                            | `[ ]`  | `BROW-2` | `class LoginPage extends PageObject` with selectors and action methods; `page.at(LoginPage)` asserts the URL and returns the object             |
| `BROW-6` | Test harness integration — `testBrowser()` helper                 | `[ ]`  | `BROW-4` | A `bun test` helper that launches a browser, runs a callback, and tears down; failures capture a screenshot automatically                       |

## Design notes

**Assertions are fluent, not imperative.** `page.expect(selector).toBeVisible()` reads like a test
assertion and fails with a useful message. The alternative — `page.assertVisible(selector)` — is
less composable and harder to extend (negation, timeout, etc.).

**Page objects are plain classes.** No codegen, no decorators. A `PageObject` is a class with a
`url` and selectors; `page.at(LoginPage)` navigates there and returns an instance. This keeps page
objects testable without a browser.

**Screenshots on failure are the default.** A failed assertion or a thrown error in `testBrowser`
captures a screenshot to a temp path and includes it in the error message. This is the single most
useful debugging tool in browser tests.

**What the gates check.** `bun test src/framework/nightwatch` covers navigation, interaction, and
screenshots against a fake browser driver. `BROW-4`–`BROW-6` add assertion, page-object, and
harness tests.
