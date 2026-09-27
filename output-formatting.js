(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WordExplainerOutputFormatting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isRedundantEnglishStatus(line) {
    const plain = String(line || '').replace(/\*\*/g, '').trim();
    return /^(?:语言|Language)\s*[：:]\s*(?:英语|英文|English)(?:\s*[（(][^\n]*[)）])?\s*$/iu.test(plain);
  }

  function normalizeTranslationLabel(line) {
    const match = String(line || '').match(/^\*\*(译文|Explanation|Translation)([：:])\s*(.+)\*\*\s*$/iu);
    if (!match) return null;
    return [`**${match[1]}${match[2]}**`, match[3]];
  }

  function normalizeExplanationMarkdown(markdown, inputType) {
    const lines = String(markdown || '').replace(/\r/g, '').split('\n');
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    if (lines.length > 0 && isRedundantEnglishStatus(lines[0])) {
      lines.shift();
      while (lines.length > 0 && !lines[0].trim()) lines.shift();
    }

    if (inputType !== 'PASSAGE') return lines.join('\n');

    const normalized = [];
    let insideTranslation = false;
    for (const line of lines) {
      const splitLabel = normalizeTranslationLabel(line);
      if (splitLabel) {
        normalized.push(splitLabel[0], splitLabel[1]);
        insideTranslation = true;
        continue;
      }

      if (/^\*\*(?:译文|Explanation|Translation)[：:]\*\*\s*$/iu.test(line.trim())) {
        insideTranslation = true;
        normalized.push(line);
        continue;
      }

      if (insideTranslation && (/^\s*[-*]\s+/u.test(line) || /^\*\*(?:可能的 OCR 错误|Possible OCR error|词汇|Vocabulary|语法|Grammar)[：:]\*\*/iu.test(line.trim()))) {
        insideTranslation = false;
      }

      const boldParagraph = insideTranslation ? line.match(/^\s*\*\*(.+)\*\*\s*$/u) : null;
      normalized.push(boldParagraph ? boldParagraph[1] : line);
    }
    return normalized.join('\n');
  }

  return {
    isRedundantEnglishStatus,
    normalizeExplanationMarkdown,
  };
});
