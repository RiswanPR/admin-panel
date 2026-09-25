/**
 * Zeitnah Admin Panel — Global View Toggle, State Preservation & Button Interaction Guard
 * Manages:
 * - Card View (Default) vs Table View toggling
 * - URL state (?view=card|table) preservation
 * - localStorage view memory per section (fallback to card)
 * - Pagination & filter link synchronization
 * - Double-submission prevention across modal mutations
 */
(function () {
  'use strict';

  /**
   * Initialize all view toggle groups on page load
   */
  function initViewToggles() {
    const toggles = document.querySelectorAll('.admin-view-toggle');
    if (!toggles.length) return;

    toggles.forEach(toggle => {
      const section = toggle.getAttribute('data-section') || 'default';
      const storageKey = 'zeitnah_admin_view_' + section;

      // 1. Check URL query first
      const urlParams = new URLSearchParams(window.location.search);
      const urlView = urlParams.get('view');
      let targetView = 'card'; // Always card by default

      if (urlView === 'card' || urlView === 'table') {
        targetView = urlView;
        try {
          localStorage.setItem(storageKey, targetView);
        } catch (e) {}
      } else {
        // 2. Check localStorage if no URL param was provided
        try {
          const cached = localStorage.getItem(storageKey);
          if (cached === 'card' || cached === 'table') {
            targetView = cached;
          }
        } catch (e) {}
      }

      // Apply initial view state without overriding URL if none was specified
      applyViewState(section, targetView, false);

      // Attach click events to toggle buttons
      const buttons = toggle.querySelectorAll('.view-toggle-btn');
      buttons.forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          const view = this.getAttribute('data-view');
          if (view === 'card' || view === 'table') {
            applyViewState(section, view, true);
          }
        });
      });
    });
  }

  /**
   * Apply view state for a given section
   * @param {string} section - Section identifier
   * @param {string} view - 'card' or 'table'
   * @param {boolean} updateUrlAndStorage - whether to update URL & localStorage
   */
  function applyViewState(section, view, updateUrlAndStorage) {
    if (view !== 'card' && view !== 'table') {
      view = 'card'; // safe fallback
    }

    const storageKey = 'zeitnah_admin_view_' + section;
    if (updateUrlAndStorage) {
      try {
        localStorage.setItem(storageKey, view);
      } catch (e) {}

      // Preserve all current query parameters while updating `view`
      const url = new URL(window.location.href);
      url.searchParams.set('view', view);
      window.history.replaceState({ section, view }, '', url.toString());
    }

    // 1. Update View Toggle UI buttons
    const toggle = document.querySelector(`.admin-view-toggle[data-section="${section}"]`);
    if (toggle) {
      const btns = toggle.querySelectorAll('.view-toggle-btn');
      btns.forEach(b => {
        const bView = b.getAttribute('data-view');
        if (bView === view) {
          b.classList.add('active');
          b.setAttribute('aria-pressed', 'true');
        } else {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        }
      });
    }

    // 2. Toggle Card Container vs Table Container
    const cardContainers = document.querySelectorAll(
      `#${section}CardView, .admin-cards-container[data-section="${section}"], .admin-cards-view[data-section="${section}"]`
    );
    const tableContainers = document.querySelectorAll(
      `#${section}TableView, .admin-table-container[data-section="${section}"], .admin-table-view[data-section="${section}"]`
    );

    if (view === 'card') {
      cardContainers.forEach(el => el.classList.remove('d-none'));
      tableContainers.forEach(el => el.classList.add('d-none'));
    } else {
      cardContainers.forEach(el => el.classList.add('d-none'));
      tableContainers.forEach(el => el.classList.remove('d-none'));
    }

    // 3. Update hidden form input in filter forms to preserve view on submit
    document.querySelectorAll('form input[name="view"]').forEach(input => {
      input.value = view;
    });

    // 4. Update pagination links to preserve selected view
    document.querySelectorAll('a[href*="page="]').forEach(link => {
      try {
        const linkUrl = new URL(link.getAttribute('href'), window.location.origin);
        linkUrl.searchParams.set('view', view);
        link.setAttribute('href', linkUrl.pathname + linkUrl.search);
      } catch (e) {}
    });

    // 5. Update tab navigation links to preserve selected view
    document.querySelectorAll('.nav-tabs a.nav-link, .nav-pills a.nav-link').forEach(link => {
      const href = link.getAttribute('href');
      if (href && (href.startsWith('?') || href.startsWith('/admin') || href.startsWith('/'))) {
        try {
          const linkUrl = new URL(href, window.location.origin);
          linkUrl.searchParams.set('view', view);
          link.setAttribute('href', linkUrl.pathname + linkUrl.search);
        } catch (e) {}
      }
    });
  }

  /**
   * Helper to set submitting state on a button to prevent double-clicks
   */
  window.zeitnahSetSubmitting = function (btn, text = 'Processing...') {
    if (!btn) return '';
    const originalHtml = btn.innerHTML;
    btn.setAttribute('data-original-html', originalHtml);
    btn.disabled = true;
    btn.classList.add('btn-submitting');
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin me-1"></i> ${text}`;
    return originalHtml;
  };

  /**
   * Helper to restore button from submitting state
   */
  window.zeitnahResetSubmitting = function (btn) {
    if (!btn) return;
    const originalHtml = btn.getAttribute('data-original-html');
    if (originalHtml) {
      btn.innerHTML = originalHtml;
    }
    btn.disabled = false;
    btn.classList.remove('btn-submitting');
  };

  /**
   * Public API
   */
  window.zeitnahSwitchView = function (section, view) {
    applyViewState(section, view, true);
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewToggles);
  } else {
    initViewToggles();
  }
})();
