# Intent Evaluation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 GitHub Pages 网站完成 `.docx` 建题、模型先答、人工独立答题、意图核验、四档 GSB 和可下载报告，并预留安全的模型 API 运行入口。

**Architecture:** 保留现有 `index.html` 与 `intent-benchmark/state.json`，新增 `workflow.html` 作为完整评测流程；共用同一私有数据仓库，按运行 ID 将冻结题目、答案和评分分文件保存。浏览器仅保存用户 PAT，Actions Secrets 保存模型密钥，Agent 平台结果通过同一答案格式导入。

**Tech Stack:** 原生 HTML/CSS/JavaScript、同源固定版本 Mammoth 浏览器包、GitHub REST Contents/`repository_dispatch`、GitHub Actions、Python 标准库、Node 内建测试。

---

## File map

- `workflow.html`, `workflow.css`, `workflow-app.js`: 新评测工作台和交互，不改旧评分页的行为。
- `workflow-core.js`: 冻结运行、答案校验、意图核验、GSB 与报告纯函数。
- `word-import.js`, `vendor/mammoth.browser.min.js`: `.docx` 文字读取、题目切分和导入告警；库文件从锁定版本构建，不从第三方 CDN 运行。
- `workflow-store.js`: 连接私有仓库、逐文件 JSON 读写、SHA 冲突与 `repository_dispatch`。
- `tests/*.test.js`: 纯函数和导入边界测试，使用 Node 内建测试。
- `README.md`, `index.html`: 入口和使用说明。
- 私有仓库 `Givenwels/morgantoken-bench-data`：`.github/workflows/intent-run.yml`、`scripts/run_models.py`，仅包含配置名，不提交密钥。

## Task 1: Pure workflow schema and metrics

- [ ] Create `workflow-core.js` with UMD exports `createRun(questions, models, id, now)`, `validateImportedAnswers(run, payload)`, `buildComparisons(run, answers)`, `summarizeReport(run, answers, humanAnswers, intentReviews, gsbRatings)`.
- [ ] `createRun` accepts only approved questions, stores `{id,version,title,dimension,turns,reference,source}` snapshots and returns `{format:'morgan-intent-run-v1',id,createdAt,questions,models,status:'draft'}`. A model response key is `questionId + ':' + questionVersion + ':' + modelId`.
- [ ] `validateImportedAnswers` rejects unknown run/question/model/version, duplicate answer keys and blank text; reports all validation errors before any save. Accepted answers use `{runId,questionId,questionVersion,modelId,text,source:'agent-import',attempt:1,createdAt}`.
- [ ] `buildComparisons` emits each unordered model pair exactly once per question from one fixed answer per model; stores stable left/right mapping. Human comparisons use a separate `kind:'model-human'` and never enter the model leaderboard.
- [ ] `summarizeReport` computes GSB relative points (`win=1`, `loss=0`, both ties `=.5` but split categories), model intent pass rate, task-result agreement, call success and all denominators. Ignore stale ratings and unreviewed / unassessable items in quality denominators.
- [ ] Create `tests/workflow-core.test.js` with fixtures for 3 models × 2 questions; assert 3 pairs per question, invalid imports reject, dual failures still appear in agreement breakdown, `both_bad` is separate from `both_good`, and stale question versions do not score. Run `node --test tests/workflow-core.test.js` expecting pass; commit task files.

## Task 2: Word import

- [ ] Pin Mammoth in `package.json`/`package-lock.json` and copy the browser bundle to `vendor/mammoth.browser.min.js`; no network loaded by the published page.
- [ ] Create `word-import.js` exports `parseQuestionText(rawText)` and `readDocx(file)`. `readDocx` accepts `.docx` up to 10 MB, reads `file.arrayBuffer()`, calls `mammoth.extractRawText`, and returns parsed drafts and warnings. Display text via `textContent` only.
- [ ] `parseQuestionText` recognizes explicit `【第N题】` and `第N题` headings and circled-number rounds; if no heading, produce one draft with a warning. Flag duplicate/missing heading numbers, missing rounds, and likely image/table/attachment references; every draft starts `approved:false`.
- [ ] Create `tests/word-import.test.js` for a three-question string with a first unnumbered group, Chinese round markers, duplicate headings and a one-question fallback. Run `node --test tests/word-import.test.js` expecting pass; commit task files.

