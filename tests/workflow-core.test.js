const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../workflow-core.js');

const models = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' }
];

function fixtureRun() {
  return Core.createRun([
    {
      id: 1, version: 2, title: '先写文章，后改封面', dimension: '后续修正',
      turns: ['写一篇文章', '只要封面图'], reference: '只需封面图',
      retained: ['公众号尺寸'], superseded: ['文章正文'], missing: [],
      source: { filename: 'fictional.docx' }, approved: true
    },
    {
      id: 2, version: 1, title: '保留约束', dimension: '约束保留',
      turns: ['列出三个方案', '保留预算限制'], reference: '三个方案且符合预算',
      approved: true
    },
    { id: 3, version: 1, title: '草稿', turns: ['尚未确认'], approved: false }
  ], models, 'run-1', '2026-10-19T00:00:00.000Z');
}

function importedAnswers(run) {
  const rows = run.questions.flatMap((question) => models.map((model) => ({
    runId: run.id, questionId: question.id, questionVersion: question.version,
    modelId: model.id, text: `${model.id} 对题 ${question.id} 的完成结果`
  })));
  const result = Core.validateImportedAnswers(run, { runId: run.id, answers: rows, createdAt: '2026-10-19T01:00:00.000Z' });
  assert.deepEqual(result.errors, []);
  return result.answers;
}

function rate(comparison, choice, extras = {}) {
  return {
    runId: comparison.runId, questionId: comparison.questionId,
    comparisonId: comparison.id, leftAnswerKey: comparison.leftAnswerKey,
    rightAnswerKey: comparison.rightAnswerKey, choice, reason: '人工证据', ...extras
  };
}

function review(run, question, subjectId, answerKey, label, extras = {}) {
  return {
    runId: run.id, questionId: question.id, questionVersion: question.version,
    subjectId, answerKey, label, reason: '依据已核实', requirements: [], ...extras
  };
}

test('createRun freezes approved legacy questions and model labels', () => {
  const input = [
    { id: 9, version: 3, title: '题', dimension: '意图', turns: ['第一轮'], reference: '做图', retained: ['蓝色'], approved: true },
    { id: 10, version: 1, approved: false }
  ];
  const run = Core.createRun(input, models, 'frozen', new Date('2026-10-19T00:00:00Z'));
  assert.equal(run.format, 'morgan-intent-run-v1');
  assert.equal(run.status, 'draft');
  assert.equal(run.questions.length, 1);
  assert.deepEqual(run.models, models);
  input[0].turns[0] = '后来改写';
  input[0].retained.push('红色');
  assert.deepEqual(run.questions[0].turns, ['第一轮']);
  assert.deepEqual(run.questions[0].retained, ['蓝色']);
  assert.equal(run.questions[0].version, 3);
});

test('test points and observable rubric are frozen and coverage excludes drafts and demos', () => {
  const questions = [
    { id: 1, version: 1, title: '修改输出形式', dimension: '意图识别', testPoint: '后续修正与覆盖',
      subPoint: '保留时间约束', successCriteria: ['输出中文短信', '保留时间'], failureSignals: ['继续写英文邮件'],
      turns: ['先写邮件', '改成短信'], reference: '中文短信', approved: true },
    { id: 2, version: 1, title: '旧题', dimension: '意图识别', turns: ['做任务'], reference: '做任务', approved: true },
    { id: 3, version: 1, title: '草稿', dimension: '信息完整性', testPoint: '信息缺失与澄清', approved: false },
    { id: 4, version: 1, title: '演示', approved: true, isDemo: true }
  ];
  const coverage = Core.summarizeCoverage(questions);
  assert.deepEqual({ total: coverage.total, approved: coverage.approved, drafts: coverage.drafts, rubricReady: coverage.rubricReady },
    { total: 3, approved: 2, drafts: 1, rubricReady: 1 });
  assert.deepEqual(coverage.testPoints, { '后续修正与覆盖': 1, '未标注': 1 });
  const run = Core.createRun(questions.slice(0, 2), [models[0]], 'coverage-run', '2026-10-20T00:00:00Z');
  questions[0].successCriteria[0] = '后来被改动';
  assert.equal(run.questions[0].successCriteria[0], '输出中文短信');
  assert.equal(run.questions[0].testPoint, '后续修正与覆盖');
  const report = Core.summarizeReport(run, [], [], [], []);
  assert.equal(report.coverage.rubricReady, 1);
  assert.equal(report.coverage.testPoints['未标注'], 1);
});

