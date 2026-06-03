(function () {
  'use strict';

  // BOOTSTRAP-CMDHUB-IANAV / DEV-COMHU-IANAV (reconciles with VTID-03247,
  // PR #2482 Intelligence Cockpit spine).
  //
  // Information-architecture / navigation improvement for the Intelligence
  // Cockpit page: builds a sticky in-page jump-nav from the cockpit's
  // `.cockpit-panel` sections so the operator can navigate the
  // dataset -> training -> context quality -> role -> self-healing spine
  // without manual scrolling, with active-section highlighting (scroll-spy)
  // and keyboard focus support.
  //
  // CSP-compliant: external script (no inline JS), no CDN, DOM built via API.
  // Self-bootstrapping and inert on pages that have no cockpit panels, so it
  // is safe to load alongside the cockpit page produced by PR #2482 without
  // duplicating or conflicting with intelligence-cockpit.js.

  var NAV_ID = 'cockpit-ia-nav';
  var PANEL_SELECTOR = '.cockpit-panel';
  var GRID_SELECTOR = '.cockpit-grid';

  function slugify(text, index) {
    var base = (text || '')
      .toLowerCase()
      .replace(/&[a-z]+;/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return base ? 'cockpit-section-' + base : 'cockpit-section-' + index;
  }

  function panelTitle(panel) {
    var heading = panel.querySelector('h2, h3, .cockpit-panel__header');
    if (heading) {
      var text = (heading.textContent || '').trim();
      if (text) return text;
    }
    return 'Section';
  }

  function panelBadge(panel) {
    var badge = panel.querySelector('.cockpit-panel__badge');
    if (!badge) return '';
    return (badge.textContent || '').trim().toLowerCase();
  }

  function buildNav(panels) {
    var nav = document.createElement('nav');
    nav.id = NAV_ID;
    nav.className = 'cockpit-ia-nav';
    nav.setAttribute('aria-label', 'Intelligence Cockpit sections');

    var label = document.createElement('span');
    label.className = 'cockpit-ia-nav__label';
    label.textContent = 'Jump to';
    nav.appendChild(label);

    var list = document.createElement('ul');
    list.className = 'cockpit-ia-nav__list';

    var links = [];

    panels.forEach(function (panel, index) {
      if (!panel.id) {
        panel.id = slugify(panelTitle(panel), index);
      }

      var item = document.createElement('li');
      item.className = 'cockpit-ia-nav__item';

      var link = document.createElement('a');
      link.className = 'cockpit-ia-nav__link';
      link.href = '#' + panel.id;
      link.dataset.target = panel.id;

      var title = document.createElement('span');
      title.className = 'cockpit-ia-nav__link-title';
      title.textContent = panelTitle(panel);
      link.appendChild(title);

      var badgeText = panelBadge(panel);
      if (badgeText) {
        var badge = document.createElement('span');
        badge.className =
          'cockpit-ia-nav__badge cockpit-ia-nav__badge--' +
          (badgeText === 'live' ? 'live' : 'placeholder');
        badge.textContent = badgeText;
        link.appendChild(badge);
      }

      // Smooth-scroll without losing the hash for deep-linking, and move
      // keyboard focus to the panel for accessibility (WCAG 2.4.3).
      link.addEventListener('click', function (event) {
        event.preventDefault();
        var target = document.getElementById(panel.id);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (typeof history !== 'undefined' && history.replaceState) {
          history.replaceState(null, '', '#' + panel.id);
        }
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });

      item.appendChild(link);
      list.appendChild(item);
      links.push(link);
    });

    nav.appendChild(list);
    return { nav: nav, links: links };
  }

  function wireScrollSpy(panels, links) {
    if (typeof IntersectionObserver === 'undefined') return;

    function setActive(id) {
      links.forEach(function (link) {
        var isActive = link.dataset.target === id;
        link.classList.toggle('cockpit-ia-nav__link--active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    var observer = new IntersectionObserver(
      function (entries) {
        // Pick the intersecting entry nearest the top of the viewport.
        var best = null;
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) {
            best = entry;
          }
        });
        if (best && best.target && best.target.id) {
          setActive(best.target.id);
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: [0, 0.25, 0.5, 1] }
    );

    panels.forEach(function (panel) {
      observer.observe(panel);
    });

    if (panels.length) setActive(panels[0].id);
  }

  function init() {
    var grid = document.querySelector(GRID_SELECTOR);
    var panels = Array.prototype.slice.call(document.querySelectorAll(PANEL_SELECTOR));

    // Inert on non-cockpit pages or when there is nothing to navigate.
    if (!grid || panels.length < 2) return;
    if (document.getElementById(NAV_ID)) return;

    var built = buildNav(panels);

    // Insert the jump-nav directly before the panel grid so it reads as the
    // page's section index -- keeps the existing cockpit IA, just makes it
    // navigable. Does not touch the locked Command Hub sidebar.
    grid.parentNode.insertBefore(built.nav, grid);

    wireScrollSpy(panels, built.links);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
