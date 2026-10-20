(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WordImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_DOCX_BYTES = 10 * 1024 * 1024;
  const HEADING = /^\s*(?:【\s*第\s*([0-9０-９一二三四五六七八九十百]+)\s*题\s*】|第\s*([0-9０-９一二三四五六七八九十百]+)\s*题(?=$|[\s:：.．、—-]))\s*(?:[:：.．、—-]\s*)?(.*)$/u;
  const ROUND = /^\s*(?:[①-⑳]|第\s*[0-9０-９一二三四五六七八九十百]+\s*(?:轮|回合)(?:\s*(?:用户|助手|系统))?|(?:用户|助手|系统|User|Assistant)\s*[:：])(?:\s*[:：.．、—-])?/iu;
  const MATERIAL_CLUES = [
    ['图片', /图片|图像|截图|下图|上图|见图|图中|配图|插图/u],
    ['表格', /表格|下表|上表|见表|表中|数据表/u],
    ['附件', /附件|附文件|附带文件|上传的文件|见文件|附录|附带资料/u],
  ];

  function readNumber(raw) {
    const normalized = raw.replace(/[０-９]/gu, digit => String(digit.charCodeAt(0) - 65296));
    if (/^\d+$/u.test(normalized)) return Number(normalized);
    const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0;
    let current = 0;
    for (const character of normalized) {
      if (character === '百' || character === '十') {
        const unit = character === '百' ? 100 : 10;
        total += (current || 1) * unit;
        current = 0;
      } else if (Object.hasOwn(digits, character)) {
        current = digits[character];
      } else {
        return NaN;
      }
    }
    return total + current;
  }

  function makeDraft(lines, number, headingTitle, filename, warnings, label) {
    const body = lines.map(line => line.trim()).filter(Boolean);
    const turns = [];
    let markedRounds = 0;
    for (const line of body) {
      if (ROUND.test(line)) {
        turns.push(line);
        markedRounds++;
      } else if (turns.length) {
        turns[turns.length - 1] += ' ' + line;
      } else {
        turns.push(line);
      }
    }
    if (markedRounds === 0) warnings.push(`${label}未检测到明确轮次，请核对对话切分。`);
    else if (markedRounds === 1) warnings.push(`${label}仅识别到一轮对话，请核对是否缺少轮次。`);
    if (body.length === 0) warnings.push(`${label}没有可用的对话内容。`);
    const joined = body.join('\n');
    for (const [kind, pattern] of MATERIAL_CLUES) {
      if (pattern.test(joined)) warnings.push(`${label}可能依赖${kind}，请核对原 Word 文档并补充缺失材料。`);
    }
    return {
      title: headingTitle || (number === undefined ? '未编号题目' : `第${number}题`),
      turns,
      reference: '',
      dimension: '意图识别',
      approved: false,
      source: Object.assign({ filename }, number === undefined ? {} : { questionNumber: number }),
    };
  }

  function parseQuestionText(rawText, sourceName) {
    if (typeof rawText !== 'string') throw new TypeError('Word 文字内容必须是字符串。');
    const filename = typeof sourceName === 'string' ? sourceName : '';
    const text = rawText.replace(/\r\n?/gu, '\n').replace(/\u0000/gu, '');
    const lines = text.split('\n');
    if (!lines.some(line => line.trim())) {
      return { drafts: [], warnings: ['未提取到文字，文档可能是扫描件或仅包含图片。'] };
    }

    const warnings = [];
    const groups = [];
    let current = { number: undefined, title: '', lines: [] };
    let foundHeading = false;
    for (const line of lines) {
      const match = HEADING.exec(line);
      const number = match ? readNumber(match[1] || match[2]) : NaN;
      if (match && Number.isSafeInteger(number) && number > 0) {
        if (current.lines.some(previous => previous.trim()) || current.number !== undefined) groups.push(current);
        const headingRemainder = match[3].trim();
        current = ROUND.test(headingRemainder)
          ? { number, title: '', lines: [headingRemainder] }
          : { number, title: headingRemainder, lines: [] };
        foundHeading = true;
      } else {
        current.lines.push(line);
      }
    }
    if (current.lines.some(line => line.trim()) || current.number !== undefined) groups.push(current);
    if (!foundHeading) warnings.push('未检测到题号，已按一道未编号题目生成草稿，请确认切题边界。');
    else if (groups[0] && groups[0].number === undefined) warnings.push('首段未编号内容已生成单独草稿，请确认切题边界。');

    const seen = new Set();
    const numbers = [];
    for (const group of groups) {
      if (group.number === undefined) continue;
      if (seen.has(group.number)) warnings.push(`发现重复题号：第${group.number}题，请核对切题边界。`);
      else {
        seen.add(group.number);
        numbers.push(group.number);
      }
    }
    numbers.sort((left, right) => left - right);
    let previous = 0;
    for (const number of numbers) {
      if (number > previous + 1) {
        const start = previous + 1;
        const end = number - 1;
        warnings.push(start === end ? `缺少第${start}题，请核对原文编号。` : `缺少第${start}题至第${end}题，请核对原文编号。`);
      }
      previous = number;
    }

    const drafts = groups.map((group, index) => {
      const label = group.number === undefined ? `未编号草稿${index + 1}` : `第${group.number}题`;
      return makeDraft(group.lines, group.number, group.title, filename, warnings, label);
    });
    return { drafts, warnings };
  }

  function getMammoth() {
    if (root.mammoth && typeof root.mammoth.extractRawText === 'function') return root.mammoth;
    if (typeof require === 'function') {
      try {
        return require('./vendor/mammoth.browser.min.js');
      } catch (_) {
        // The browser must load the bundled script before this module.
      }
    }
    throw new Error('Word 解析组件未加载，请刷新页面后重试。');
  }

  async function sha256(buffer) {
    if (!root.crypto || !root.crypto.subtle) return undefined;
    try {
      const digest = await root.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return undefined;
    }
  }

  async function readDocx(file) {
    if (!file || typeof file.name !== 'string' || !/\.docx$/iu.test(file.name)) {
      throw new Error('请选择 .docx 格式的 Word 文件。');
    }
    if (typeof file.size === 'number' && file.size > MAX_DOCX_BYTES) {
      throw new Error('Word 文件不能超过 10 MB。');
    }
    if (typeof file.arrayBuffer !== 'function') {
      throw new Error('无法读取 Word 文件：缺少 arrayBuffer 方法。');
    }
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      throw new Error(`无法读取 Word 文件：${error.message || String(error)}`);
    }
    if (!(buffer instanceof ArrayBuffer)) throw new Error('无法读取 Word 文件：内容不是 ArrayBuffer。');
    if (buffer.byteLength > MAX_DOCX_BYTES) throw new Error('Word 文件不能超过 10 MB。');

    let extracted;
    try {
      extracted = await getMammoth().extractRawText({ arrayBuffer: buffer });
    } catch (error) {
      throw new Error(`Word 文档解析失败：${error.message || String(error)}`);
    }
    const parsed = parseQuestionText(extracted.value || '', file.name);
    const hash = await sha256(buffer);
    const source = Object.assign({ filename: file.name }, hash ? { hash } : {});
    for (const draft of parsed.drafts) {
      if (hash) draft.source.hash = hash;
    }
    const messages = Array.isArray(extracted.messages) ? extracted.messages : [];
    for (const message of messages) {
      const detail = typeof message === 'string' ? message : message && message.message;
      if (detail) parsed.warnings.push(`Word 解析提示：${detail}`);
    }
    return { drafts: parsed.drafts, warnings: parsed.warnings, source };
  }

  return { parseQuestionText, readDocx };
});
