(function () {
  'use strict';

  const ROOT = 'intent-benchmark';
  const MODELS = [
    { id: 'deepseek', label: 'DeepSeek Flash' },
    { id: 'glm', label: 'GLM-5.3-Flash' },
    { id: 'step', label: '阶跃星辰 · Step 5 Preview' }
  ];
  const VERDICTS = { pass: '通过', partial: '部分通过', fail: '未通过', unassessable: '不可评' };
  const GSB = { left: '左边好', right: '右边好', both_good: '一样好', both_bad: '一样差' };
  const VIEWS = ['bank', 'runs', 'human', 'audit', 'report'];
  const $ = (id) => document.getElementById(id);
  const app = {
    bank: { format: 'morgan-intent-bench-v1', nextId: 1, questions: [] }, bankSha: null,
    importDrafts: [], importWarnings: [], runs: [], run: null,
    answers: [], humanAnswers: [], reviews: [], ratings: [], fileShas: new Map(),
    questionId: null, humanQuestionId: null, auditQuestionId: null, editingHuman: false,
    view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'bank', busy: false
  };

  function node(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value == null ? '' : String(value);
    return item;
  }
  function add(parent, tag, className, value) { const item = node(tag, className, value); parent.appendChild(item); return item; }
  function errorText(error) { return error instanceof Error ? error.message : String(error); }
  function message(value, isError = false) {
    const box = $('app-message'); box.textContent = value; box.hidden = false;
    box.classList.toggle('error', isError);
  }
  async function busy(action) {
    if (app.busy) return;
    app.busy = true;
    try { await action(); } catch (error) { message(errorText(error), true); } finally { app.busy = false; }
  }
  function setView(view) {
    if (!VIEWS.includes(view)) return;
    app.view = view;
    history.replaceState(null, '', '#' + view);
    VIEWS.forEach((name) => { $(name).hidden = name !== view; });
    document.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'));
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function code(question) { return 'M' + String(question.id).padStart(3, '0'); }
  function runPath(path) { if (!app.run) throw new Error('请先选择运行。'); return ROOT + '/runs/' + app.run.id + '/' + path; }
  function currentQuestion() { return app.bank.questions.find((q) => q.id === app.questionId) || null; }
  function runQuestion(id) { return app.run?.questions.find((q) => String(q.id) === String(id)) || null; }
  function modelLabel(id) { return app.run?.models.find((m) => m.id === id)?.label || MODELS.find((m) => m.id === id)?.label || id; }
  function lines(value) { return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
  function latestHuman(questionId) {
    return app.humanAnswers.filter((answer) => String(answer.questionId) === String(questionId)).sort((a, b) => b.revision - a.revision)[0] || null;
  }
  function modelAnswer(questionId, modelId) {
    return app.answers.find((answer) => String(answer.questionId) === String(questionId) && answer.modelId === modelId && answer.status === 'succeeded' && answer.text) || null;
  }
  function modelAnswers(questionId) { return app.run?.models.map((model) => modelAnswer(questionId, model.id)).filter(Boolean) || []; }
  function answerKey(answer) { return answer?.modelId ? WorkflowCore.answerKey(answer) : WorkflowCore.humanKey(answer); }
  function questionText(question) { return question.turns.map((turn, index) => (index + 1) + ' / ' + turn).join('\n\n'); }
  function download(filename, content, type = 'application/json;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  async function mapLimit(items, limit, handler) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index], index);
      }
    }));
    return results;
  }
  async function readDirectory(path) {
    const files = await WorkflowStore.list(path);
    const results = await mapLimit(files.filter((file) => file.type === 'file' && file.name.endsWith('.json')), 5, (file) => WorkflowStore.readJson(path + '/' + file.name).then((result) => {
      if (result) app.fileShas.set(path + '/' + file.name, result.sha);
      return result?.data || null;
    }));
    return results.filter(Boolean);
  }
  async function write(path, data) {
    const sha = app.fileShas.get(path) || null;
    const nextSha = await WorkflowStore.writeJson(path, data, sha);
    app.fileShas.set(path, nextSha);
    return nextSha;
  }
  async function saveBank(previous) {
    try {
      app.bankSha = await WorkflowStore.writeJson(ROOT + '/state.json', app.bank, app.bankSha);
      message('题库已保存到私有 GitHub 仓库。');
      render();
      return true;
    } catch (error) {
      app.bank = previous;
      render();
      message('题库未保存：' + errorText(error), true);
      return false;
    }
  }
  async function loadRuns() {
    const entries = await WorkflowStore.list(ROOT + '/runs');
    const fetched = await mapLimit(entries.filter((entry) => entry.type === 'dir'), 5, async (entry) => {
      const file = await WorkflowStore.readJson(ROOT + '/runs/' + entry.name + '/request.json');
      return file?.data || null;
    });
    app.runs = fetched.filter((run) => run?.format === 'morgan-intent-run-v1').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function loadRun(id) {
    const run = app.runs.find((item) => item.id === id);
    if (!run) throw new Error('找不到这次运行。');
    app.run = run; app.answers = []; app.humanAnswers = []; app.reviews = []; app.ratings = []; app.fileShas.clear();
    const base = ROOT + '/runs/' + id;
    const [answers, reviews, ratings] = await Promise.all([
      readDirectory(base + '/answers'), readDirectory(base + '/reviews'), readDirectory(base + '/ratings')
    ]);
    app.answers = answers; app.reviews = reviews; app.ratings = ratings;
    const humanGroups = await mapLimit(run.questions, 5, (question) => readDirectory(base + '/human/' + question.id));
    app.humanAnswers = humanGroups.flat();
    app.humanQuestionId = run.questions.find((q) => modelAnswers(q.id).length)?.id || run.questions[0]?.id || null;
    app.auditQuestionId = run.questions.find((q) => latestHuman(q.id) && modelAnswers(q.id).length)?.id || run.questions[0]?.id || null;
    app.editingHuman = false;
    render();
  }

  function blankPair() { return { id: 1, answerRevision: 0, answers: { left: { name: '', text: '' }, right: { name: '', text: '' } }, gsb: null }; }
  function makeQuestion(draft, id) {
    return { id, title: draft.title || '未命名题目', dimension: draft.dimension || '意图识别', turns: draft.turns || [],
      reference: draft.reference || '', retained: draft.retained || [], superseded: draft.superseded || [], missing: draft.missing || '',
      testPoint: draft.testPoint || '', subPoint: draft.subPoint || '',
      successCriteria: draft.successCriteria || [], failureSignals: draft.failureSignals || [],
      source: draft.source || null, approved: false, version: 1, comparisons: [blankPair()] };
  }
  function renderCoverage(target, coverage) {
    target.replaceChildren();
    const summary = add(target, 'div', 'coverage-summary');
    [['正式题目', coverage.approved], ['待审核草稿', coverage.drafts],
      ['有通过条件', coverage.rubricReady + ' / ' + coverage.approved],
      ['未写通过条件', coverage.approved - coverage.rubricReady]].forEach(([label, value]) => {
      const item = add(summary, 'article'); add(item, 'strong', '', value); add(item, 'span', '', label);
    });
    const groups = add(target, 'div', 'coverage-groups');
    [['一级考点', coverage.testPoints], ['二级考点', coverage.subPoints],
      ['能力维度', coverage.dimensions]].forEach(([label, counts]) => {
      const group = add(groups, 'div'); add(group, 'h3', '', label);
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
      if (!entries.length) add(group, 'p', 'small-note', '暂无已确认题目');
      entries.forEach(([name, count]) => {
        const row = add(group, 'div', 'coverage-row'); add(row, 'span', '', name); add(row, 'strong', '', count + ' 题');
        const bar = add(row, 'progress'); bar.max = coverage.approved; bar.value = count;
      });
    });
  }
  function renderImport() {
    const preview = $('import-preview'); preview.replaceChildren();
    $('save-import').hidden = app.importDrafts.length === 0;
    $('import-status').textContent = app.importDrafts.length ? '已识别 ' + app.importDrafts.length + ' 道候选题。保存后仍需逐题确认。' : '';
    const warnings = $('import-warnings'); warnings.replaceChildren();
    app.importWarnings.forEach((warning) => add(warnings, 'p', '', warning));
    app.importDrafts.forEach((draft, index) => {
      const card = add(preview, 'article', 'import-card');
      add(card, 'strong', '', String(index + 1).padStart(2, '0') + ' · ' + draft.title);
      add(card, 'p', '', draft.turns.slice(0, 2).join('\n').slice(0, 250) || '未识别到轮次，请保存后人工补齐。');
    });
  }
  function renderBank() {
    const list = $('bank-list'); list.replaceChildren();
    renderCoverage($('bank-coverage'), WorkflowCore.summarizeCoverage(app.bank.questions));
    $('bank-count').textContent = app.bank.questions.length + ' 题';
    $('approved-count').textContent = app.bank.questions.filter((q) => q.approved && !q.isDemo).length + ' 道可运行';
    app.bank.questions.forEach((question) => {
      const button = add(list, 'button', question.id === app.questionId ? 'active' : ''); button.type = 'button';
      const body = add(button, 'span'); add(body, 'strong', '', code(question) + ' · ' + (question.title || '未命名题目'));
      add(body, 'small', '', question.dimension + ' · ' + question.turns.length + ' 轮 · v' + (question.version || 1));
      add(button, 'span', question.approved ? 'status approved' : 'status', question.approved ? '已确认' : '草稿');
      button.addEventListener('click', () => { app.questionId = question.id; renderBank(); });
    });
    const question = currentQuestion(); $('question-form').hidden = !question;
    if (!question) return;
    $('question-code').textContent = code(question) + ' / V' + (question.version || 1);
    const form = $('question-form');
    form.elements.title.value = question.title || '';
    form.elements.dimension.value = question.dimension || '意图识别';
    form.elements.testPoint.value = question.testPoint || '';
    form.elements.subPoint.value = question.subPoint || '';
    form.elements.turns.value = (question.turns || []).join('\n');
    form.elements.reference.value = question.reference || '';
    form.elements.successCriteria.value = (question.successCriteria || []).join('\n');
    form.elements.failureSignals.value = (question.failureSignals || []).join('\n');
    form.elements.retained.value = (question.retained || []).join('\n');
    form.elements.superseded.value = (question.superseded || []).join('\n');
    form.elements.missing.value = question.missing || '';
    form.elements.approved.checked = Boolean(question.approved);
  }
  function renderRuns() {
    const qlist = $('run-question-list'); qlist.replaceChildren();
    const eligible = app.bank.questions.filter((q) => q.approved && !q.isDemo && q.reference?.trim());
    if (!eligible.length) add(qlist, 'p', 'small-note', '暂无已确认且有最终意图的正式题目。');
    eligible.forEach((question) => {
      const label = add(qlist, 'label'); const check = add(label, 'input'); check.type = 'checkbox'; check.value = String(question.id); check.checked = true;
      add(label, 'span', '', code(question) + ' · ' + question.title);
    });
    const mlist = $('run-model-list'); mlist.replaceChildren();
    MODELS.forEach((model) => {
      const label = add(mlist, 'label'); const check = add(label, 'input'); check.type = 'checkbox'; check.value = model.id; check.checked = true;
      add(label, 'span', '', model.label);
    });
    const runs = $('run-list'); runs.replaceChildren();
    if (!app.runs.length) add(runs, 'p', 'small-note', '暂无运行。');
    app.runs.forEach((run) => {
      const button = add(runs, 'button', app.run?.id === run.id ? 'active' : ''); button.type = 'button';
      const body = add(button, 'span'); add(body, 'strong', '', run.id.slice(0, 13));
      add(body, 'small', '', (run.questions?.length || 0) + ' 题 · ' + (run.models?.length || 0) + ' 模型 · ' + (run.mode === 'api' ? 'API' : 'Agent') + ' · ' + new Date(run.createdAt).toLocaleString('zh-CN'));
      button.addEventListener('click', () => busy(async () => { await loadRun(run.id); message('运行已载入。'); }));
    });
    $('run-detail').hidden = !app.run;
    if (!app.run) return;
    $('run-title').textContent = app.run.id;
    $('run-summary').textContent = app.run.questions.length + ' 题 · ' + app.run.models.map((m) => m.label).join(' / ') + ' · ' + (app.run.mode === 'api' ? 'GitHub Actions API 模式' : 'Agent 平台结果导入模式');
    $('dispatch-run').hidden = app.run.mode !== 'api';
    $('download-agent-request').hidden = app.run.mode !== 'agent';
    $('agent-import-panel').hidden = app.run.mode !== 'agent';
    const box = $('run-answer-status'); box.replaceChildren();
    const runReport = reportData();
    app.run.models.forEach((model) => {
      const metric = runReport.models.find((item) => item.modelId === model.id);
      const card = add(box, 'article'); add(card, 'strong', '', model.label);
      add(card, 'span', '', metric.calls.succeeded + '/' + metric.calls.expected + ' 题已答 · 待配置 ' + metric.calls.unconfigured +
        ' · 超时 ' + metric.calls.timedOut + ' · 其他失败 ' + metric.calls.failed + ' · 未返回 ' + metric.calls.missing);
    });
    $('sidebar-run').textContent = app.run.id.slice(0, 13) + ' · ' + app.run.questions.length + ' 题';
  }
  function renderHuman() {
    const eligible = app.run?.questions.filter((question) => modelAnswers(question.id).length) || [];
    $('human-empty').hidden = eligible.length > 0;
    $('human-workspace').hidden = eligible.length === 0;
    if (!eligible.length) return;
    if (!eligible.some((q) => String(q.id) === String(app.humanQuestionId))) app.humanQuestionId = eligible[0].id;
    const select = $('human-question-select'); select.replaceChildren();
    eligible.forEach((question) => {
      const option = add(select, 'option', '', code(question) + ' · ' + question.title + (latestHuman(question.id) ? ' · 已提交' : ' · 待作答'));
      option.value = String(question.id);
    });
    select.value = String(app.humanQuestionId);
    const question = runQuestion(app.humanQuestionId);
    $('human-question-title').textContent = code(question) + ' · ' + question.title;
    $('human-question-text').textContent = questionText(question);
    const existing = latestHuman(question.id);
    $('human-form').hidden = Boolean(existing && !app.editingHuman);
    $('human-locked').hidden = !existing || app.editingHuman;
    if (existing) {
      $('human-saved-answer').textContent = existing.text;
      $('human-save-status').textContent = app.editingHuman ? '这是第 ' + (existing.revision + 1) + ' 版；首次独立答题原稿会保留。' : '';
      if (app.editingHuman) $('human-form').elements.answer.value = existing.text;
    } else {
      $('human-form').elements.answer.value = '';
      $('human-save-status').textContent = '提交前不会显示模型答案。';
    }
  }
  function selectedReview(questionId, subjectId, key) {
    return app.reviews.filter((review) => String(review.questionId) === String(questionId) && review.subjectId === subjectId && review.answerKey === key)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }
  function renderIntentCard(question) {
    const card = $('intent-card'); card.replaceChildren();
    [['最终任务', question.reference], ['一级 / 二级考点', [question.testPoint, question.subPoint].filter(Boolean).join(' / ')],
      ['通过条件', (question.successCriteria || []).join('\n')], ['失败信号', (question.failureSignals || []).join('\n')],
      ['仍需满足', (question.retained || []).join('\n')], ['被后文覆盖', (question.superseded || []).join('\n')],
      ['缺失材料', question.missing || '未标注']].forEach(([label, value]) => {
      const part = add(card, 'article'); add(part, 'strong', '', label); add(part, 'p', '', value || '未填写');
    });
  }
  function renderReviewCard(container, question, subjectId, answer, title) {
    const key = subjectId === 'human' ? WorkflowCore.humanKey(answer) : WorkflowCore.answerKey(answer);
    const saved = selectedReview(question.id, subjectId, key);
    const card = add(container, 'article', 'review-card');
    const header = add(card, 'div', 'panel-head'); add(header, 'span', 'eyebrow', subjectId === 'human' ? 'HUMAN ANSWER' : 'MODEL ANSWER'); add(header, 'strong', '', title);
    add(card, 'pre', 'answer-text', answer.text);
    const form = add(card, 'form');
    const line = add(form, 'div');
    const select = add(line, 'select'); select.required = true;
    [['', '选择意图完成情况'], ...Object.entries(VERDICTS)].forEach(([value, label]) => { const option = add(select, 'option', '', label); option.value = value; });
    select.value = saved?.label || '';
    add(line, 'span', 'small-note', saved ? '已复核 · ' + new Date(saved.createdAt).toLocaleString('zh-CN') : '尚未复核');
    const criteria = add(form, 'div', 'requirement-list');
    if ((question.successCriteria || []).length) add(criteria, 'strong', 'small-note', '逐条核对通过条件');
    (question.successCriteria || []).forEach((criterion, index) => {
      const label = add(criteria, 'label', 'check-row');
      const input = add(label, 'input'); input.type = 'checkbox';
      input.checked = Boolean(saved?.criteria?.find((item) => item.text === criterion)?.met);
      input.dataset.criterion = String(index);
      add(label, 'span', '', '满足：' + criterion);
    });
    const requirements = add(form, 'div', 'requirement-list');
    (question.retained || []).forEach((requirement, index) => {
      const label = add(requirements, 'label', 'check-row');
      const input = add(label, 'input'); input.type = 'checkbox';
      input.checked = Boolean(saved?.requirements?.find((item) => item.text === requirement)?.met);
      input.dataset.requirement = String(index);
      add(label, 'span', '', '满足：' + requirement);
    });
    const reason = add(form, 'textarea'); reason.rows = 2; reason.placeholder = '依据：实际完成了什么、遗漏了什么（建议填写）'; reason.value = saved?.reason || '';
    const button = add(form, 'button', 'primary-button', '保存核验'); button.type = 'submit';
    form.addEventListener('submit', (event) => {
      event.preventDefault(); busy(async () => { if (!VERDICTS[select.value]) throw new Error('请选择意图完成情况。');
      const criterionMarks = (question.successCriteria || []).map((text, index) => ({
        text, met: Boolean(criteria.querySelector('input[data-criterion="' + index + '"]')?.checked)
      }));
      if (select.value === 'pass' && criterionMarks.some((item) => !item.met))
        throw new Error('判为“通过”前，请逐条确认通过条件；若有遗漏请选择“部分通过”或“未通过”。');
      const review = {
        runId: app.run.id, questionId: question.id, questionVersion: question.version,
        subjectId, subjectType: subjectId === 'human' ? 'human' : 'model',
        ...(subjectId === 'human' ? { humanRevision: answer.revision } : { modelId: subjectId }),
        answerKey: key, label: select.value, reason: reason.value.trim(), source: 'human', createdAt: new Date().toISOString(),
        criteria: criterionMarks,
        requirements: (question.retained || []).map((text, index) => ({ text, met: Boolean(requirements.querySelector('input[data-requirement="' + index + '"]')?.checked) }))
      };
      const path = runPath('reviews/' + question.id + '-' + subjectId + '-' + key.replace(/[^A-Za-z0-9-]/g, '-') + '-' + crypto.randomUUID().slice(0, 8) + '.json');
      await write(path, review);
      app.reviews.push(review); render(); message(title + ' 的意图核验已保存。');
      });
    });
  }
  function renderAuditComparison(question) {
    const comparisons = WorkflowCore.buildComparisons(app.run, app.answers).filter((comparison) => String(comparison.questionId) === String(question.id));
    const select = $('comparison-select'); select.replaceChildren();
    if (!comparisons.length) {
      select.disabled = true; $('comparison-workspace').replaceChildren(add(node('div'), 'p', 'small-note', '这道题尚无两份模型回答，不能做模型间 GSB。'));
      return;
    }
    select.disabled = false;
    comparisons.forEach((comparison, index) => { const option = add(select, 'option', '', '对比 ' + (index + 1) + ' / 左右已固定'); option.value = comparison.id; });
    if (!comparisons.some((item) => item.id === select.dataset.selected)) select.dataset.selected = comparisons[0].id;
    select.value = select.dataset.selected;
    const comparison = comparisons.find((item) => item.id === select.value) || comparisons[0];
    const saved = app.ratings.filter((rating) => rating.comparisonId === comparison.id && rating.leftAnswerKey === comparison.leftAnswerKey && rating.rightAnswerKey === comparison.rightAnswerKey && rating.source === 'human')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const workspace = $('comparison-workspace'); workspace.replaceChildren();
    const grid = add(workspace, 'div', 'comparison-grid');
    [[comparison.left, 'LEFT / A'], [comparison.right, 'RIGHT / B']].forEach(([side, label]) => {
      const panel = add(grid, 'article'); const header = add(panel, 'div', 'panel-head'); add(header, 'span', 'eyebrow', label); add(header, 'strong', '', '回答');
      add(panel, 'pre', 'answer-text', side.text);
    });
    const form = add(workspace, 'form', 'gsb-panel'); add(form, 'h3', '', '哪边更好？');
    const options = add(form, 'div', 'gsb-options'); options.setAttribute('role', 'radiogroup'); options.setAttribute('aria-label', 'GSB 四档评分');
    Object.entries(GSB).forEach(([value, label]) => {
      const option = add(options, 'label'); const input = add(option, 'input'); input.type = 'radio'; input.name = 'gsb'; input.value = value; input.checked = saved?.choice === value;
      add(option, 'span', '', label);
    });
    const reason = add(form, 'textarea'); reason.rows = 2; reason.placeholder = '记录为什么左边好、右边好、一样好或一样差'; reason.value = saved?.reason || '';
    const save = add(form, 'button', 'primary-button', saved ? '更新 GSB' : '保存 GSB'); save.type = 'submit';
    form.addEventListener('submit', (event) => {
      event.preventDefault(); busy(async () => { const choice = form.querySelector('input[name="gsb"]:checked')?.value;
      if (!GSB[choice]) throw new Error('请选择四档 GSB 结论。');
      const rating = { runId: app.run.id, comparisonId: comparison.id, questionId: question.id, questionVersion: question.version,
        leftAnswerKey: comparison.leftAnswerKey, rightAnswerKey: comparison.rightAnswerKey, choice, reason: reason.value.trim(), source: 'human', createdAt: new Date().toISOString() };
      const filename = 'q' + question.id + '-' + comparison.leftModelId + '-' + comparison.rightModelId + '-' +
        comparison.leftAnswerKey.replace(/[^A-Za-z0-9-]/g, '-') + '-' + comparison.rightAnswerKey.replace(/[^A-Za-z0-9-]/g, '-') + '-' + crypto.randomUUID().slice(0, 8) + '.json';
      await write(runPath('ratings/' + filename), rating);
      app.ratings.push(rating); render(); message('四档 GSB 已保存到私有仓库。');
      });
    });
  }
  function renderAudit() {
    const eligible = app.run?.questions.filter((question) => latestHuman(question.id) && modelAnswers(question.id).length) || [];
    $('audit-empty').hidden = eligible.length > 0; $('audit-workspace').hidden = eligible.length === 0;
    if (!eligible.length) return;
    if (!eligible.some((q) => String(q.id) === String(app.auditQuestionId))) app.auditQuestionId = eligible[0].id;
    const select = $('audit-question-select'); select.replaceChildren();
    eligible.forEach((question) => { const option = add(select, 'option', '', code(question) + ' · ' + question.title); option.value = String(question.id); });
    select.value = String(app.auditQuestionId);
    const question = runQuestion(app.auditQuestionId);
    $('audit-question-title').textContent = code(question) + ' · ' + question.title;
    $('audit-question-text').textContent = questionText(question);
    renderIntentCard(question);
    const list = $('intent-review-list'); list.replaceChildren();
    const human = latestHuman(question.id);
    renderReviewCard(list, question, 'human', human, '人工答案 · 第 ' + human.revision + ' 版');
    app.run.models.forEach((model) => {
      const answer = modelAnswer(question.id, model.id);
      if (answer) renderReviewCard(list, question, model.id, answer, model.label);
    });
    renderAuditComparison(question);
  }

  function percent(rate) { return rate?.value == null ? '—' : (rate.value * 100).toFixed(1) + '%'; }
  function fraction(rate) { return rate ? rate.numerator + ' / ' + rate.denominator : '0 / 0'; }
  function reportData() { return app.run ? WorkflowCore.summarizeReport(app.run, app.answers, app.humanAnswers, app.reviews, app.ratings) : null; }
  function reportUnlocked() { return Boolean(app.run && app.run.questions.every((question) => !modelAnswers(question.id).length || latestHuman(question.id))); }
  async function archiveReport() {
    if (!reportUnlocked()) throw new Error('请先完成人工独立作答，再导出报告。');
    const generatedAt = new Date().toISOString();
    const reportId = crypto.randomUUID();
    const archive = { format: 'morgan-intent-report-snapshot-v1', reportId, generatedAt, run: structuredClone(app.run), report: reportData() };
    const filename = generatedAt.replace(/[-:.]/g, '') + '-' + reportId.slice(0, 8) + '.json';
    await write(runPath('reports/' + filename), archive);
    return archive;
  }
  function renderReport() {
    const report = reportData();
    $('report-empty').hidden = Boolean(report); $('report-workspace').hidden = !report;
    const unlocked = reportUnlocked();
    ['export-report-md', 'export-report-json', 'print-report'].forEach((id) => { $(id).disabled = !unlocked; });
    if (!report) return;
    $('report-meta').textContent = '运行 ' + report.runId + ' · ' + new Date(report.runCreatedAt).toLocaleString('zh-CN') +
      ' · ' + report.overall.questionCount + ' 题 · ' + (unlocked ? '可导出' : '人工答题未完成，逐题模型原文暂时隐藏');
    const stats = $('report-stats'); stats.replaceChildren();
    renderCoverage($('report-coverage'), report.coverage || WorkflowCore.summarizeCoverage(app.run.questions.map((q) => ({ ...q, approved: true }))));
    [
      ['题目数', report.overall.questionCount, '冻结题目与版本'],
      ['调用成功率', percent(report.overall.callSuccessRate), fraction(report.overall.callSuccessRate) + ' 次调用'],
      ['调用异常', report.overall.unconfiguredCalls + report.overall.timedOutCalls + report.overall.failedCalls + report.overall.missingCalls,
        '待配置 ' + report.overall.unconfiguredCalls + ' · 超时 ' + report.overall.timedOutCalls + ' · 其他失败 ' + report.overall.failedCalls + ' · 未返回 ' + report.overall.missingCalls],
      ['可比较场次', report.overall.comparisonsReady, report.overall.comparisonsExpected + ' 场预期'],
      ['已评分 GSB', report.overall.comparisonsRated, '四档人工判定'],
      ['AI 与人工评分一致', percent(report.overall.aiGsbAgreement), fraction(report.overall.aiGsbAgreement) + ' 场'],
      ['旧评分排除', report.overall.excluded.staleReviews + report.overall.excluded.staleRatings + report.overall.excluded.invalidRatings,
        '过期核验 ' + report.overall.excluded.staleReviews + ' · 过期/无效 GSB ' + (report.overall.excluded.staleRatings + report.overall.excluded.invalidRatings)]
    ].forEach(([label, value, caption]) => { const card = add(stats, 'article'); add(card, 'strong', '', value); add(card, 'span', '', label + ' · ' + caption); });
    const models = $('report-models'); models.replaceChildren();
    report.models.forEach((metric) => {
      const card = add(models, 'article'); add(card, 'h3', '', metric.label);
      const dl = add(card, 'dl');
      [
        ['调用成功', percent(metric.calls.rate) + ' (' + fraction(metric.calls.rate) + ')'],
        ['待配置 / 超时 / 其他失败 / 未返回', metric.calls.unconfigured + ' / ' + metric.calls.timedOut + ' / ' + metric.calls.failed + ' / ' + metric.calls.missing],
        ['最终意图完成', percent(metric.intent.passRate) + ' (' + fraction(metric.intent.passRate) + ')'],
        ['部分通过', metric.intent.partial + ' 题'],
        ['未复核 / 不可评', metric.intent.unreviewed + ' / ' + metric.intent.unassessable],
        ['GSB 相对比较分', percent(metric.gsb.score) + ' (' + metric.gsb.points + ' / ' + metric.gsb.denominator + ')'],
        ['胜 / 负', metric.gsb.wins + ' / ' + metric.gsb.losses],
        ['一样好 / 一样差', metric.gsb.both_good + ' / ' + metric.gsb.both_bad],
        ['人机任务结果一致', percent(metric.agreement.rate) + ' (' + fraction(metric.agreement.rate) + ')'],
        ['双通过 / 双未通过 / 双部分通过', metric.agreement.bothPassed + ' / ' + metric.agreement.bothFailed + ' / ' + metric.agreement.bothPartial],
        ['仅人工通过 / 仅模型通过', metric.agreement.onlyHumanPassed + ' / ' + metric.agreement.onlyModelPassed]
      ].forEach(([name, value]) => { add(dl, 'dt', '', name); add(dl, 'dd', '', value); });
    });
    const cases = $('report-cases'); cases.replaceChildren();
    report.questions.forEach((question) => {
      const card = add(cases, 'article', 'case-item');
      add(card, 'strong', '', 'M' + String(question.questionId).padStart(3, '0') + ' · ' + question.title);
      add(card, 'p', 'case-meta', question.dimension + (question.testPoint ? ' · ' + question.testPoint : '') +
        (question.subPoint ? ' / ' + question.subPoint : '') + ' · 题目版本 ' + question.questionVersion +
        ' · 人工 ' + (question.human?.review ? VERDICTS[question.human.review.label] : question.human ? '待核验' : '未作答'));
      const rubric = app.run.questions.find((item) => String(item.id) === String(question.questionId));
      add(card, 'p', 'case-meta', '通过条件：' + ((rubric?.successCriteria || []).join('；') || '旧题未定义'));
      if (!question.human) { add(card, 'p', '', '人工尚未独立作答，本题模型原文保持隐藏。'); return; }
      const detail = add(card, 'div', 'case-detail');
      add(detail, 'p', '', '人工答案：' + question.human.text.slice(0, 350) + (question.human.text.length > 350 ? '…' : ''));
      question.models.forEach((model) => {
        const review = model.review ? VERDICTS[model.review.label] : model.callStatus === 'succeeded' ? '待核验' :
          model.callStatus === 'unconfigured' ? 'API 待配置' : model.callStatus === 'timeout' ? '调用超时' :
            model.callStatus === 'failed' ? '调用失败' : '未返回';
        add(detail, 'p', '', modelLabel(model.modelId) + '：' + review + (model.text ? '\n' + model.text.slice(0, 350) + (model.text.length > 350 ? '…' : '') : ''));
      });
      report.comparisons.filter((item) => String(item.questionId) === String(question.questionId)).forEach((item) => {
        add(card, 'p', '', modelLabel(item.left.modelId) + ' vs ' + modelLabel(item.right.modelId) + '：' +
          (item.rating ? GSB[item.rating.choice] + (item.rating.reason ? ' · ' + item.rating.reason : '') : '待 GSB'));
      });
    });
  }

  function buildMarkdownReport(run, report, archive) {
    const lines = ['# Morgan ClawBench 意图评测报告', '',
      '- 运行 ID：' + run.id, '- 报告快照 ID：' + archive.reportId,
      '- 运行创建时间：' + run.createdAt, '- 报告生成时间：' + archive.generatedAt,
      '- 题目：' + report.overall.questionCount + ' 道；模型：' + report.overall.modelCount + ' 个',
      '- 调用成功：' + fraction(report.overall.callSuccessRate) + '（' + percent(report.overall.callSuccessRate) + '）',
      '- 待配置 / 超时 / 其他失败 / 未返回：' + report.overall.unconfiguredCalls + ' / ' + report.overall.timedOutCalls +
        ' / ' + report.overall.failedCalls + ' / ' + report.overall.missingCalls,
      '- 已评分 GSB：' + report.overall.comparisonsRated + ' / ' + report.overall.comparisonsExpected, '',
      '- 排除的旧核验 / 旧评分 / 无效评分：' + report.overall.excluded.staleReviews + ' / ' + report.overall.excluded.staleRatings + ' / ' + report.overall.excluded.invalidRatings, '',
      '## 模型结果', '',
      '| 模型 | 最终意图完成率 | 人机任务结果一致率 | GSB 相对比较分 | 一样好 / 一样差 | 未复核 / 不可评 |',
      '| --- | --- | --- | --- | --- | --- |'];
    report.models.forEach((metric) => lines.push('| ' + metric.label + ' | ' + percent(metric.intent.passRate) + ' (' + fraction(metric.intent.passRate) + ') | ' +
      percent(metric.agreement.rate) + ' (' + fraction(metric.agreement.rate) + ') | ' + percent(metric.gsb.score) +
      ' (' + metric.gsb.points + '/' + metric.gsb.denominator + ') | ' + metric.gsb.both_good + ' / ' + metric.gsb.both_bad +
      ' | ' + metric.intent.unreviewed + ' / ' + metric.intent.unassessable + ' |'));
    lines.push('', '## 本次题目覆盖', '', '- 有通过条件：' + report.coverage.rubricReady + ' / ' + report.coverage.approved,
      ...Object.entries(report.coverage.testPoints).map(([name, count]) => '- 一级考点「' + name + '」：' + count + ' 题'),
      '', '## 逐题依据', '');
    report.questions.forEach((item) => {
      const question = run.questions.find((q) => q.id === item.questionId);
      lines.push('### ' + item.title + '（题目 ' + item.questionId + ' / v' + item.questionVersion + '）', '',
        '**能力维度：** ' + item.dimension, '**考点：** ' + [question?.testPoint, question?.subPoint].filter(Boolean).join(' / '),
        '', '**题目：**', '', ...(question?.turns || []), '', '**最终意图：** ' + (question?.reference || '未填写'),
        '', '**通过条件：**', ...(question?.successCriteria || []).map((criterion) => '- ' + criterion),
        '', '**失败信号：**', ...(question?.failureSignals || []).map((signal) => '- ' + signal), '');
      if (item.human) lines.push('**人工答案（第 ' + item.human.revision + ' 版）：**', '', item.human.text, '',
        '**人工核验：** ' + (VERDICTS[item.human.review?.label] || '待核验') + (item.human.review?.reason ? '；' + item.human.review.reason : ''),
        ...(item.human.review?.criteria || []).map((criterion) => '- ' + (criterion.met ? '满足' : '未满足') + '通过条件：' + criterion.text),
        ...(item.human.review?.requirements || []).map((requirement) => '- ' + (requirement.met ? '满足' : '未满足') + '：' + requirement.text), '');
      item.models.forEach((model) => lines.push('**' + modelLabel(model.modelId) + '：** ' +
        (model.text ? '\n\n' + model.text : model.callStatus + (model.errorCode ? ' (' + model.errorCode + ')' : '')), '',
        '**实际调用型号：** ' + (model.providerModel || '未记录') + '；来源：' + (model.source || '未记录') +
          '；attempt：' + (model.attempt || '—') + '；耗时：' + (model.latencyMs == null ? '未记录' : model.latencyMs + ' ms'),
        '**意图核验：** ' + (VERDICTS[model.review?.label] || '待核验') + (model.review?.reason ? '；' + model.review.reason : ''),
        ...(model.review?.criteria || []).map((criterion) => '- ' + (criterion.met ? '满足' : '未满足') + '通过条件：' + criterion.text),
        ...(model.review?.requirements || []).map((requirement) => '- ' + (requirement.met ? '满足' : '未满足') + '：' + requirement.text), ''));
      report.comparisons.filter((row) => row.questionId === item.questionId).forEach((row) => lines.push('- GSB ' +
        modelLabel(row.left.modelId) + ' vs ' + modelLabel(row.right.modelId) + '：' + (row.rating ? GSB[row.rating.choice] + '；' + (row.rating.reason || '无理由') : '待评分')));
      lines.push('');
    });
    lines.push('## 人机任务结果分布', '');
    report.models.forEach((metric) => lines.push('- ' + metric.label + '：双通过 ' + metric.agreement.bothPassed +
      '；仅人工通过 ' + metric.agreement.onlyHumanPassed + '；仅模型通过 ' + metric.agreement.onlyModelPassed +
      '；双未通过 ' + metric.agreement.bothFailed + '；双部分通过 ' + metric.agreement.bothPartial));
    lines.push('', '## 口径', '', '最终意图完成率、人机任务结果一致率和 GSB 相对比较分独立呈现。双方都未通过也会计入任务结果一致，但会单列。未复核、不可评和 API 失败不计入质量分母。', '');
    return lines.join('\n');
  }

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault(); busy(async () => {
    const form = event.currentTarget;
    $('connect-message').textContent = '正在连接…';
    try {
      const result = await WorkflowStore.connect(form.elements.owner.value.trim(), form.elements.repo.value.trim(), form.elements.token.value.trim());
      app.bank = result?.data && Array.isArray(result.data.questions) ? result.data : { format: 'morgan-intent-bench-v1', nextId: 1, questions: [] };
      app.bankSha = result?.sha || null;
      app.bank.nextId = Math.max(Number(app.bank.nextId) || 1, ...app.bank.questions.map((q) => Number(q.id) + 1));
      app.questionId = app.bank.questions[0]?.id || null;
      await loadRuns();
      form.elements.token.value = '';
      $('connection-label').textContent = WorkflowStore.repository();
      $('connect-screen').hidden = true; $('workspace').hidden = false;
      $('reload-button').hidden = false; $('disconnect-button').hidden = false;
      $('connect-message').textContent = '';
      setView(app.view);
    } catch (error) {
      WorkflowStore.disconnect(); $('connect-message').textContent = errorText(error); throw error;
    }
    });
  });
  $('disconnect-button').addEventListener('click', () => {
    WorkflowStore.disconnect();
    location.reload();
  });
  $('reload-button').addEventListener('click', () => busy(async () => {
    const savedRunId = app.run?.id;
    const bank = await WorkflowStore.readJson(ROOT + '/state.json');
    if (bank) { app.bank = bank.data; app.bankSha = bank.sha; }
    await loadRuns();
    if (savedRunId && app.runs.some((run) => run.id === savedRunId)) await loadRun(savedRunId);
    render(); message('已从私有仓库重新载入。');
  }));
  $('docx-input').addEventListener('change', (event) => busy(async () => {
    const file = event.target.files?.[0]; if (!file) return;
    $('import-status').textContent = '正在本地解析 Word…';
    const result = await WordImport.readDocx(file);
    app.importDrafts = result.drafts; app.importWarnings = result.warnings;
    renderImport();
  }));
  $('save-import').addEventListener('click', () => busy(async () => {
    if (!app.importDrafts.length) return;
    const sourceHash = app.importDrafts[0].source?.hash;
    if (sourceHash && app.bank.questions.some((q) => q.source?.hash === sourceHash)) throw new Error('这份 Word 文件已经导入过；请在题库中继续审核。');
    const previous = structuredClone(app.bank);
    app.importDrafts.forEach((draft) => app.bank.questions.push(makeQuestion(draft, app.bank.nextId++)));
    app.questionId = previous.nextId;
    if (await saveBank(previous)) { app.importDrafts = []; app.importWarnings = []; renderImport(); message('草稿已保存。请在右侧逐题确认最终意图。'); }
  }));
  $('new-question').addEventListener('click', () => busy(async () => {
    const previous = structuredClone(app.bank);
    const question = makeQuestion({ title: '', turns: [], reference: '' }, app.bank.nextId++);
    question.title = '';
    app.bank.questions.push(question); app.questionId = question.id;
    if (await saveBank(previous)) $('question-form').elements.title.focus();
  }));
  $('question-form').addEventListener('submit', (event) => {
    event.preventDefault(); busy(async () => { const question = currentQuestion(); if (!question) return;
    const form = event.currentTarget;
    const update = {
      title: form.elements.title.value.trim(), dimension: form.elements.dimension.value,
      testPoint: form.elements.testPoint.value, subPoint: form.elements.subPoint.value.trim(),
      turns: lines(form.elements.turns.value), reference: form.elements.reference.value.trim(),
      successCriteria: lines(form.elements.successCriteria.value), failureSignals: lines(form.elements.failureSignals.value),
      retained: lines(form.elements.retained.value), superseded: lines(form.elements.superseded.value), missing: form.elements.missing.value.trim()
    };
    if (!update.title || !update.turns.length) throw new Error('题目标题和对话轮次不能为空。');
    if (form.elements.approved.checked && !update.reference) throw new Error('确认题目前，请写明最终意图。');
    if (form.elements.approved.checked && !update.testPoint && !question.approved)
      throw new Error('确认新题前，请选择一级考点。');
    if (form.elements.approved.checked && !update.successCriteria.length && !question.approved)
      throw new Error('确认新题前，请至少写一条可观察的通过条件。');
    const previous = structuredClone(app.bank);
    const changed = Object.keys(update).some((key) => JSON.stringify(question[key] || (Array.isArray(update[key]) ? [] : '')) !== JSON.stringify(update[key]));
    Object.assign(question, update);
    if (changed) question.version = (Number(question.version) || 1) + 1;
    question.approved = changed && previous.questions.find((q) => q.id === question.id)?.approved ? false : form.elements.approved.checked;
    if (await saveBank(previous)) $('question-status').textContent = question.approved ? '已确认，可用于新运行。' : changed ? '内容已更新，请再次核对后确认。' : '草稿已保存。';
    });
  });
  $('create-run').addEventListener('click', () => busy(async () => {
    const chosenIds = [...$('run-question-list').querySelectorAll('input:checked')].map((input) => Number(input.value));
    const chosenModels = [...$('run-model-list').querySelectorAll('input:checked')].map((input) => MODELS.find((model) => model.id === input.value)).filter(Boolean);
    const questions = app.bank.questions.filter((question) => chosenIds.includes(question.id) && question.approved && !question.isDemo && question.reference?.trim());
    if (!questions.length) throw new Error('请选择至少一道已确认且写明最终意图的正式题目。');
    if (!chosenModels.length) throw new Error('请选择至少一个模型。');
    if ($('run-mode').value === 'api' && questions.length > 30) throw new Error('API 模式每次最多选择 30 道题；请拆分为多次运行。');
    const run = WorkflowCore.createRun(questions, chosenModels, crypto.randomUUID(), new Date());
    run.mode = $('run-mode').value;
    const path = ROOT + '/runs/' + run.id + '/request.json';
    await WorkflowStore.writeJson(path, run);
    app.runs.unshift(run);
    await loadRun(run.id);
    message('运行已冻结。先获得模型答案，再进入人工独立作答。');
    if (run.mode === 'api') message('运行已创建。请点击“通过 API 开始答题”触发后台任务。');
  }));
  $('download-agent-request').addEventListener('click', () => {
    if (!app.run || app.run.mode !== 'agent') return;
    const payload = {
      format: 'morgan-intent-agent-request-v1', runId: app.run.id,
      instruction: '请根据每题完整多轮对话，完成用户最后仍有效的实际任务。不要仅概括意图。',
      models: app.run.models,
      questions: app.run.questions.map((question) => ({ questionId: question.id, questionVersion: question.version, turns: question.turns })),
      answerFormat: { runId: app.run.id, answers: [{ questionId: app.run.questions[0]?.id, questionVersion: app.run.questions[0]?.version, modelId: app.run.models[0]?.id, text: '模型完成任务的原始回答' }] }
    };
    download('agent-questions-' + app.run.id + '.json', JSON.stringify(payload, null, 2));
  });
  $('dispatch-run').addEventListener('click', () => busy(async () => {
    if (!app.run || app.run.mode !== 'api') return;
    await WorkflowStore.dispatchRun(app.run.id);
    message('GitHub 已接收触发请求。请在 Actions 确认任务启动，并稍后刷新模型结果。');
  }));
  $('refresh-run').addEventListener('click', () => busy(async () => {
    if (!app.run) return;
    await loadRun(app.run.id);
    message('已从私有仓库读取最新模型答案。');
  }));
  $('agent-result-input').addEventListener('change', (event) => busy(async () => {
    const file = event.target.files?.[0];
    if (!file || !app.run) return;
    if (app.run.mode !== 'agent') throw new Error('这次运行选择了 API 模式，不能导入 Agent 结果。');
    if (file.size > 5 * 1024 * 1024) throw new Error('Agent 结果 JSON 不能超过 5 MB。');
    let payload;
    try { payload = JSON.parse(await file.text()); } catch (_) { throw new Error('Agent 结果不是有效 JSON。'); }
    const checked = WorkflowCore.validateImportedAnswers(app.run, payload);
    if (checked.errors.length) throw new Error('导入校验未通过：' + checked.errors.join('；'));
    if (!checked.answers.length) throw new Error('导入文件中没有答案。');
    for (const answer of checked.answers) {
      const existing = app.answers.find((item) => String(item.questionId) === String(answer.questionId) && item.modelId === answer.modelId);
      if (existing?.status === 'succeeded' && existing.text !== answer.text) {
        throw new Error('题目 ' + answer.questionId + ' 的 ' + modelLabel(answer.modelId) + ' 已有不同的成功答案，请新建运行，避免覆盖原始回答。');
      }
    }
    let saved = 0, skipped = 0;
    for (const answer of checked.answers) {
      const filename = answer.questionId + '-' + answer.modelId + '.json';
      const path = runPath('answers/' + filename);
      const existing = app.answers.find((item) => String(item.questionId) === String(answer.questionId) && item.modelId === answer.modelId);
      if (existing?.status === 'succeeded') { skipped++; continue; }
      try {
        if (existing) {
          await write(runPath('attempts/' + answer.questionId + '-' + answer.modelId + '-' + (existing.attempt || 1) + '.json'), existing);
          answer.attempt = (existing.attempt || 1) + 1;
          answer.answerKey = WorkflowCore.answerKey(answer);
        }
        await write(path, answer);
        saved++;
      } catch (error) {
        await loadRun(app.run.id);
        throw new Error('已保存 ' + saved + ' 条，后续保存失败：' + errorText(error) + '。请刷新后检查结果。');
      }
    }
    event.target.value = '';
    await loadRun(app.run.id);
    message('已保存 ' + saved + ' 份模型原始答案' + (skipped ? '，跳过 ' + skipped + ' 份相同的已有答案' : '') + '。现在可以人工独立作答。');
  }));
  $('human-question-select').addEventListener('change', (event) => {
    app.humanQuestionId = Number(event.target.value); app.editingHuman = false; renderHuman();
  });
  $('human-new-revision').addEventListener('click', () => {
    app.editingHuman = true; renderHuman(); $('human-form').elements.answer.focus();
  });
  $('human-form').addEventListener('submit', (event) => {
    event.preventDefault(); busy(async () => {
    const question = runQuestion(app.humanQuestionId); if (!question || !modelAnswers(question.id).length) throw new Error('请先等待模型完成这道题。');
    const text = event.currentTarget.elements.answer.value.trim(); if (!text) throw new Error('请填写实际任务答案。');
    const existing = latestHuman(question.id);
    if (existing && !app.editingHuman) throw new Error('原稿已锁定；请新建修订版本。');
    const revision = existing ? existing.revision + 1 : 1;
    const answer = { runId: app.run.id, questionId: question.id, questionVersion: question.version, revision, text,
      source: 'human', blind: !existing, createdAt: new Date().toISOString(), answerKey: 'human:' + question.id + ':' + question.version + ':' + revision };
    await write(runPath('human/' + question.id + '/revision-' + revision + '.json'), answer);
    app.humanAnswers.push(answer); app.editingHuman = false; render();
    message('人工答案已保存为第 ' + revision + ' 版。现在可以进行意图核验和 GSB。');
    });
  });
  $('audit-question-select').addEventListener('change', (event) => { app.auditQuestionId = Number(event.target.value); renderAudit(); });
  $('comparison-select').addEventListener('change', (event) => { event.target.dataset.selected = event.target.value; renderAudit(); });
  $('export-report-md').addEventListener('click', () => busy(async () => {
    const archive = await archiveReport();
    download('intent-report-' + archive.run.id + '.md', buildMarkdownReport(archive.run, archive.report, archive), 'text/markdown;charset=utf-8');
    message('报告快照已保存到私有仓库，Markdown 已下载。');
  }));
  $('export-report-json').addEventListener('click', () => busy(async () => {
    const archive = await archiveReport();
    download('intent-report-' + archive.run.id + '.json', JSON.stringify(archive, null, 2));
    message('报告快照已保存到私有仓库，JSON 已下载。');
  }));
  $('print-report').addEventListener('click', () => busy(async () => {
    await archiveReport();
    window.print();
  }));

  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    $('connect-form').elements.token.disabled = true;
    $('connect-form').querySelector('button[type="submit"]').disabled = true;
    $('connect-message').textContent = '当前页面不是 HTTPS，已关闭令牌输入。';
  }

  function render() { renderBank(); renderRuns(); renderHuman(); renderAudit(); renderReport(); }
})();
