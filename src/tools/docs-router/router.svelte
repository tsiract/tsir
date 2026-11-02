<!--
  Tsir docs client-side router.

  The docs are pre-rendered as static HTML with clean, directory-style URLs
  (`/docs/installation/`, not `/docs/installation.html`). This component
  intercepts internal navigation so page changes happen in the browser:

    1. Sidebar scroll position is saved and restored across navigation.
    2. The target page is fetched, its `<main>` content is swapped in, and
       the View Transition API animates the swap.
    3. `history.pushState` keeps the URL clean without a full reload.

  JavaScript is optional: without it, every `<a href>` falls back to a normal
  navigation. The router only ever touches same-origin, non-hash links.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  const isBrowser = typeof document !== 'undefined';

  const SCROLL_KEY = 'tsir-docs-sidebar-scroll';
  const CONTENT_ID = 'doc-content';
  const LAYOUT_CLASS = 'docs-layout';

  /** A same-origin, non-hash, non-download link to another docs page. */
  function internalLink(anchor: HTMLAnchorElement): boolean {
    if (anchor.target !== '' && anchor.target !== '_self') return false;
    if (anchor.hasAttribute('download')) return false;
    if (anchor.dataset.router === 'off') return false;
    const href = anchor.getAttribute('href');
    if (href === null || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:'))
      return false;
    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    // Only route within the docs site.
    return url.pathname.startsWith('/docs/');
  }

  /** Normalize a pathname to its directory form: strip `index.html` and trailing file. */
  function normalize(pathname: string): string {
    if (pathname.endsWith('.html')) {
      pathname = pathname.slice(0, -'.html'.length);
      if (pathname.endsWith('/index')) pathname = pathname.slice(0, -'index'.length);
    }
    if (!pathname.endsWith('/')) pathname += '/';
    return pathname;
  }

  /**
   * Sync the sidebar's active link and the breadcrumb to the current URL.
   *
   * The sidebar lives outside `<main id="doc-content">`, so the content swap
   * never touches it. Without this, the active link stays on the previous page
   * until a full reload. We match each sidebar link's resolved pathname against
   * the current normalized pathname and set `aria-current="page"` on the hit.
   */
  function syncSidebarActive(): void {
    const current = normalize(window.location.pathname);
    const sidebars = document.querySelectorAll('.docs-sidebar');
    // Pass 1: clear every active marker so a stale highlight can never survive
    // a navigation even if a later link is skipped.
    sidebars.forEach((bar) => {
      bar.querySelectorAll('a[aria-current]').forEach((link) => {
        link.removeAttribute('aria-current');
      });
    });
    // Pass 2: set the active marker on the link whose resolved pathname matches.
    sidebars.forEach((bar) => {
      const links = bar.querySelectorAll('a[href]');
      links.forEach((link) => {
        const href = link.getAttribute('href');
        if (href === null) return;
        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          return;
        }
        if (normalize(url.pathname) === current) {
          link.setAttribute('aria-current', 'page');
        }
      });
    });

    // Sync the breadcrumb's page title to the current document title.
    const crumb = document.querySelector('.docs-breadcrumb span:last-child');
    if (crumb !== null) {
      const title = document.title.replace(/\s*·\s*Tsir docs\s*$/u, '');
      crumb.textContent = title;
    }
  }

  /** Save the scroll positions of every sidebar on the page. */
  function saveSidebarScroll(): void {
    const positions: Record<string, number> = {};
    document.querySelectorAll('.docs-sidebar').forEach((bar, index) => {
      positions[String(index)] = bar.scrollTop;
    });
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(positions));
    } catch {
      /* storage may be unavailable */
    }
  }

  /** Restore the scroll positions saved before the last navigation. */
  function restoreSidebarScroll(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(SCROLL_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    try {
      const positions = JSON.parse(raw) as Record<string, number>;
      document.querySelectorAll('.docs-sidebar').forEach((bar, index) => {
        const top = positions[String(index)];
        if (typeof top === 'number') bar.scrollTop = top;
      });
    } catch {
      /* malformed payload — ignore */
    }
  }

  /**
   * Replace the page's docs layout (sidebars + main content) with the one
   * extracted from `html`.
   *
   * We swap the *entire* `.docs-layout` — both sidebars and `<main>` — rather
   * than just `<main>`. Sidebar links use page-relative hrefs, so the sidebar
   * from the previous page would resolve them against the wrong base URL after
   * navigation, causing multiple links to match the current page. Swapping the
   * layout brings in the new page's sidebar with correct hrefs and build-time
   * `aria-current`.
   *
   * Uses the View Transition API when available; otherwise swaps immediately.
   * Resolves once the DOM swap has been applied.
   */
  function swapContent(html: string, title: string): Promise<void> {
    return new Promise((resolve) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const next = doc.querySelector(`.${LAYOUT_CLASS}`);
      const current = document.querySelector(`.${LAYOUT_CLASS}`);
      if (next === null || current === null) {
        window.location.reload();
        return;
      }
      document.title = title;

      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };

      const apply = (): void => {
        current.replaceWith(next);
        restoreSidebarScroll();
        syncSidebarActive();
        const main = document.getElementById(CONTENT_ID);
        if (main !== null) {
          main.setAttribute('tabindex', '-1');
          main.focus({ preventScroll: true });
        }
      };

      const supportsViewTransition = isBrowser && 'startViewTransition' in document;
      if (supportsViewTransition) {
        // Apply inside the view-transition callback so the browser can animate
        // between the old and new content. A fast fallback (100 ms) ensures
        // navigation never hangs in browsers where the callback is delayed or
        // never invoked (e.g. some headless engines).
        let applied = false;
        const safeApply = (): void => {
          if (applied) return;
          applied = true;
          apply();
          finish();
        };
        try {
          (
            document as Document & { startViewTransition: (cb: () => void) => unknown }
          ).startViewTransition(safeApply);
        } catch {
          /* startViewTransition threw — fall through to the timeout */
        }
        setTimeout(safeApply, 100);
      } else {
        apply();
        finish();
      }
    });
  }

  /** Perform a client-side navigation to `url`. */
  async function navigate(url: URL, push: boolean): Promise<void> {
    saveSidebarScroll();
    const response = await fetch(url.pathname + url.search, {
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      window.location.href = url.pathname + url.search + url.hash;
      return;
    }
    const html = await response.text();
    if (push) history.pushState({}, '', url.pathname + url.search + url.hash);
    const titleMatch = /<title>([^<]*)<\/title>/u.exec(html);
    const title = titleMatch?.[1] ?? document.title;
    await swapContent(html, title);
    if (url.hash !== '') {
      // Defer hash scrolling until the DOM swap is committed.
      requestAnimationFrame(() => {
        const target = document.getElementById(url.hash.slice(1));
        target?.scrollIntoView();
      });
    } else {
      window.scrollTo(0, 0);
    }
  }

  onMount(() => {
    if (!isBrowser) return;

    // Restore scroll on the initial load (e.g. after a back navigation that
    // bypassed the router).
    restoreSidebarScroll();
    syncSidebarActive();

    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest('a');
      if (!(anchor instanceof HTMLAnchorElement) || !internalLink(anchor)) return;
      event.preventDefault();
      const url = new URL(anchor.href);
      // Same page, just a hash change — let the browser handle it.
      if (normalize(url.pathname) === normalize(window.location.pathname) && url.hash !== '') {
        window.location.hash = url.hash;
        return;
      }
      void navigate(url, true);
    };

    const onPopState = (): void => {
      const url = new URL(window.location.href);
      void navigate(url, false);
    };

    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('beforeunload', saveSidebarScroll);

    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('beforeunload', saveSidebarScroll);
    };
  });
</script>

<!-- The component has no visible output; it only wires up event handlers. -->
<svelte:head />
