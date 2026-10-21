(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkflowCore = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const RUN_FORMAT = 'morgan-intent-run-v1';
  const REPORT_FORMAT = 'morgan-intent-report-v1';
  const VERDICTS = new Map([
    ['pass', 'pass'], ['通过', 'pass'],
    ['partial', 'partial'], ['部分通过', 'partial'],
    ['fail', 'fail'], ['未通过', 'fail'],
    ['unassessable', 'unassessable'], ['不可评', 'unassessable']
  ]);
  const CHOICES = new Set(['left', 'right', 'both_good', 'both_bad']);

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isoTime(value) {
    const date = value === undefined ? new Date() : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('时间格式无效。');
    return date.toISOString();
  }

  function keyFor(questionId, questionVersion, modelId) {
    return String(questionId) + ':' + String(questionVersion) + ':' + String(modelId);
  }

  // A content suffix also invalidates a review if a provider rewrites an attempt.
  function textHash(value) {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < value.length; i++) {
      hash ^= BigInt(value.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  function answerKey(answer) {
    return keyFor(answer.questionId, answer.questionVersion, answer.modelId) +
      ':' + String(answer.attempt || 1) + ':' + textHash(answer.text);
  }

  function humanKey(answer) {
    return 'human:' + String(answer.questionId) + ':' + String(answer.questionVersion) +
      ':' + String(answer.revision || 1);
  }

  function validUsage(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      Object.entries(value).every(([name, count]) =>
        /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && /token/i.test(name) &&
        Number.isSafeInteger(count) && count >= 0);
  }

  function createRun(questions, models, id, now) {
    if (!Array.isArray(questions) || !Array.isArray(models)) {
      throw new TypeError('题目和模型都必须是数组。');
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
      throw new TypeError('运行 ID 必须是安全的非空标识。');
    }
    const selected = questions.filter((question) => question && question.approved === true);
    if (!selected.length) throw new TypeError('至少需要一道已确认题目。');
    if (models.length < 1) throw new TypeError('至少需要一个模型。');
    const seenQuestions = new Set();
    const snapshots = selected.map((question) => {
      if (!Number.isInteger(question.id) || !Number.isInteger(question.version) || question.version < 1 ||
          !Array.isArray(question.turns) || !question.turns.length) {
        throw new TypeError('已确认题目的 ID、版本或对话轮次无效。');
      }
      if (seenQuestions.has(question.id)) throw new TypeError('已确认题目 ID 重复。');
      seenQuestions.add(question.id);
      const snapshot = {
        id: question.id,
        version: question.version,
        title: String(question.title || ''),
        dimension: String(question.dimension || ''),
        turns: copy(question.turns),
        reference: String(question.reference || '')
      };
      for (const field of ['source', 'retained', 'superseded', 'missing', 'intentCardVersion', 'isDemo',
        'testPoint', 'subPoint', 'successCriteria', 'failureSignals']) {
        if (question[field] !== undefined) snapshot[field] = copy(question[field]);
      }
      return snapshot;
    });
    const seenModels = new Set();
    const modelSnapshots = models.map((model) => {
      const entry = typeof model === 'string' ? { id: model, label: model } : model;
      if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new TypeError('模型 ID 无效。');
      if (seenModels.has(entry.id)) throw new TypeError('模型 ID 重复。');
      seenModels.add(entry.id);
      return { id: entry.id, label: String(entry.label || entry.id) };
    });
    return {
      format: RUN_FORMAT,
      id,
      createdAt: isoTime(now),
      questions: snapshots,
      models: modelSnapshots,
      status: 'draft'
    };
  }

  function validateImportedAnswers(run, payload) {
    const errors = [];
    const rows = Array.isArray(payload) ? payload : payload && payload.answers;
    if (!Array.isArray(rows)) return { answers: [], errors: ['导入文件必须包含 answers 数组。'] };
    const payloadRunId = Array.isArray(payload) ? undefined : payload.runId;
    if (payloadRunId !== undefined && payloadRunId !== run.id) {
      errors.push('导入文件的运行 ID 与当前运行不一致。');
    }
    const questions = new Map(run.questions.map((question) => [String(question.id), question]));
    const models = new Set(run.models.map((model) => model.id));
    const seen = new Set();
    const present = new Set();
    const answers = [];
    const importedAt = isoTime();
    rows.forEach((row, index) => {
      const prefix = '第 ' + (index + 1) + ' 条答案：';
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(prefix + '记录格式无效。');
        return;
      }
      let valid = true;
      const rowRunId = row.runId === undefined ? payloadRunId : row.runId;
      if (rowRunId !== run.id) { errors.push(prefix + '运行 ID 不匹配。'); valid = false; }
      const question = questions.get(String(row.questionId));
      if (!question) { errors.push(prefix + '未知题目 ID。'); valid = false; }
      else if (row.questionVersion !== question.version) {
        errors.push(prefix + '题目版本不匹配。'); valid = false;
      }
      if (!models.has(row.modelId)) { errors.push(prefix + '未知模型 ID。'); valid = false; }
      if (rowRunId === run.id && question && row.questionVersion === question.version && models.has(row.modelId)) {
        present.add(keyFor(question.id, question.version, row.modelId));
      }
      if (typeof row.text !== 'string' || !row.text.trim()) {
        errors.push(prefix + '回答文本为空。'); valid = false;
      }
      if (row.status !== undefined && row.status !== 'succeeded') {
        errors.push(prefix + '只有成功的回答可以导入。'); valid = false;
      }
      if (row.providerModel !== undefined &&
          (typeof row.providerModel !== 'string' || !row.providerModel.trim() ||
           row.providerModel.trim().length > 200 || /[\r\n]/.test(row.providerModel))) {
        errors.push(prefix + 'providerModel 必须是单行非空模型标识。'); valid = false;
      }
      if (row.latencyMs !== undefined &&
          (typeof row.latencyMs !== 'number' || !Number.isFinite(row.latencyMs) || row.latencyMs < 0)) {
        errors.push(prefix + 'latencyMs 必须是非负数字。'); valid = false;
      }
      if (row.usage !== undefined && !validUsage(row.usage)) {
        errors.push(prefix + 'usage 只能包含非负整数 token 计数。'); valid = false;
      }
      const attempt = row.attempt === undefined ? 1 : row.attempt;
      if (!Number.isInteger(attempt) || attempt < 1) {
        errors.push(prefix + 'attempt 必须是正整数。'); valid = false;
      }
      let createdAt = importedAt;
      const suppliedTime = row.createdAt === undefined ? payload && payload.createdAt : row.createdAt;
      if (suppliedTime !== undefined) {
        try { createdAt = isoTime(suppliedTime); }
        catch (_) { errors.push(prefix + '创建时间无效。'); valid = false; }
      }
      if (!valid) return;
      const baseKey = keyFor(question.id, question.version, row.modelId);
      if (seen.has(baseKey)) {
        errors.push(prefix + '重复的题目、版本和模型组合。');
        return;
      }
      seen.add(baseKey);
      const normalized = {
        runId: run.id,
        questionId: question.id,
        questionVersion: question.version,
        modelId: row.modelId,
        text: row.text,
        source: 'agent-import',
        attempt,
        createdAt,
        status: 'succeeded'
      };
      if (row.providerModel !== undefined) normalized.providerModel = row.providerModel.trim();
      if (row.latencyMs !== undefined) normalized.latencyMs = row.latencyMs;
      if (row.usage !== undefined) normalized.usage = copy(row.usage);
      normalized.answerKey = answerKey(normalized);
      answers.push(normalized);
    });
    for (const question of run.questions) {
      for (const model of run.models) {
        const key = keyFor(question.id, question.version, model.id);
        if (!present.has(key)) errors.push('缺少题目 ' + question.id + ' v' + question.version + '、模型 ' + model.id + ' 的答案。');
      }
    }
    return { answers: errors.length ? [] : answers, errors };
  }

  function failureStatus(answer) {
    const code = String(answer.errorCode || answer.error?.code || '').toLowerCase();
    if (answer.status === 'unconfigured' || code === 'unconfigured') return 'unconfigured';
    if (answer.status === 'timeout' || code === 'timeout') return 'timeout';
    return 'failed';
  }

  function selectedAnswers(run, answers) {
    const questions = new Map(run.questions.map((question) => [String(question.id), question]));
    const models = new Set(run.models.map((model) => model.id));
    const candidates = new Map();
    const failures = new Map();
    (Array.isArray(answers) ? answers : []).forEach((answer, index) => {
      if (!answer || answer.runId !== run.id) return;
      const question = questions.get(String(answer.questionId));
      if (!question || answer.questionVersion !== question.version || !models.has(answer.modelId)) return;
      const baseKey = keyFor(question.id, question.version, answer.modelId);
      if (answer.status && answer.status !== 'succeeded') {
        const attempt = Number.isInteger(answer.attempt) && answer.attempt > 0 ? answer.attempt : 1;
        const previous = failures.get(baseKey);
        const currentTime = String(answer.createdAt || '');
        const previousTime = String(previous?.answer.createdAt || '');
        if (!previous || attempt > previous.attempt ||
            (attempt === previous.attempt && currentTime >= previousTime)) {
          failures.set(baseKey, { callStatus: failureStatus(answer), answer, attempt });
        }
        return;
      }
      if (typeof answer.text !== 'string' || !answer.text.trim()) return;
      const attempt = Number.isInteger(answer.attempt) && answer.attempt > 0 ? answer.attempt : 1;
      const item = {
        ...answer,
        questionId: question.id,
        questionVersion: question.version,
        attempt,
        answerKey: answerKey({ ...answer, questionId: question.id, questionVersion: question.version, attempt }),
        inputIndex: index
      };
      if (!candidates.has(baseKey)) candidates.set(baseKey, []);
      candidates.get(baseKey).push(item);
    });
    const selected = new Map();
    for (const [key, list] of candidates) {
      list.sort((a, b) => b.attempt - a.attempt ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.inputIndex - a.inputIndex);
      const { inputIndex, ...answer } = list[0];
      selected.set(key, answer);
    }
    return { selected, failures };
  }

  function orientationHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function buildComparisons(run, answers) {
    const { selected } = selectedAnswers(run, answers);
    const models = run.models.slice().sort((a, b) => a.id.localeCompare(b.id));
    const comparisons = [];
    for (const question of run.questions) {
      for (let i = 0; i < models.length; i++) {
        for (let j = i + 1; j < models.length; j++) {
          const first = models[i], second = models[j];
          const firstAnswer = selected.get(keyFor(question.id, question.version, first.id));
          const secondAnswer = selected.get(keyFor(question.id, question.version, second.id));
          if (!firstAnswer || !secondAnswer) continue;
          const id = 'mm:' + run.id + ':' + question.id + ':' + question.version + ':' +
            encodeURIComponent(first.id) + ':' + encodeURIComponent(second.id);
          const flipped = orientationHash(id) % 2 === 1;
          const leftModel = flipped ? second : first;
          const rightModel = flipped ? first : second;
          const leftAnswer = flipped ? secondAnswer : firstAnswer;
          const rightAnswer = flipped ? firstAnswer : secondAnswer;
          const left = {
            modelId: leftModel.id, modelLabel: leftModel.label,
            answerKey: leftAnswer.answerKey, text: leftAnswer.text,
            attempt: leftAnswer.attempt, createdAt: leftAnswer.createdAt || null
          };
          const right = {
            modelId: rightModel.id, modelLabel: rightModel.label,
            answerKey: rightAnswer.answerKey, text: rightAnswer.text,
            attempt: rightAnswer.attempt, createdAt: rightAnswer.createdAt || null
          };
          comparisons.push({
            id, kind: 'model-model', runId: run.id,
            questionId: question.id, questionVersion: question.version,
            dimension: question.dimension,
            left, right,
            leftModelId: left.modelId, rightModelId: right.modelId,
            leftAnswerKey: left.answerKey, rightAnswerKey: right.answerKey
          });
        }
      }
    }
    return comparisons;
  }

  function rate(numerator, denominator) {
    return { numerator, denominator, value: denominator ? numerator / denominator : null };
  }

  function summarizeCoverage(questions) {
    const rows = Array.isArray(questions) ? questions.filter((question) => question && !question.isDemo) : [];
    const countBy = (value) => value.reduce((counts, label) => {
      const key = String(label || '').trim() || '未标注';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    const approved = rows.filter((question) => question.approved === true);
    return {
      total: rows.length,
      approved: approved.length,
      drafts: rows.length - approved.length,
      rubricReady: approved.filter((question) =>
        Array.isArray(question.successCriteria) && question.successCriteria.some((item) => String(item).trim())).length,
      dimensions: countBy(approved.map((question) => question.dimension)),
      testPoints: countBy(approved.map((question) => question.testPoint)),
      subPoints: countBy(approved.map((question) => question.subPoint))
    };
  }

  function selectLatest(map, key, record, index) {
    const parsed = Date.parse(record.createdAt || record.savedAt || '');
    const timestamp = Number.isFinite(parsed) ? parsed : -Infinity;
    const previous = map.get(key);
    if (!previous || timestamp > previous.timestamp ||
        (timestamp === previous.timestamp && index > previous.index)) {
      map.set(key, { record, timestamp, index });
    }
  }

  function emptyMatrix() {
    return {
      pass: { pass: 0, partial: 0, fail: 0 },
      partial: { pass: 0, partial: 0, fail: 0 },
      fail: { pass: 0, partial: 0, fail: 0 }
    };
  }

  function latestHumanAnswers(run, humanAnswers) {
    const questions = new Map(run.questions.map((question) => [String(question.id), question]));
    const selected = new Map();
    (Array.isArray(humanAnswers) ? humanAnswers : []).forEach((answer, index) => {
      if (!answer || answer.runId !== run.id) return;
      const question = questions.get(String(answer.questionId));
      if (!question || answer.questionVersion !== question.version || typeof answer.text !== 'string' || !answer.text.trim()) return;
      const revision = Number.isInteger(answer.revision) && answer.revision > 0 ? answer.revision : 1;
      const item = {
        ...answer, questionId: question.id, questionVersion: question.version,
        revision, answerKey: answer.answerKey || humanKey({ ...answer, questionId: question.id, questionVersion: question.version, revision }),
        inputIndex: index
      };
      const previous = selected.get(String(question.id));
      if (!previous || revision > previous.revision ||
          (revision === previous.revision && index > previous.inputIndex)) selected.set(String(question.id), item);
    });
    return selected;
  }

  function summarizeReport(run, answers, humanAnswers, intentReviews, gsbRatings) {
    const answerState = selectedAnswers(run, answers);
    const selected = answerState.selected;
    const humans = latestHumanAnswers(run, humanAnswers);
    const comparisons = buildComparisons(run, answers);
    const comparisonMap = new Map(comparisons.map((comparison) => [comparison.id, comparison]));
    const questionMap = new Map(run.questions.map((question) => [String(question.id), question]));
    const modelMap = new Map(run.models.map((model) => [model.id, model]));
    const excluded = { staleReviews: 0, staleRatings: 0, invalidRatings: 0 };
    const reviewSelections = new Map();

    (Array.isArray(intentReviews) ? intentReviews : []).forEach((review, index) => {
      if (!review || (review.source && review.source !== 'human') || review.runId !== run.id) return;
      const question = questionMap.get(String(review.questionId));
      const subjectId = review.subjectId;
      const subjectValid = subjectId === 'human' || modelMap.has(subjectId);
      if (!question || !subjectValid) { excluded.staleReviews++; return; }
      const currentAnswer = subjectId === 'human'
        ? humans.get(String(question.id))
        : selected.get(keyFor(question.id, question.version, subjectId));
      if (!currentAnswer ||
          (review.questionVersion !== undefined && review.questionVersion !== question.version) ||
          review.answerKey !== currentAnswer.answerKey) {
        excluded.staleReviews++;
        return;
      }
      const verdict = VERDICTS.get(review.label);
      if (!verdict) return;
      selectLatest(reviewSelections, String(question.id) + ':' + subjectId, { ...review, label: verdict }, index);
    });
    const reviewMap = new Map([...reviewSelections].map(([key, value]) => [key, value.record]));

    const ratingSelections = new Map();
    const aiRatingSelections = new Map();
    (Array.isArray(gsbRatings) ? gsbRatings : []).forEach((rating, index) => {
      if (!rating || rating.runId !== run.id) return;
      const isAI = rating.source === 'ai';
      if (rating.source && !isAI && rating.source !== 'human') return;
      const comparison = comparisonMap.get(rating.comparisonId);
      if (!comparison || rating.questionId !== comparison.questionId ||
          (rating.questionVersion !== undefined && rating.questionVersion !== comparison.questionVersion) ||
          rating.leftAnswerKey !== comparison.leftAnswerKey ||
          rating.rightAnswerKey !== comparison.rightAnswerKey) {
        if (!isAI) excluded.staleRatings++;
        return;
      }
      if (!CHOICES.has(rating.choice)) {
        if (!isAI) excluded.invalidRatings++;
        return;
      }
      selectLatest(isAI ? aiRatingSelections : ratingSelections, comparison.id, rating, index);
    });
    const ratingMap = new Map([...ratingSelections].map(([key, value]) => [key, value.record]));
    const aiRatingMap = new Map([...aiRatingSelections].map(([key, value]) => [key, value.record]));

    const modelMetrics = run.models.map((model) => ({
      modelId: model.id,
      label: model.label,
      calls: { expected: run.questions.length, succeeded: 0, failed: 0, unconfigured: 0, timedOut: 0, missing: 0, rate: null },
      intent: {
        passed: 0, partial: 0, failed: 0, unassessable: 0, unreviewed: 0,
        passRate: null, partialRate: null
      },
      gsb: {
        wins: 0, losses: 0, both_good: 0, both_bad: 0,
        points: 0, denominator: 0, score: null
      },
      agreement: {
        matched: 0, denominator: 0, bothPassed: 0, onlyHumanPassed: 0,
        onlyModelPassed: 0, bothFailed: 0, bothPartial: 0,
        matrix: emptyMatrix(), rate: null
      }
    }));
    const metricMap = new Map(modelMetrics.map((metric) => [metric.modelId, metric]));
    const questionResults = run.questions.map((question) => {
      const humanAnswer = humans.get(String(question.id));
      const humanReview = reviewMap.get(String(question.id) + ':human');
      return {
        questionId: question.id, questionVersion: question.version,
        title: question.title, dimension: question.dimension,
        testPoint: question.testPoint || '', subPoint: question.subPoint || '',
        human: humanAnswer ? {
          answerKey: humanAnswer.answerKey, revision: humanAnswer.revision,
          text: humanAnswer.text, review: humanReview || null
        } : null,
        models: run.models.map((model) => {
          const key = keyFor(question.id, question.version, model.id);
          const answer = selected.get(key);
          const failedAnswer = answerState.failures.get(key);
          const review = reviewMap.get(String(question.id) + ':' + model.id);
          const metric = metricMap.get(model.id);
          if (answer) {
            metric.calls.succeeded++;
            if (!review) metric.intent.unreviewed++;
            else if (review.label === 'pass') metric.intent.passed++;
            else if (review.label === 'partial') metric.intent.partial++;
            else if (review.label === 'fail') metric.intent.failed++;
            else metric.intent.unassessable++;
            if (humanReview && review && humanReview.label !== 'unassessable' && review.label !== 'unassessable') {
              const agreement = metric.agreement;
              agreement.denominator++;
              if (humanReview.label === review.label) agreement.matched++;
              agreement.matrix[humanReview.label][review.label]++;
              if (humanReview.label === 'pass' && review.label === 'pass') agreement.bothPassed++;
              else if (humanReview.label === 'pass') agreement.onlyHumanPassed++;
              else if (review.label === 'pass') agreement.onlyModelPassed++;
              else if (humanReview.label === 'fail' && review.label === 'fail') agreement.bothFailed++;
              else if (humanReview.label === 'partial' && review.label === 'partial') agreement.bothPartial++;
            }
          } else if (failedAnswer?.callStatus === 'unconfigured') metric.calls.unconfigured++;
          else if (failedAnswer?.callStatus === 'timeout') metric.calls.timedOut++;
          else if (failedAnswer) metric.calls.failed++;
          else metric.calls.missing++;
          const sourceAnswer = answer || failedAnswer?.answer;
          return {
            modelId: model.id,
            callStatus: answer ? 'succeeded' : failedAnswer?.callStatus || 'missing',
            answerKey: answer ? answer.answerKey : null,
            text: answer ? answer.text : null,
            errorCode: failedAnswer?.answer.errorCode || null,
            error: failedAnswer?.answer.error || null,
            providerModel: sourceAnswer?.providerModel || null,
            latencyMs: sourceAnswer?.latencyMs ?? sourceAnswer?.durationMs ?? null,
            usage: sourceAnswer?.usage ? copy(sourceAnswer.usage) : null,
            attempt: sourceAnswer?.attempt ?? null,
            source: sourceAnswer?.source || null,
            createdAt: sourceAnswer?.createdAt || null,
            review: review || null
          };
        })
      };
    });

    const reportedComparisons = comparisons.map((comparison) => {
      const rating = ratingMap.get(comparison.id) || null;
      const aiRating = aiRatingMap.get(comparison.id) || null;
      if (rating) {
        const left = metricMap.get(comparison.left.modelId).gsb;
        const right = metricMap.get(comparison.right.modelId).gsb;
        left.denominator++;
        right.denominator++;
        if (rating.choice === 'left') {
          left.wins++; left.points++;
          right.losses++;
        } else if (rating.choice === 'right') {
          right.wins++; right.points++;
          left.losses++;
        } else {
          left[rating.choice]++; right[rating.choice]++;
          left.points += 0.5; right.points += 0.5;
        }
      }
      return { ...comparison, rating, aiRating };
    });

    for (const metric of modelMetrics) {
      metric.calls.rate = rate(metric.calls.succeeded, metric.calls.expected);
      const quality = metric.intent.passed + metric.intent.partial + metric.intent.failed;
      metric.intent.passRate = rate(metric.intent.passed, quality);
      metric.intent.partialRate = rate(metric.intent.partial, quality);
      metric.gsb.score = rate(metric.gsb.points, metric.gsb.denominator);
      metric.agreement.rate = rate(metric.agreement.matched, metric.agreement.denominator);
    }
    const expectedCalls = run.questions.length * run.models.length;
    const succeededCalls = modelMetrics.reduce((sum, metric) => sum + metric.calls.succeeded, 0);
    const failedCalls = modelMetrics.reduce((sum, metric) => sum + metric.calls.failed, 0);
    const unconfiguredCalls = modelMetrics.reduce((sum, metric) => sum + metric.calls.unconfigured, 0);
    const timedOutCalls = modelMetrics.reduce((sum, metric) => sum + metric.calls.timedOut, 0);
    const missingCalls = modelMetrics.reduce((sum, metric) => sum + metric.calls.missing, 0);
    const comparisonsRated = reportedComparisons.filter((comparison) => comparison.rating).length;
    const aiPairs = reportedComparisons.filter((comparison) => comparison.rating && comparison.aiRating);
    const overall = {
      questionCount: run.questions.length,
      modelCount: run.models.length,
      expectedCalls, succeededCalls, failedCalls, unconfiguredCalls, timedOutCalls, missingCalls,
      callSuccessRate: rate(succeededCalls, expectedCalls),
      comparisonsExpected: run.questions.length * run.models.length * (run.models.length - 1) / 2,
      comparisonsReady: comparisons.length,
      comparisonsRated,
      aiGsbAgreement: rate(aiPairs.filter((comparison) => comparison.rating.choice === comparison.aiRating.choice).length, aiPairs.length),
      excluded
    };
    return {
      format: REPORT_FORMAT,
      runId: run.id,
      runCreatedAt: run.createdAt,
      models: modelMetrics,
      questions: questionResults,
      comparisons: reportedComparisons,
      overall,
      coverage: summarizeCoverage(run.questions.map((question) => ({ ...question, approved: true })))
    };
  }

  return { createRun, validateImportedAnswers, buildComparisons, summarizeReport, summarizeCoverage, answerKey, humanKey };
});
