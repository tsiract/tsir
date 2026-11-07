/* Progressive enhancement only. The document, navigation and examples work without JS. */
(() => {
  'use strict';
  const root = document.documentElement;
  const themeButton = document.querySelector('.theme-toggle');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  const readSaved = () => {
    try {
      const value = localStorage.getItem('tsir-theme');
      return value === 'silk' || value === 'abyss' ? value : null;
    } catch {
      return null;
    }
  };
  const paintTheme = () => {
    const dark = root.dataset.theme === 'abyss';
    themeButton?.setAttribute(
      'aria-label',
      `Switch to ${dark ? 'Silk light' : 'Abyss dark'} theme`,
    );
    themeButton?.setAttribute('title', `${dark ? 'Abyss dark' : 'Silk light'} — click to switch`);
    themeButton?.setAttribute('aria-pressed', String(dark));
    themeMeta?.setAttribute('content', dark ? '#001e26' : '#f8f5ef');
  };
  paintTheme();
  if (themeButton) {
    themeButton.hidden = false;
    themeButton.addEventListener('click', () => {
      const theme = root.dataset.theme === 'abyss' ? 'silk' : 'abyss';
      root.dataset.theme = theme;
      try {
        localStorage.setItem('tsir-theme', theme);
      } catch {
        /* Sandboxed storage is optional. */
      }
      paintTheme();
    });
  }
  preference.addEventListener('change', (event) => {
    if (readSaved() !== null) return;
    root.dataset.theme = event.matches ? 'abyss' : 'silk';
    paintTheme();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'tsir-theme') return;
    root.dataset.theme = readSaved() ?? (preference.matches ? 'abyss' : 'silk');
    paintTheme();
  });

  const menuButton = document.querySelector('.menu-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const setMenu = (open) => {
    if (!menuButton || !mobileNav) return;
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    mobileNav.hidden = !open;
    menuButton.querySelector('use')?.setAttribute('href', open ? '#i-close' : '#i-menu');
  };
  if (menuButton && mobileNav) {
    menuButton.hidden = false;
    menuButton.addEventListener('click', () =>
      setMenu(menuButton.getAttribute('aria-expanded') !== 'true'),
    );
    mobileNav.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) setMenu(false);
    });
    document.addEventListener('click', (event) => {
      if (event.target instanceof Node && !event.target.closest('.site-header')) setMenu(false);
    });
    window.matchMedia('(min-width: 851px)').addEventListener('change', () => setMenu(false));
  }

  document.querySelectorAll('[data-tabs]').forEach((group) => {
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    const select = (tab, focus = false) => {
      tabs.forEach((item) => {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(item.dataset.tab ?? '');
        if (panel) panel.hidden = !active;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        select(tabs[next], true);
      });
    });
    if (tabs.length > 0) select(tabs[0]);
  });

  const announcement = document.getElementById('copy-announcement');
  document.querySelectorAll('.copy-button').forEach((button) => {
    button.hidden = false;
    let timer;
    button.addEventListener('click', async () => {
      const target = button.dataset.copyTarget
        ? document.getElementById(button.dataset.copyTarget)
        : null;
      const value = button.dataset.copy ?? target?.textContent ?? '';
      const label = button.querySelector('span');
      const original = label?.textContent ?? '';
      let copied = false;
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        const selection = window.getSelection();
        if (target) {
          const range = document.createRange();
          range.selectNodeContents(target);
          selection?.removeAllRanges();
          selection?.addRange(range);
        } else {
          const code = button.parentElement?.querySelector('code');
          if (code) {
            const range = document.createRange();
            range.selectNodeContents(code);
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }
      }
      clearTimeout(timer);
      button.dataset.copied = String(copied);
      if (label) label.textContent = copied ? 'Copied!' : 'Select + copy';
      if (announcement)
        announcement.textContent = copied
          ? 'Copied to clipboard.'
          : 'Clipboard unavailable. The code is selected; use your keyboard to copy.';
      timer = setTimeout(() => {
        if (label) label.textContent = original;
        delete button.dataset.copied;
      }, 1800);
    });
  });

  const search = document.getElementById('package-search');
  const grid = document.getElementById('package-grid');
  if (search && grid) {
    const cards = Array.from(grid.querySelectorAll('.package-card'));
    const filters = Array.from(document.querySelectorAll('.filter-button'));
    const count = document.getElementById('package-count');
    const empty = document.getElementById('package-empty');
    let category = 'all';
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      cards.forEach((card) => {
        const matches =
          (category === 'all' || card.dataset.group === category) &&
          ((card.dataset.search ?? '') + ' ' + (card.textContent ?? ''))
            .toLowerCase()
            .includes(query);
        card.hidden = !matches;
        if (matches) visible += 1;
      });
      if (count) count.textContent = `${visible} ${visible === 1 ? 'package' : 'packages'}`;
      if (empty) empty.hidden = visible !== 0;
      grid.hidden = visible === 0;
    };
    document.querySelectorAll('[data-enhance]').forEach((element) => {
      element.hidden = false;
    });
    search.addEventListener('input', filter);
    filters.forEach((button) => {
      button.addEventListener('click', () => {
        category = button.dataset.filter ?? 'all';
        filters.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        filter();
      });
    });
    document.getElementById('reset-filters')?.addEventListener('click', () => {
      search.value = '';
      category = 'all';
      filters.forEach((item) =>
        item.setAttribute('aria-pressed', String(item.dataset.filter === 'all')),
      );
      filter();
      search.focus();
    });
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable);
      if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        search.focus();
        search.scrollIntoView({ block: 'center' });
      }
      if (event.key === 'Escape') {
        if (document.activeElement === search) {
          search.value = '';
          filter();
        }
        if (menuButton?.getAttribute('aria-expanded') === 'true') {
          setMenu(false);
          menuButton.focus();
        }
      }
    });
    filter();
  }

  // A deep link to a filtered-out package resets the filter rather than showing nothing.
  const revealHash = () => {
    if (!location.hash.startsWith('#package-')) return;
    const card = document.getElementById(location.hash.slice(1));
    if (card) {
      card.hidden = false;
      card.scrollIntoView({ block: 'center' });
    }
  };
  window.addEventListener('hashchange', revealHash);
  revealHash();
})();
