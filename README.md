# Morgan ClawBench · 意图评测工作台

线上入口：[完整评测流程](https://givenwels.github.io/morgantoken-intent-bench/workflow.html)；[旧版手动评分页](https://givenwels.github.io/morgantoken-intent-bench/)。

网页部署在 GitHub Pages，题库、答案和评分保存在独立私有仓库 `Givenwels/morgantoken-bench-data`。登录时输入仅授权该仓库 `Contents: Read and write` 的精细权限令牌。令牌仅保留在当前页面内存，刷新后需要重输；请只从 HTTPS 地址打开。

## 使用顺序

1. 在“题库导入与确认”选择 `.docx`（10 MB 内），检查识别出的题目边界，把草稿保存到私有仓库。逐题编辑多轮对话和最终意图卡，再勾选“已确认”。也可以手动建题。原始 Word 不上传。
2. 在“模型先答”选择题目、模型和来源，创建一次固定运行。已确认题目会按当前版本冻结。导出 Agent 做题包交给自己的平台运行，或在配置 API 后点击后台运行。
3. Agent 平台把答案整理为下面的 JSON，从运行页导入。模型答案进入私有仓库后，网页才开放人工答题。
4. 在“人工独立作答”对同一题完成实际任务。首次提交前网页不显示模型原文。提交后可修订，但旧稿保留。
5. 在“意图核验与 GSB”对人工与各模型答案标注“通过 / 部分通过 / 未通过 / 不可评”，再做模型间四档 GSB（左边好、右边好、一样好、一样差）。报告可下载 Markdown/JSON 或打印。

## Agent 结果格式

运行页会提供带有真实 `runId`、题号、版本和模型 ID 的做题包。输出示例：

```json
{
  "runId": "从做题包复制的运行 ID",
  "answers": [
    {
      "runId": "从做题包复制的运行 ID",
      "questionId": 1,
      "questionVersion": 1,
      "modelId": "deepseek",
      "text": "模型完成用户最终实际任务的原始回答"
    }
  ]
}
```

可选模型 ID：`deepseek`、`glm`、`step`。一次文件须覆盖该运行中每道题与每个已选模型的组合，且每个组合只能出现一次；缺题、重复、版本不符或空答案会在写入前报错。题目材料和模型回答不会提交到公开网页仓库。

## API 直连配置

后台运行器部署在**私有数据仓库**的 GitHub Actions 中，网页通过 `repository_dispatch` 发起任务。为使用直连，在私有仓库 Actions Secrets 为需要的模型设置以下三个字段；每个模型只调用已选择且配置齐全的 provider：

| 模型 ID | Secrets |
| --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL_ID` |
| `glm` | `GLM_API_KEY`、`GLM_BASE_URL`、`GLM_MODEL_ID` |
| `step` | `STEP_API_KEY`、`STEP_BASE_URL`、`STEP_MODEL_ID` |

`BASE_URL` 填兼容 Chat Completions 的接口根地址，实际模型 ID 以你的服务账号为准。没有配置时会记录“待配置”，不会生成假答案；需要改用 Agent 时请新建 Agent 模式运行。不要把密钥写进这个公开仓库或题目文件。

## 指标口径

- 最终意图完成率：人工核验为“通过”的可评题数 / 已核验可评题数。
- GSB 相对比较分：胜 1、负 0、两个平局各 0.5；“一样好”和“一样差”分别展示，不能当作绝对准确率。
- 人机任务结果一致率：同题人工答案与模型答案在人工核验的三档结果相同的题数 / 双方已核验可评题数。双方都答错也算结果一致，因此报告另列“双通过 / 双未通过”。
- AI 判分与人工判分一致率：只有接入独立 AI 评审时才统计，不能和上一个指标混为一谈。

所有统计显示分子和分母。未复核、不可评、调用失败分别展示，不计入质量分母。首批真实题目和 API 密钥由项目所有者之后提供。
