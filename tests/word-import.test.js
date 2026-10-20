const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseQuestionText, readDocx } = require('../word-import.js');

test('splits a leading unnumbered group and explicit headings into editable drafts', () => {
  const input = [
    '用户：先帮我整理需求。',
    '第一轮：请列出三个要点。',
    '第二轮：改成一段摘要。',
    '',
    '【第2题】 修订后的任务',
    '① 用户：写一封通知。',
    '② 用户：改成短信，保留日期。',
    '',
    '第3题：最后一个任务',
    '第1轮：给出方案。',
    '第2轮：只保留结论。',
  ].join('\n');

  const { drafts, warnings } = parseQuestionText(input, '样例.docx');
  assert.equal(drafts.length, 3);
  assert.deepEqual(drafts.map(draft => draft.source.questionNumber), [undefined, 2, 3]);
  assert.equal(drafts[1].title, '修订后的任务');
  assert.equal(drafts[2].title, '最后一个任务');
  assert.equal(drafts[1].turns.length, 2);
  assert.match(drafts[1].turns[1], /改成短信，保留日期/);
  for (const draft of drafts) {
    assert.equal(draft.approved, false);
    assert.equal(draft.reference, '');
    assert.equal(draft.dimension, '意图识别');
    assert.equal(draft.source.filename, '样例.docx');
  }
  assert.match(warnings.join('\n'), /未编号/);
});

test('warns about missing and duplicate question numbers without discarding either draft', () => {
  const input = [
    '第1题：第一题',
    '第一轮：A',
    '第3题：第三题',
    '第一轮：B',
    '【第3题】重复题号',
    '第一轮：C',
  ].join('\n');

  const { drafts, warnings } = parseQuestionText(input);
  assert.equal(drafts.length, 3);
  assert.deepEqual(drafts.map(draft => draft.source.questionNumber), [1, 3, 3]);
  assert.match(warnings.join('\n'), /缺少第2题/);
  assert.match(warnings.join('\n'), /重复.*第3题/);
});

test('keeps one unnumbered draft when no heading is found and flags uncertain rounds', () => {
  const { drafts, warnings } = parseQuestionText('请读取以下对话，然后完成最后的要求。', 'single.docx');
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].turns, ['请读取以下对话，然后完成最后的要求。']);
  assert.equal(drafts[0].approved, false);
  assert.match(warnings.join('\n'), /未检测到题号/);
  assert.match(warnings.join('\n'), /轮次/);
});

test('joins continuation paragraphs into the same single-line turn for bank editing', () => {
  const { drafts } = parseQuestionText('第1题\n第一轮：先写草稿。\n补充说明。\n第二轮：只保留结论。');
  assert.deepEqual(drafts[0].turns, [
    '第一轮：先写草稿。 补充说明。',
    '第二轮：只保留结论。',
  ]);
  assert.equal(drafts[0].turns.some(turn => turn.includes('\n')), false);
});

test('keeps a first round written on the heading line', () => {
  const { drafts } = parseQuestionText('【第1题】 第一轮：先写提纲。\n第二轮：改为摘要。');
  assert.equal(drafts[0].title, '第1题');
  assert.deepEqual(drafts[0].turns, ['第一轮：先写提纲。', '第二轮：改为摘要。']);
});

test('reports empty text and document material that may be missing from text extraction', () => {
  const empty = parseQuestionText(' \r\n  \n');
  assert.deepEqual(empty.drafts, []);
  assert.match(empty.warnings.join('\n'), /未提取到文字/);

  const { warnings } = parseQuestionText('第1题\n第一轮：请参考下图、表格和附件中的数据。');
  assert.match(warnings.join('\n'), /图片/);
  assert.match(warnings.join('\n'), /表格/);
  assert.match(warnings.join('\n'), /附件/);
});

test('rejects non-docx, oversized, and unreadable input before extraction', async () => {
  const goodName = { name: 'questions.docx', size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(readDocx({ ...goodName, name: 'questions.doc' }), /\.docx/);
  await assert.rejects(readDocx(goodName), /10\s*MB/);
  await assert.rejects(readDocx({ name: 'questions.docx', size: 1 }), /读取|arrayBuffer/);
});

test('reads a local ArrayBuffer through Mammoth and returns source metadata', async () => {
  const original = globalThis.mammoth;
  const input = new Uint8Array([1, 2, 3]).buffer;
  let received;
  globalThis.mammoth = {
    extractRawText: async options => {
      received = options.arrayBuffer;
      return { value: '第1题：任务\n第一轮：先写草稿。\n第二轮：只保留结论。', messages: [] };
    },
  };
  try {
    const result = await readDocx({ name: 'questions.DOCX', size: 3, arrayBuffer: async () => input });
    assert.equal(received, input);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0].source.filename, 'questions.DOCX');
    assert.equal(result.source.filename, 'questions.DOCX');
    assert.equal(result.drafts[0].approved, false);
  } finally {
    if (original === undefined) delete globalThis.mammoth;
    else globalThis.mammoth = original;
  }
});

test('reports a corrupt docx as a parse failure', async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  await assert.rejects(
    readDocx({ name: 'broken.docx', size: 3, arrayBuffer: async () => bytes }),
    /Word 文档解析失败/,
  );
});

test('exposes WordImport to static browser script tags', () => {
  const sandbox = vm.createContext({});
  sandbox.window = sandbox;
  const source = fs.readFileSync(path.join(__dirname, '..', 'word-import.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'word-import.js' });
  assert.equal(typeof sandbox.WordImport.parseQuestionText, 'function');
  assert.equal(typeof sandbox.WordImport.readDocx, 'function');
});
