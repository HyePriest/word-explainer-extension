(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WordExplainerShortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isPageOcrShortcut(event, platform = '') {
    const isWindows = /^win/i.test(String(platform));
    if (!isWindows || event?.repeat || event?.code !== 'KeyY' || !event.shiftKey) return false;
    if (event.ctrlKey || event.altKey) return false;
    let windowsKey = !!event.metaKey;
    try {
      windowsKey = windowsKey || !!event.getModifierState?.('OS');
    } catch (_) {}
    return windowsKey;
  }

  return { isPageOcrShortcut };
});