test('import rejects all invalid records atomically and reports each boundary error', () => {
  const run = fixtureRun();
  const valid = { runId: run.id, questionId: 1, questionVersion: 2, modelId: 'alpha', text: '有效答案' };
  const result = Core.validateImportedAnswers(run, {
    runId: run.id,
    answers: [
      valid,
      { ...valid, text: '重复答案' },
      { ...valid, questionId: 999 },
      { ...valid, questionVersion: 1 },
      { ...valid, modelId: 'unknown' },
      { ...valid, text: '   ' },
      { ...valid, runId: 'other-run' },
      { ...valid, status: 'failed' }
    ]
  });
  assert.deepEqual(result.answers, []);
  assert(result.errors.length >= 7);
  assert.match(result.errors.join(' '), /重复/);
  assert.match(result.errors.join(' '), /版本/);
  assert.match(result.errors.join(' '), /空/);
  assert.match(result.errors.join(' '), /缺少/);
});

test('an incomplete Agent result is rejected before any answer is accepted', () => {
  const run = fixtureRun();
  const rows = run.questions.flatMap((question) => models.map((model) => ({
    runId: run.id, questionId: question.id, questionVersion: question.version,
    modelId: model.id, text: '有效答案'
  })));
  rows.pop();
  const result = Core.validateImportedAnswers(run, { runId: run.id, answers: rows });
  assert.deepEqual(result.answers, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /缺少题目 2 v1、模型 gamma/);
});

test('import preserves validated provider metadata and report exposes selected answer provenance', () => {
  const run = fixtureRun();
  const rows = run.questions.flatMap((question) => models.map((model) => ({
    questionId: question.id, questionVersion: question.version,
    modelId: model.id, text: '完整答案'
  })));
  Object.assign(rows[0], {
    attempt: 3, providerModel: ' deepseek-chat-2026-10 ', latencyMs: 1234.5,
    usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
  });
  const imported = Core.validateImportedAnswers(run, {
    runId: run.id, createdAt: '2026-10-19T01:23:45.000Z',
    answers: rows
  });
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.answers[0].providerModel, 'deepseek-chat-2026-10');
  assert.equal(imported.answers[0].latencyMs, 1234.5);
  assert.deepEqual(imported.answers[0].usage, { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
  assert.match(imported.answers[0].answerKey, /^1:2:alpha:3:/);

  const apiAnswer = {
    runId: run.id, questionId: 2, questionVersion: 1, modelId: 'beta',
    text: 'API 答案', status: 'succeeded', attempt: 2, source: 'api',
    createdAt: '2026-10-19T02:00:00.000Z', providerModel: 'glm-5.3-flash-release',
    durationMs: 800, usage: { inputTokens: 12, outputTokens: 18 }
  };
  const report = Core.summarizeReport(run, [...imported.answers, apiAnswer], [], [], []);
  const agentRow = report.questions[0].models.find((item) => item.modelId === 'alpha');
  assert.equal(agentRow.providerModel, 'deepseek-chat-2026-10');
  assert.equal(agentRow.attempt, 3);
  assert.equal(agentRow.source, 'agent-import');
  assert.equal(agentRow.createdAt, '2026-10-19T01:23:45.000Z');
  assert.equal(agentRow.latencyMs, 1234.5);
  assert.deepEqual(agentRow.usage, imported.answers[0].usage);
  const apiRow = report.questions[1].models.find((item) => item.modelId === 'beta');
  assert.equal(apiRow.providerModel, 'glm-5.3-flash-release');
  assert.equal(apiRow.attempt, 2);
  assert.equal(apiRow.source, 'api');
  assert.equal(apiRow.latencyMs, 800);
  assert.deepEqual(apiRow.usage, { inputTokens: 12, outputTokens: 18 });
});

test('invalid provider metadata rejects the entire import', () => {
  const run = fixtureRun();
  const rows = run.questions.flatMap((question) => models.map((model) => ({
    questionId: question.id, questionVersion: question.version,
    modelId: model.id, text: '原本有效'
  })));
  Object.assign(rows.find((row) => row.questionId === 2 && row.modelId === 'beta'), {
    text: '元数据错误', providerModel: '  ', latencyMs: -5,
    usage: { prompt_tokens: '12', apiKey: 123 }
  });
  const result = Core.validateImportedAnswers(run, {
    runId: run.id,
    answers: rows
  });
  assert.deepEqual(result.answers, []);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join(' '), /providerModel/);
  assert.match(result.errors.join(' '), /latencyMs/);
  assert.match(result.errors.join(' '), /usage/);
});

