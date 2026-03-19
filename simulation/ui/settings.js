// Fetch backend settings so UI stays in sync with the Python engine
// Tries configured API base, then same-origin fallback, else returns defaults.
(function () {
  const DEFAULTS = {
    grid_size: 200,
    sector_rows: 10,
    sector_cols: 10,
    passive_survivor_radius: 18.0,
  };

  function resolveBase() {
    if (window.API_BASE) return window.API_BASE;
    const stored = localStorage.getItem('API_BASE');
    if (stored) return stored;
    return 'http://localhost:8000';
  }

  function settingsUrlRelative() {
    const current = document.currentScript?.src;
    if (!current) return '/settings.json';
    try {
      const url = new URL('./settings.json', current);
      return url.toString();
    } catch (e) {
      return '/settings.json';
    }
  }

  async function tryFetch(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn('[settings] fetch failed for', url, e.message || e);
      return null;
    }
  }

  window.setApiBase = function setApiBase(url) {
    if (url) {
      window.API_BASE = url;
      localStorage.setItem('API_BASE', url);
    }
  };

  window.fetchSettings = async function fetchSettings() {
    const attempts = [];

    const origin = window.location.origin;
    const isFile = origin === 'null' || origin.startsWith('file:');

    // Deterministic order: local file, local HTTP, API base, same-origin API
    attempts.push(settingsUrlRelative()); // relative to this script
    if (isFile) {
      attempts.push('./settings.json');
      attempts.push('http://localhost:8001/settings.json');
    }
    attempts.push(`${resolveBase()}/settings`);
    attempts.push('/settings');

    for (const url of attempts) {
      const data = await tryFetch(url);
      if (data) return data;
    }

    console.warn('[settings] falling back to defaults');
    return DEFAULTS;
  };
})();
