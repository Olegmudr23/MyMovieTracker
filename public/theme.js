(() => {
  const storageKey = 'kinokrug-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value);
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (valid(saved)) preference = saved;
  } catch { /* Theme selection still works when browser storage is unavailable. */ }

  function apply() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (system.matches ? 'dark' : 'light') : preference;
    const select = document.getElementById('theme-select');
    if (select) select.value = preference;
  }

  // Runs before the stylesheet so the first paint uses the selected theme.
  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : 'system';
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-select').addEventListener('change', event => {
      preference = valid(event.target.value) ? event.target.value : 'system';
      try { localStorage.setItem(storageKey, preference); } catch { /* Session-only choice. */ }
      apply();
    });
  });
})();