test('changed model text, human revision, and stale question answers cannot score', () => {
  const run = fixtureRun();
  const original = importedAnswers(run);
  const comparison = Core.buildComparisons(run, original)[0];
  const firstModel = original.find((answer) => answer.answerKey === comparison.leftAnswerKey);
  const humanV1 = {
    runId: run.id, questionId: 1, questionVersion: 2, revision: 1,
    answerKey: 'human:1:2:1', text: '人工第一稿'
  };
  const originalReviews = [
    review(run, run.questions[0], firstModel.modelId, firstModel.answerKey, 'pass'),
    review(run, run.questions[0], 'human', humanV1.answerKey, 'pass')
  ];
  const changed = original.map((answer) => answer === firstModel ? { ...answer, text: '同一 attempt 被修改' } : answer);
  changed.push({
    runId: run.id, questionId: 2, questionVersion: 0, modelId: 'alpha',
    text: '旧版本答案', status: 'succeeded', attempt: 1
  });
  const humanV2 = { ...humanV1, revision: 2, answerKey: 'human:1:2:2', text: '人工第二稿' };
  const report = Core.summarizeReport(run, changed, [humanV1, humanV2], originalReviews, [rate(comparison, 'left')]);
  const firstMetric = report.models.find((model) => model.modelId === firstModel.modelId);
  assert.equal(firstMetric.intent.passed, 0);
  assert.equal(firstMetric.intent.unreviewed, 2);
  assert.deepEqual(firstMetric.agreement.rate, { numerator: 0, denominator: 0, value: null });
  assert.equal(report.overall.comparisonsRated, 0);
  assert.equal(report.overall.excluded.staleReviews, 2);
  assert.equal(report.overall.excluded.staleRatings, 1);
  assert.equal(report.overall.succeededCalls, 6);
});

test('three models produce three fixed comparisons per question with stable sides and answer keys', () => {
  const run = fixtureRun();
  const answers = importedAnswers(run);
  const comparisons = Core.buildComparisons(run, answers);
  assert.equal(comparisons.length, 6);
  for (const question of run.questions) {
    const rows = comparisons.filter((comparison) => comparison.questionId === question.id);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => [row.left.modelId, row.right.modelId].sort().join(':'))).size, 3);
    for (const row of rows) {
      assert.equal(row.kind, 'model-model');
      assert.equal(row.leftAnswerKey, row.left.answerKey);
      assert.equal(row.rightAnswerKey, row.right.answerKey);
      assert.match(row.leftAnswerKey, new RegExp(`^${question.id}:${question.version}:`));
    }
  }
  assert.deepEqual(Core.buildComparisons(run, answers.slice().reverse()), comparisons);
  const firstKey = comparisons[0].leftAnswerKey;
  const changed = answers.map((answer) => answer.answerKey === firstKey ? { ...answer, text: '新版文本', attempt: 2 } : answer);
  const afterRetry = Core.buildComparisons(run, changed);
  assert.notEqual(afterRetry[0].leftAnswerKey, firstKey);
});

