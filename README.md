# Morgan 意图评测工作台

线上地址：https://givenwels.github.io/morgantoken-intent-bench/

这是 GitHub Pages 静态页面。题目、模型回答、人工 GSB 评分存于独立私有仓库 `Givenwels/morgantoken-bench-data`，路径为 `intent-benchmark/state.json`。页面要求输入仅授权该仓库 `Contents: Read and write` 的精细权限令牌；令牌只存在当前页面内存，刷新后需要重输。

当前支持：在线建题和审核、同题多组模型回答与四档 GSB、模型及能力维度结果、JSON 导出。模型 API 与人机一致性分析留待后续迭代。这里没有预置用户题库，也没有提交 API Key 或令牌。
Morgan intent evaluation workspace