## Task 3: GitHub run storage and Agent import UI

- [ ] Create `workflow-store.js` with `connect(owner,repo,token)`, `readJson(path)`, `writeJson(path,data,expectedSha)`, `dispatchRun(runId)`, `disconnect()`. Use `https://api.github.com/repos/{owner}/{repo}` and fine-grained PAT Contents read/write; reject public data repo. For a missing JSON return `null`, for a SHA conflict show a reload instruction.
- [ ] Add `workflow.html` and `workflow.css`: private repository connection, navigation `题库 / 运行 / 人工答题 / 复核 / 报告`, `.docx` import preview with editable drafts, manual question edit, run creation from approved questions, downloadable Agent request JSON, Agent answer JSON import with validation errors and status.
- [ ] `workflow-app.js` persists imported questions into legacy `intent-benchmark/state.json` after preview confirmation. Save each frozen run at `intent-benchmark/runs/{runId}/request.json`; answers at `.../answers/{questionId}-{modelId}.json`. Agent import checks *all* records before writing any file and records partial save errors.
- [ ] Update `index.html` with a clear link to `workflow.html`, retain legacy page. Run local HTTP preview, connect only to an isolated test private repository or use mocked `fetch`, confirm zero data is published in the public repo; commit task files.

## Task 4: Human answer, review, GSB and report UI

- [ ] In `workflow-app.js`, unlock human answer form only after model answers exist; show only question turns until human answer is submitted. Save `human/{questionId}/revision-{n}.json`; subsequent edit creates a new revision and never overwrites original.
- [ ] After submission, show intent card and machine answers. Capture `通过 / 部分通过 / 未通过 / 不可评` for the human and each model with per-requirement evidence, saved under `reviews/`; capture four-way GSB and reason under `ratings/`, with selected answer IDs and source.
- [ ] Show report in `workflow.html` with denominator text and separate cards for API success, intent pass, GSB, human-machine task-result agreement, and optional AI-judge agreement. Export Markdown and JSON plus print CSS. Include run ID, question versions and excluded item counts.
- [ ] Verify with synthetic two-question data: no model answer visible before human submit; ratings invalidate when selected answer/revision changes; report recomputes from saved records after reload; commit task files.

## Task 5: API automation in private repository

- [ ] Clone private data repository to a separate checkout. Add `.github/workflows/intent-run.yml` on its `main` branch, triggered only by `repository_dispatch` type `intent_benchmark_run`, with `permissions: contents: write` and `client_payload.run_id` as the only runtime input.
- [ ] Add `scripts/run_models.py`: validate run ID and frozen request; map only configured model IDs to environment secret keys and endpoint/model variables; send full multi-turn question as one user task asking the model to complete the latest valid request; never include reference/intent card. Use bounded timeout and max retries; write success/error attempt JSON without logging credentials or response text.
- [ ] Configure workflow to commit per-answer files and rebase before pushing; do not mark a provider as successful if its key/config is missing. Keep API URLs and exact model IDs configurable because provider accounts may differ.
- [ ] Add Python tests with stubbed transport for success, missing key, timeout, invalid run ID, and no intent-card leakage. Run tests locally, push workflow to private repo, trigger one fake provider run only; inspect saved status. Real API calls wait until user configures secrets.

## Task 6: End-to-end verification and release

- [ ] Run all Node and Python tests; use a generated fictional `.docx` through local browser preview. Verify import/edit/approve → run → Agent answer import → blind human answer → review/GSB → report export and reload persistence.
- [ ] Check public files contain no PAT, model secret, real question or model output. Inspect `git diff --check`, site console and network requests; verify the private repo remains private.
- [ ] Commit only intended files, push the `gh-pages` branch, verify `https://givenwels.github.io/morgantoken-intent-bench/workflow.html` over HTTPS. Update README with API secret names and Agent JSON example; report what is live and what needs the user's API credentials.