test('a newer successful attempt becomes the canonical answer and changes its key', () => {
  const run = fixtureRun();
  const answers = importedAnswers(run);
  const first = answers.find((answer) => answer.questionId === 1 && answer.modelId === 'alpha');
  const retry = { ...first, attempt: 2, text: '第二次成功答案', createdAt: '2026-10-19T02:00:00.000Z' };
  const rows = Core.buildComparisons(run, [...answers, retry]);
  const alphaSides = rows.filter((row) => row.questionId === 1).map((row) =>
    row.left.modelId === 'alpha' ? row.left : row.right.modelId === 'alpha' ? row.right : null).filter(Boolean);
  assert.equal(alphaSides.length, 2);
  assert(alphaSides.every((side) => side.attempt === 2 && side.text === retry.text));
  assert(alphaSides.every((side) => side.answerKey === Core.answerKey(retry)));
  assert.notEqual(Core.answerKey(first), Core.answerKey(retry));
  assert.equal(Core.humanKey({ questionId: 1, questionVersion: 2, revision: 3 }), 'human:1:2:3');
});

test('report separates call, intent, GSB, agreement, and stale records', () => {
  const run = fixtureRun();
  const all = importedAnswers(run);
  const answers = all.filter((answer) => !(answer.questionId === 2 && answer.modelId === 'gamma'));
  answers.push({
    runId: run.id, questionId: 2, questionVersion: 1, modelId: 'gamma',
    status: 'failed', attempt: 1, error: 'timeout'
  });
  const comparisons = Core.buildComparisons(run, answers);
  const q1 = run.questions[0], q2 = run.questions[1];
  const humanAnswers = [
    { runId: run.id, questionId: 1, questionVersion: 2, revision: 1, answerKey: 'human:1:2:1', text: '人工封面图' },
    { runId: run.id, questionId: 2, questionVersion: 1, revision: 1, answerKey: 'human:2:1:1', text: '人工回答失败' }
  ];
  const key = (questionId, modelId) => answers.find((answer) => answer.questionId === questionId && answer.modelId === modelId).answerKey;
  const reviews = [
    review(run, q1, 'human', 'human:1:2:1', 'pass'),
    review(run, q2, 'human', 'human:2:1:1', 'fail'),
    review(run, q1, 'alpha', key(1, 'alpha'), 'pass'),
    review(run, q2, 'alpha', key(2, 'alpha'), 'fail'),
    review(run, q1, 'beta', key(1, 'beta'), 'fail'),
    review(run, q2, 'beta', key(2, 'beta'), 'pass'),
    review(run, q1, 'gamma', key(1, 'gamma'), 'partial'),
    review(run, q1, 'gamma', key(1, 'gamma'), 'pass', { questionVersion: 1 })
  ];
  const pair = (qid, a, b) => comparisons.find((comparison) => comparison.questionId === qid &&
    [comparison.left.modelId, comparison.right.modelId].sort().join(':') === [a, b].sort().join(':'));
  const bothBad = pair(1, 'alpha', 'beta');
  const bothGood = pair(1, 'beta', 'gamma');
  const ratings = [
    rate(bothBad, 'both_bad'), rate(bothGood, 'both_good'),
    rate(pair(2, 'alpha', 'beta'), 'left'),
    rate(bothBad, 'left', { leftAnswerKey: 'stale-answer-key' }),
    rate(bothBad, 'right', { questionVersion: 1 })
  ];
  const report = Core.summarizeReport(run, answers, humanAnswers, reviews, ratings);
  const alpha = report.models.find((model) => model.modelId === 'alpha');
  const beta = report.models.find((model) => model.modelId === 'beta');
  const gamma = report.models.find((model) => model.modelId === 'gamma');
  assert.deepEqual(alpha.calls.rate, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(gamma.calls.rate, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(gamma.calls.failed, 1);
  assert.deepEqual(alpha.intent.passRate, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(gamma.intent.partial, 1);
  assert.equal(gamma.intent.passed, 0);
  assert.deepEqual(alpha.agreement.rate, { numerator: 2, denominator: 2, value: 1 });
  assert.equal(alpha.agreement.bothPassed, 1);
  assert.equal(alpha.agreement.bothFailed, 1);
  assert.equal(beta.agreement.onlyHumanPassed, 1);
  assert.equal(beta.agreement.onlyModelPassed, 1);
  assert.equal(beta.agreement.matched, 0);
  assert.equal(alpha.gsb.both_bad, 1);
  assert.equal(beta.gsb.both_bad, 1);
  assert.equal(beta.gsb.both_good, 1);
  assert.equal(gamma.gsb.both_good, 1);
  assert.equal(report.overall.comparisonsRated, 3);
  assert.equal(report.overall.excluded.staleReviews, 1);
  assert.equal(report.overall.excluded.staleRatings, 2);
});

test('unreviewed and unassessable answers stay out of quality denominators', () => {
  const run = fixtureRun();
  const answers = importedAnswers(run);
  const humanAnswers = [{ runId: run.id, questionId: 1, questionVersion: 2, revision: 1, text: '人工答案' }];
  const gamma = answers.find((answer) => answer.questionId === 1 && answer.modelId === 'gamma');
  const reviews = [review(run, run.questions[0], 'gamma', gamma.answerKey, 'unassessable')];
  const report = Core.summarizeReport(run, answers, humanAnswers, reviews, []);
  const metric = report.models.find((model) => model.modelId === 'gamma');
  assert.equal(metric.intent.unassessable, 1);
  assert.equal(metric.intent.unreviewed, 1);
  assert.deepEqual(metric.intent.passRate, { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(metric.agreement.rate, { numerator: 0, denominator: 0, value: null });
});

test('latest valid review and GSB rating win even when files load out of order', () => {
  const run = fixtureRun();
  const answers = importedAnswers(run);
  const comparison = Core.buildComparisons(run, answers)[0];
  const subject = answers.find((answer) => answer.questionId === comparison.questionId &&
    answer.modelId === comparison.left.modelId);
  const question = run.questions.find((item) => item.id === comparison.questionId);
  const newerReview = review(run, question, subject.modelId, subject.answerKey, 'fail',
    { createdAt: '2026-10-19T03:00:00.000Z' });
  const olderReview = review(run, question, subject.modelId, subject.answerKey, 'pass',
    { createdAt: '2026-10-19T01:00:00.000Z' });
  const newerRating = rate(comparison, 'both_bad', { createdAt: '2026-10-19T03:00:00.000Z' });
  const olderRating = rate(comparison, 'both_good', { createdAt: '2026-10-19T01:00:00.000Z' });
  const report = Core.summarizeReport(run, answers, [], [newerReview, olderReview], [newerRating, olderRating]);
  const metric = report.models.find((model) => model.modelId === subject.modelId);
  assert.equal(metric.intent.failed, 1);
  assert.equal(metric.intent.passed, 0);
  assert.equal(report.comparisons.find((item) => item.id === comparison.id).rating.choice, 'both_bad');
  assert.equal(report.overall.comparisonsRated, 1);
  assert.equal(report.overall.excluded.staleReviews, 0);
  assert.equal(report.overall.excluded.staleRatings, 0);
});

test('API failures keep unconfigured, timeout, other failure, and missing separate', () => {
  const run = fixtureRun();
  const failure = (questionId, modelId, errorCode) => ({
    runId: run.id, questionId,
    questionVersion: run.questions.find((item) => item.id === questionId).version,
    modelId, status: 'failed', errorCode, text: '', source: 'api', attempt: 1
  });
  const report = Core.summarizeReport(run, [
    failure(1, 'alpha', 'unconfigured'),
    failure(1, 'beta', 'timeout'),
    failure(1, 'gamma', 'http_429')
  ], [], [], []);
  assert.equal(report.overall.unconfiguredCalls, 1);
  assert.equal(report.overall.timedOutCalls, 1);
  assert.equal(report.overall.failedCalls, 1);
  assert.equal(report.overall.missingCalls, 3);
  assert.deepEqual(report.questions[0].models.map((item) => item.callStatus), ['unconfigured', 'timeout', 'failed']);
});
