(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WordExplainerBackgroundCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CACHE_TTL_MS = 10 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 50;

  function getOutputTokenLimit(inputType, text) {
    if (inputType === 'WORD') return 700;
    if (inputType === 'PHRASE') return 900;
    const length = typeof text === 'string' ? text.length : 0;
    return Math.min(8_000, Math.max(1_200, 800 + Math.ceil(length * 0.9)));
  }

  function extractSseEvents(buffer) {
    const parts = String(buffer || '').split(/\r?\n\r?\n/);
    return { events: parts.slice(0, -1), remainder: parts.at(-1) || '' };
  }

  function normalizeSourceKind(sourceKind) {
    return String(sourceKind || '').toUpperCase() === 'OCR' ? 'OCR' : 'SELECTION';
  }

  function buildExplanationUserPayload(inputType, text, sourceKind) {
    const normalizedInputType = ['WORD', 'PHRASE', 'PASSAGE'].includes(inputType) ? inputType : 'PASSAGE';
    return {
      input_type: normalizedInputType,
      output_scope: normalizedInputType === 'PASSAGE' && String(text || '').length > 4000
        ? 'TRANSLATION_ONLY'
        : 'STANDARD',
      source_kind: normalizeSourceKind(sourceKind),
      source_text: String(text || ''),
    };
  }

  function buildCacheKey(model, mode, inputType, text, sourceKind) {
    return JSON.stringify([model, mode, inputType, normalizeSourceKind(sourceKind), text]);
  }

  function isRetryableStatus(status) {
    return [408, 429, 500, 502, 503, 504].includes(Number(status));
  }

  class ExpiringLruCache {
    constructor(maxEntries = CACHE_MAX_ENTRIES, ttlMs = CACHE_TTL_MS) {
      this.maxEntries = maxEntries;
      this.ttlMs = ttlMs;
      this.entries = new Map();
    }

    get(key, now = Date.now()) {
      const entry = this.entries.get(key);
      if (!entry) return null;
      if (now - entry.savedAt > this.ttlMs) {
        this.entries.delete(key);
        return null;
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value;
    }

    set(key, value, now = Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, { value, savedAt: now });
      while (this.entries.size > this.maxEntries) {
        this.entries.delete(this.entries.keys().next().value);
      }
    }
  }

  return {
    CACHE_MAX_ENTRIES,
    CACHE_TTL_MS,
    ExpiringLruCache,
    buildCacheKey,
    buildExplanationUserPayload,
    extractSseEvents,
    getOutputTokenLimit,
    isRetryableStatus,
    normalizeSourceKind,
  };
});
