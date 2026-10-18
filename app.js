(function () {
  'use strict';
  const LABELS = { left: '左边好', right: '右边好', both_good: '一样好', both_bad: '一样差' };
  const allowed = new Set(['overview', 'bank', 'answers', 'review', 'results']);
  const $ = (id) => document.getElementById(id);
  let state = { nextId: 1, selectedId: null, questions: [] };
  let view = allowed.has(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  let pending = false;
  const selectedPairs = new Map();
  function blankPair(id) { return { id, answerRevision: 0, answers: { left: { name: '', text: '' }, right: { name: '', text: '' } }, gsb: null }; }
  function pairs(q) { return q?.comparisons || []; }
  function pair(q) { return pairs(q).find((item) => item.id === selectedPairs.get(q.id)) || pairs(q)[0] || null; }
  function pairLabel(item) { return '对比 ' + item.id + ' · ' + (item.answers?.left?.name || '左侧模型') + ' vs ' + (item.answers?.right?.name || '右侧模型'); }
  function renderPairSelector(id, q) {
    const select = $(id); select.replaceChildren();
    pairs(q).forEach((item) => { const option = document.createElement('option'); option.value = String(item.id); option.textContent = pairLabel(item); select.appendChild(option); });
    select.value = String(pair(q)?.id || '');
  }
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  async function persist(previous, successMessage) {
    if (pending) { state = previous; message('正在保存上一项操作，请稍后再试。'); render(); return false; }
    pending = true;
    document.querySelectorAll('button').forEach((button) => { if (!button.dataset.wasDisabled) { button.dataset.wasDisabled = button.disabled ? 'yes' : 'no'; button.disabled = true; } });
    try {
      await GitHubStore.save(state);
      message(successMessage || '已保存到私有 GitHub 仓库。');
      return true;
    } catch (error) {
      state = previous;
      render();
      message('保存失败，修改未计入结果：' + error.message);
      return false;
    } finally {
      pending = false;
      document.querySelectorAll('button').forEach((button) => { button.disabled = button.dataset.wasDisabled === 'yes'; delete button.dataset.wasDisabled; });
    }
  }
  function message(text) { $('app-message').textContent = text; $('app-message').hidden = false; }
  function text(parent, tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    parent.appendChild(node);
    return node;
  }
  function current() { return state.questions.find((q) => q.id === state.selectedId) || null; }
  function code(q) { return 'M' + String(q.id).padStart(3, '0'); }
  function ready(q, item = pair(q)) { return Boolean(q && q.approved && item?.answers?.left?.name && item.answers.left.text && item.answers.right.name && item.answers.right.text); }
  function currentRating(q, item = pair(q)) { return ready(q, item) && item.gsb && item.gsb.questionVersion === q.version && item.gsb.answerRevision === item.answerRevision && LABELS[item.gsb.choice]; }
  function completed() { return state.questions.flatMap((q) => pairs(q).filter((item) => currentRating(q, item)).map((item) => ({ q, pair: item }))); }
  function status(q) { const scored = pairs(q).filter((item) => currentRating(q, item)).length; return scored ? scored + '/' + pairs(q).length + ' 组已评分' : q.approved ? pairs(q).some((item) => ready(q, item)) ? '待评分' : '待回答' : '草稿'; }
  function selectView(name) {
    if (!allowed.has(name)) return;
    view = name;
    history.replaceState(null, '', '#' + name);
    document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== name; });
    document.querySelectorAll('[data-view]').forEach((el) => { el.setAttribute('aria-current', el.dataset.view === name ? 'page' : 'false'); });
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function selectQuestion(id, destination) {
    if (!state.questions.some((q) => q.id === id)) return;
    state.selectedId = id;
    selectView(destination || view);
  }
  async function newQuestion() {
    if (pending) return;
    const previous = snapshot();
    const q = { id: state.nextId++, title: '', dimension: '意图识别', turns: [], reference: '', approved: false, version: 1, comparisons: [blankPair(1)] };
    state.questions.push(q);
    state.selectedId = q.id;
    if (!await persist(previous, '新题目已保存到私有 GitHub 仓库。')) return;
    selectView('bank');
    $('question-form').elements.title.focus();
  }
  function renderSide() {
    $('side-count').textContent = state.questions.length + ' 题';
    const list = $('question-list'); list.replaceChildren();
    state.questions.forEach((q) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = q.id === state.selectedId ? 'active' : '';
      text(button, 'span', code(q), 'question-number');
      const body = document.createElement('span'); text(body, 'strong', q.title || '未命名题目'); text(body, 'small', q.dimension + ' · ' + status(q)); button.appendChild(body);
      button.addEventListener('click', () => selectQuestion(q.id, 'bank')); list.appendChild(button);
    });
  }
  function renderOverview() {
    const total = state.questions.length;
    const approved = state.questions.filter((q) => q.approved).length;
    const answered = state.questions.reduce((count, q) => count + pairs(q).filter((item) => item.answers.left.text && item.answers.right.text).length, 0);
    const totalPairs = state.questions.reduce((count, q) => count + pairs(q).length, 0);
    const done = completed().length;
    $('progress-label').textContent = done + ' / ' + totalPairs + ' 组对比完成 GSB · ' + approved + ' 道题已确认';
    const root = $('overview-stats'); root.replaceChildren();
    [['题库题目', total], ['已确认题目', approved], ['双模型回答组', answered], ['已评分 GSB 组', done]].forEach(([label, value]) => {
      const box = document.createElement('div'); box.className = 'stat'; text(box, 'strong', String(value).padStart(2, '0')); text(box, 'span', label); root.appendChild(box);
    });
  }
  function renderBank() {
    const has = state.questions.length > 0;
    $('bank-empty').hidden = has; $('bank-workspace').hidden = !has;
    if (!has) return;
    const q = current() || state.questions[0];
    state.selectedId = q.id;
    $('bank-count').textContent = state.questions.length + ' 题';
    const list = $('bank-list'); list.replaceChildren();
    state.questions.forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = item.id === q.id ? 'active' : '';
      const details = document.createElement('span'); text(details, 'strong', code(item) + ' · ' + (item.title || '未命名题目') + (item.isDemo ? ' · 演示' : '')); text(details, 'small', item.dimension + ' · ' + item.turns.length + ' 轮'); button.appendChild(details);
      text(button, 'span', item.approved ? '已确认' : '草稿', item.approved ? 'status approved' : 'status');
      button.addEventListener('click', () => selectQuestion(item.id, 'bank')); list.appendChild(button);
    });
    $('editing-id').textContent = code(q) + ' / V' + q.version;
    const form = $('question-form'); form.elements.title.value = q.title; form.elements.dimension.value = q.dimension;
    form.elements.turns.value = q.turns.join('\n'); form.elements.reference.value = q.reference || ''; form.elements.approved.checked = Boolean(q.approved);
    $('question-form-message').textContent = '';
  }
  function renderContext(prefix, q) {
    $(prefix + '-question-id').textContent = code(q);
    $(prefix + '-question-title').textContent = q.title || '未命名题目';
    $(prefix + '-question-dimension').textContent = q.dimension;
    $(prefix + '-question-turns').textContent = q.turns.map((turn, i) => String(i + 1).padStart(2, '0') + '  ' + turn).join('\n');
  }
  function renderAnswers() {
    const q = current(); $('answers-empty').hidden = Boolean(q); $('answers-workspace').hidden = !q;
    if (!q) return;
    renderContext('answer', q);
    renderPairSelector('answer-pair-select', q);
    $('delete-pair').disabled = pairs(q).length <= 1;
    const item = pair(q);
    const form = $('answer-form');
    form.elements.leftName.value = item.answers?.left?.name || '';
    form.elements.leftText.value = item.answers?.left?.text || '';
    form.elements.rightName.value = item.answers?.right?.name || '';
    form.elements.rightText.value = item.answers?.right?.text || '';
    $('answer-form-message').textContent = '';
  }
  function compareCard(side, answer) {
    const card = document.createElement('article'); card.className = 'compare-card';
    const head = document.createElement('div'); head.className = 'panel-head';
    text(head, 'span', side === 'left' ? 'LEFT / MODEL A' : 'RIGHT / MODEL B', 'eyebrow');
    text(head, 'strong', answer.name); card.appendChild(head);
    text(card, 'p', answer.text); return card;
  }
  function renderReview() {
    const q = current(); const item = q && pair(q); const eligible = ready(q, item);
    $('review-pair-toolbar').hidden = !q;
    if (q) renderPairSelector('review-pair-select', q);
    $('review-empty').hidden = eligible; $('review-workspace').hidden = !eligible;
    if (!eligible) {
      $('review-empty-reason').textContent = !q ? '请先建立题目。' : !q.approved ? '请先在题库中确认这道题，再为两个模型录入回答。' : '请先录入左右两个模型的名称和回答。';
      return;
    }
    renderContext('review', q);
    $('review-reference').textContent = q.reference ? '人工参考意图：' + q.reference : '这道题尚未填写人工参考意图。';
    const comparison = $('comparison'); comparison.replaceChildren(compareCard('left', item.answers.left), compareCard('right', item.answers.right));
    const form = $('gsb-form'); form.reset();
    if (currentRating(q, item)) {
      const input = form.querySelector('input[value="' + item.gsb.choice + '"]'); if (input) input.checked = true;
      form.elements.reason.value = item.gsb.reason || '';
    }
    $('gsb-form-message').textContent = item.gsb && !currentRating(q, item) ? '题目或回答已更新，请重新评分。' : '';
  }
  function rows() {
    return completed().map(({ q, pair: item }) => ({ q, pair: item, left: item.answers.left.name, right: item.answers.right.name, choice: item.gsb.choice, reason: item.gsb.reason || '' }));
  }
  function addScore(map, model, dimension, points, outcome) {
    const key = model + '\u0000' + dimension;
    if (!map.has(key)) map.set(key, { model, dimension, count: 0, points: 0, wins: 0, losses: 0, both_good: 0, both_bad: 0 });
    const item = map.get(key); item.count++; item.points += points; item[outcome]++;
  }
  function summarize(records) {
    const map = new Map();
    records.forEach((r) => {
      const leftOutcome = r.choice === 'left' ? 'wins' : r.choice === 'right' ? 'losses' : r.choice;
      const rightOutcome = r.choice === 'right' ? 'wins' : r.choice === 'left' ? 'losses' : r.choice;
      addScore(map, r.left, r.q.dimension, r.choice === 'left' ? 1 : r.choice === 'right' ? 0 : .5, leftOutcome);
      addScore(map, r.right, r.q.dimension, r.choice === 'right' ? 1 : r.choice === 'left' ? 0 : .5, rightOutcome);
    });
    return [...map.values()];
  }
  function scoreText(points, count) { return count ? (points / count * 100).toFixed(1) + '%' : '—'; }
  function renderResults() {
    const records = rows(); $('results-empty').hidden = records.length > 0; $('results-workspace').hidden = records.length === 0;
    if (!records.length) return;
    const demoCount = records.filter((r) => r.q.isDemo).length;
    $('results-count').textContent = records.length + ' 场比较' + (demoCount ? ' · 含 ' + demoCount + ' 场虚构演示' : '');
    const dimensions = summarize(records);
    const allModels = [...new Set(dimensions.map((x) => x.model))].map((name) => {
      const items = dimensions.filter((x) => x.model === name);
      return items.reduce((acc, item) => { acc.count += item.count; acc.points += item.points; acc.wins += item.wins; acc.losses += item.losses; acc.both_good += item.both_good; acc.both_bad += item.both_bad; return acc; }, { model: name, count: 0, points: 0, wins: 0, losses: 0, both_good: 0, both_bad: 0 });
    }).sort((a, b) => b.points / b.count - a.points / a.count);
    const cards = $('model-cards'); cards.replaceChildren();
    allModels.forEach((item) => {
      const card = document.createElement('article'); card.className = 'model-card';
      text(card, 'h3', item.model);
      const score = document.createElement('div'); score.className = 'model-score'; text(score, 'strong', scoreText(item.points, item.count)); text(score, 'span', '比较得分率 · ' + item.count + ' 场'); card.appendChild(score);
      const breakdown = document.createElement('div'); breakdown.className = 'model-breakdown';
      [['左/右胜', item.wins], ['失利', item.losses], ['一样好', item.both_good], ['一样差', item.both_bad]].forEach(([label, value]) => { const cell = document.createElement('div'); text(cell, 'span', label); text(cell, 'strong', value); breakdown.appendChild(cell); });
      card.appendChild(breakdown); cards.appendChild(card);
    });
    const wrap = $('dimension-table'); wrap.replaceChildren();
    const table = document.createElement('table'); const head = document.createElement('thead'); const headRow = document.createElement('tr');
    ['模型', '能力维度', '比较得分率', '场次', '胜 / 负', '一样好 / 一样差'].forEach((label) => text(headRow, 'th', label)); head.appendChild(headRow); table.appendChild(head);
    const body = document.createElement('tbody'); dimensions.sort((a, b) => a.dimension.localeCompare(b.dimension, 'zh') || a.model.localeCompare(b.model, 'zh')).forEach((item) => {
      const tr = document.createElement('tr'); [item.model, item.dimension, scoreText(item.points, item.count), item.count, item.wins + ' / ' + item.losses, item.both_good + ' / ' + item.both_bad].forEach((value) => text(tr, 'td', value)); body.appendChild(tr);
    }); table.appendChild(body); wrap.appendChild(table);
    const list = $('case-list'); list.replaceChildren();
    records.forEach((r) => {
      const item = document.createElement('article'); item.className = 'case-item'; const body = document.createElement('div');
      text(body, 'strong', code(r.q) + ' / 对比 ' + r.pair.id + ' · ' + r.q.title + (r.q.isDemo ? '（虚构演示）' : '') + ' · ' + r.left + ' vs ' + r.right);
      text(body, 'p', (r.reason ? '理由：' + r.reason : '未填写评分理由') + ' · ' + r.q.dimension);
      item.appendChild(body); text(item, 'span', LABELS[r.choice]); list.appendChild(item);
    });
  }
  function render() { renderSide(); renderOverview(); renderBank(); renderAnswers(); renderReview(); renderResults(); }

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); selectView(button.dataset.view); }));
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.go)));
  ['new-question', 'new-question-side', 'new-question-empty'].forEach((id) => $(id).addEventListener('click', newQuestion));
  $('load-demo').addEventListener('click', async () => {
    if (state.questions.length) return;
    const previous = snapshot();
    const q = { id: state.nextId++, title: '对话最后想要什么', dimension: '意图识别', turns: ['请帮我构思一篇旅行分享文章。', '内容想发在公众号，最好配一张图。', '现在文章先不用写，只需要一张适合公众号的封面图。'], reference: '用户现在只需要一张公众号封面图。', isDemo: true, approved: false, version: 1, comparisons: [blankPair(1)] };
    state.questions.push(q); state.selectedId = q.id;
    if (await persist(previous, '虚构演示题已保存到私有仓库。请自行审核确认。')) selectView('bank');
  });
  $('question-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const q = current(); if (!q) return;
    const form = event.currentTarget; const title = form.elements.title.value.trim(); const turns = form.elements.turns.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!title || !turns.length) { $('question-form-message').textContent = '请填写标题和至少一轮对话。'; return; }
    const dimension = form.elements.dimension.value; const reference = form.elements.reference.value.trim(); const approved = form.elements.approved.checked;
    const previous = snapshot();
    if (q.title !== title || q.dimension !== dimension || JSON.stringify(q.turns) !== JSON.stringify(turns) || q.reference !== reference) q.version++;
    Object.assign(q, { title, dimension, turns, reference, approved });
    const stored = await persist(previous, '题目已保存到私有 GitHub 仓库。'); render(); $('question-form-message').textContent = stored ? '已在线保存。' : '未保存，请检查连接后重试。';
  });
  $('delete-question').addEventListener('click', async () => {
    const q = current(); if (!q || !confirm('删除 ' + code(q) + ' 及其回答和评分？此操作无法在页面中撤销。')) return;
    const previous = snapshot();
    state.questions = state.questions.filter((item) => item.id !== q.id); state.selectedId = state.questions[0]?.id || null;
    if (await persist(previous, '题目已从私有仓库删除。')) render();
  });
  ['answer-pair-select', 'review-pair-select'].forEach((id) => $(id).addEventListener('change', (event) => {
    const q = current(); if (!q) return;
    selectedPairs.set(q.id, Number(event.target.value));
    render();
  }));
  $('add-pair').addEventListener('click', async () => {
    const q = current(); if (!q) return;
    const previous = snapshot();
    const id = Math.max(0, ...pairs(q).map((item) => item.id)) + 1;
    q.comparisons.push(blankPair(id));
    selectedPairs.set(q.id, id);
    if (await persist(previous, '新对比已保存到私有 GitHub 仓库。')) render();
  });
  $('delete-pair').addEventListener('click', async () => {
    const q = current(); if (!q || pairs(q).length <= 1) return;
    const item = pair(q);
    if (!confirm('删除对比 ' + item.id + ' 及其回答和评分？')) return;
    const previous = snapshot();
    q.comparisons = pairs(q).filter((candidate) => candidate.id !== item.id);
    selectedPairs.set(q.id, q.comparisons[0].id);
    if (await persist(previous, '对比已从私有 GitHub 仓库删除。')) render();
  });
  $('answer-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const q = current(); if (!q) return; const item = pair(q);
    const form = event.currentTarget; const left = { name: form.elements.leftName.value.trim(), text: form.elements.leftText.value.trim() }; const right = { name: form.elements.rightName.value.trim(), text: form.elements.rightText.value.trim() };
    if (!left.name || !right.name || !left.text || !right.text) { $('answer-form-message').textContent = '两边都需要填写模型名称和回答。'; return; }
    if (left.name === right.name) { $('answer-form-message').textContent = '两边请填写不同的模型名称或精确版本。'; return; }
    const duplicate = pairs(q).some((candidate) => candidate.id !== item.id && [candidate.answers.left.name, candidate.answers.right.name].sort().join('\u0000') === [left.name, right.name].sort().join('\u0000'));
    if (duplicate) { $('answer-form-message').textContent = '这两个模型在本题已有一组对比，请选择现有对比。'; return; }
    const previous = snapshot();
    if (JSON.stringify(item.answers) !== JSON.stringify({ left, right })) item.answerRevision++;
    item.answers = { left, right }; const stored = await persist(previous, '两份回答已保存到私有 GitHub 仓库。'); render();
    $('answer-form-message').textContent = stored ? '已在线保存。' : '未保存，请检查连接后重试。';
    if (!stored) return;
    if (q.approved) selectView('review'); else message('回答已录入。请先在题库中确认题目，才能完成正式 GSB。');
  });
  $('gsb-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const q = current(); const item = q && pair(q); if (!ready(q, item)) return;
    const form = event.currentTarget; const choice = form.elements.gsb.value;
    if (!LABELS[choice]) { $('gsb-form-message').textContent = '请选择一档 GSB 结论。'; return; }
    const previous = snapshot();
    item.gsb = { choice, reason: form.elements.reason.value.trim(), questionVersion: q.version, answerRevision: item.answerRevision, savedAt: new Date().toISOString() };
    const stored = await persist(previous, 'GSB 评分已保存到私有 GitHub 仓库，并计入模型结果。'); render(); if (stored) selectView('results');
  });
  $('gsb-form').querySelectorAll('input[name="gsb"]').forEach((input) => input.addEventListener('change', () => {
    const q = current(); const item = q && pair(q); const reason = $('gsb-form').elements.reason;
    if (currentRating(q, item) && input.value !== item.gsb.choice && reason.value === item.gsb.reason) reason.value = '';
  }));
  $('export-button').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ format: 'morgan-intent-bench-v1', exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'morgan-intent-bench-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const owner = form.elements.owner.value.trim();
    const repo = form.elements.repo.value.trim();
    const token = form.elements.token.value.trim();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    $('connect-message').textContent = '正在验证仓库并读取题库…';
    try {
      const loaded = await GitHubStore.connect(owner, repo, token);
      loaded.questions.forEach((q) => { if (!Array.isArray(q.comparisons)) { q.comparisons = [{ id: 1, answers: q.answers || blankPair(1).answers, answerRevision: q.answerRevision || 0, gsb: q.gsb || null }]; delete q.answers; delete q.answerRevision; delete q.gsb; } });
      state = { nextId: Math.max(Number(loaded.nextId) || 1, ...loaded.questions.map((q) => Number(q.id) + 1)), selectedId: loaded.questions[0]?.id || null, questions: loaded.questions };
      form.elements.token.value = '';
      $('connection-label').textContent = owner + '/' + repo;
      $('connect-screen').hidden = true;
      $('workspace').hidden = false;
      $('export-button').hidden = false;
      $('disconnect-button').hidden = false;
      $('connect-message').textContent = '';
      selectView(view);
    } catch (error) {
      GitHubStore.disconnect();
      $('connect-message').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('disconnect-button').addEventListener('click', () => {
    GitHubStore.disconnect();
    state = { nextId: 1, selectedId: null, questions: [] };
    $('workspace').hidden = true;
    $('connect-screen').hidden = false;
    $('export-button').hidden = true;
    $('disconnect-button').hidden = true;
    $('connection-label').textContent = '等待连接 GitHub';
    $('app-message').hidden = true;
  });
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    $('connect-form').elements.token.disabled = true;
    $('connect-form').querySelector('button[type="submit"]').disabled = true;
    $('connect-message').textContent = '当前页面不是 HTTPS，已关闭令牌输入。请从 HTTPS 地址打开评测系统。';
  }
})();
