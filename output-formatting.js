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

  function classifyInput(text) {
    const normalized = text.trim();
    const wordCandidate = normalized.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}'’\-]+$/gu, '');
    if (wordCandidate && /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u.test(wordCandidate)) return 'WORD';

    const wordCount = (normalized.match(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu) || []).length;
    const hasSentenceEnding = /[.!?。！？](?:[\s”’"')\]]|$)/u.test(normalized);
    if (wordCount > 0 && wordCount <= 8 && !hasSentenceEnding && !normalized.includes('\n')) return 'PHRASE';
    return 'PASSAGE';
  }


  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function parseMarkdown(md) {
    let html = escapeHtml(md);

    // 粗体
    html = html.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
    // 斜体
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // 行内代码
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // 表格预处理
    const tableRegex = /(\|.+\|\n\|[-:\s|]+\|\n)((?:\|.+\|\n?)+)/g;
    html = html.replace(tableRegex, (match, headerSep, dataLines) => {
      const headers = headerSep.split('\n')[0].split('|').filter(c => c.trim()).map(c => c.trim());
      const rows = dataLines.trim().split('\n').map(line => {
        const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
        return '<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
      }).join('');
      return '<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
    });

    // Block 级处理
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 水平分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        if (inList) { result.push('</ul>'); inList = false; }
        result.push('<hr>');
        continue;
      }

      // 标题
      const headingMatch = trimmed.match(/^(#{1,6})\s(.+)$/);
      if (headingMatch) {
        if (inList) { result.push('</ul>'); inList = false; }
        const level = headingMatch[1].length;
        result.push(`<h${level}>${headingMatch[2]}</h${level}>`);
        continue;
      }

      // 无序列表
      if (/^[-*]\s/.test(trimmed)) {
        if (!inList) { result.push('<ul>'); inList = true; }
        result.push('<li>' + trimmed.replace(/^[-*]\s/, '') + '</li>');
        continue;
      }

      if (inList) { result.push('</ul>'); inList = false; }

      // 已是 HTML block
      if (/^<(table|thead|tbody|tr|th|td)\b/.test(trimmed)) {
        result.push(trimmed);
        continue;
      }

      if (trimmed === '') { result.push('<br>'); continue; }

      result.push('<p>' + trimmed + '</p>');
    }

    if (inList) result.push('</ul>');
    return result.join('');
  }

  return {
    classifyInput,
    parseMarkdown,
    isRedundantEnglishStatus,
    normalizeExplanationMarkdown,
  };
});
