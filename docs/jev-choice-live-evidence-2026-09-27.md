# Jev Choice 最小真实请求记录

执行时间及原始脱敏结构见 [JSON 证据](jev-choice-live-evidence-2026-09-27.json)。本记录只证明当前 key、HTTP 合同及一条合成中文 Choice 请求可用，不代表 S3/S4 完整真实链路验收。

在 2026-09-27 复核官方 [API reference](https://docs.typesafe.ai/api.md)、[Models](https://docs.typesafe.ai/models.md) 与 [Confidence](https://docs.typesafe.ai/confidence.md)：端点 `POST https://api.typesafe.ai/v1/systemone`，认证 `Authorization: Bearer <key>`，固定模型 `jev-1.13.0`。请求提供 `state`、`model`、`questions.action={type:"choice",instructions,criteria}`；响应读取 `answers.action.choice/confidence/probabilities`、实际 `model` 和 `usage`。

通过新增的 `chooseWithJev` 适配器，仅运行一次纯合成请求。输入为“讨论任务尚未开场、没有开发授权”，候选为独立开场、立即实施、立即交付。实际返回 `independent-opening`，完整分布为 `1 / 0 / 0`，confidence `1`，实际模型 `jev-1.13.0`，输入 499 tokens、输出 46 tokens，端到端 908 ms。

密钥从本机私有 TOML 读取，没有打印或写入仓库。没有上传用户仓库、真实消息、目录路径或会话；没有运行参与者、建飞书任务、派发消息或修改项目。该 confidence 只描述这次回答的分布集中程度，不能当作中文质量或正确率评估。低置信度、超时、无效响应、取消、受限 pi 后备及回放由单元/运行时集成测试覆盖，未用真实付费请求模拟失败。
