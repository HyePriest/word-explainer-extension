// Shared appearance preference for extension pages and the isolated webpage UI.
(function () {
  'use strict';
  if (globalThis.WordExplainerTheme) return;

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();
  let preference = 'system';
  let revision = 0;
  const normalize = (value) => value === 'light' || value === 'dark' ? value : 'system';
  const snapshot = () => ({
    preference,
    resolved: preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference,
  });
  const notify = () => {
    const state = snapshot();
    listeners.forEach((listener) => listener(state));
  };
  const update = (value) => {
    preference = normalize(value);
    revision += 1;
    notify();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) update(changes.theme.newValue);
  });
  systemTheme.addEventListener('change', () => {
    if (preference === 'system') notify();
  });

  const ready = new Promise((resolve) => {
    const initialRevision = revision;
    try {
      chrome.storage.local.get({ theme: 'system' }, (stored) => {
        const failed = chrome.runtime.lastError;
        // A newer change must win over a delayed initial storage read.
        if (!failed && revision === initialRevision) update(stored?.theme);
        resolve(!failed);
      });
    } catch (_) {
      resolve(false);
    }
  });

  globalThis.WordExplainerTheme = Object.freeze({
    ready,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async setPreference(value) {
      const theme = normalize(value);
      const beforeSave = revision;
      await chrome.storage.local.set({ theme });
      // onChanged normally applies this first; do not overwrite a newer change.
      if (revision === beforeSave) update(theme);
    },
  });

  // Only our own pages opt in. Never recolor the surrounding website.
  if (document.documentElement.hasAttribute('data-we-theme-page')) {
    WordExplainerTheme.subscribe(({ resolved }) => {
      document.documentElement.dataset.weTheme = resolved;
    });
  }
})();
