# WhiteLily 模型无感热切换设计

日期：2026-08-03
状态：已由用户确认

## 背景与根因

安装版能够从当前 ChatGPT 会话读取实时模型目录，但模型选择存在两套互相冲突的状态：

- `ModelCatalog` 只在子进程内存中保存当前选择。
- 首次设置向导把模型偏好保存在渲染器 `localStorage` 中。
- 主界面的模型页只调用 `select_model`，不会更新向导保存的偏好。
- `ModelCatalog` 把主动选择变化和模型失效都通过同一个 invalidation 信号上报。

因此，用户从 Terra 切换到 Luna 时，选择会短暂成功，随后被误判为 `model_unavailable`。桌面端撤销整个连接并返回首次设置向导；向导再读取旧的 Terra 偏好并覆盖 Luna。

## 目标

1. 模型和推理强度只有一个持久化权威来源。
2. 运行中切换模型立即生效。
3. 切换只重建 AI 会话，不断开 Mineflayer、LAN、世界绑定或主人身份。
4. 新会话未准备好时继续保留旧模型；不得留下半切换状态。
5. 模型页和首页始终显示实际生效的模型。
6. 主动切换模型不得返回首次设置向导。

## 非目标

- 本次不实现按消息自动选择 Luna、Terra 或 Sol 的智能路由。
- 本次不改变 ChatGPT 登录方式、模型目录来源或计费边界。
- 本次不改变游戏动作权限、安全预算或确认规则。

## 架构

### 1. 持久化模型偏好

在子进程数据根目录增加 `ModelPreferenceStore`，使用现有 `DocumentStore` 模式保存选择、文档修订号和 `legacyMigrationCompleted`：

- `mode: "automatic"`；或
- `mode: "explicit"`、`modelId`、`reasoningEffort`。

`ModelCatalog` 负责读取、验证和更新该文档。首次设置向导和主模型页都只通过桌面协议访问 `ModelCatalog`，不再把模型偏好作为渲染器本地权威。

升级后的首次 UI 加载可以把旧 `localStorage` 偏好作为迁移候选提交给后端。后端只在 `legacyMigrationCompleted` 为 false 且尚无用户提交记录时接受该候选，并按以下顺序确定初始值：有效的旧 UI 偏好、有效的 legacy config 偏好、自动选择。随后原子写入迁移完成标记。以后任何旧 `localStorage` 都不能覆盖后端选择。

迁移成功后，`localStorage` 仅保留语言与向导进度提示；模型偏好字段被删除。

### 2. 区分选择变化与权威失效

把当前统一的模型 invalidation 拆成两种事件：

- `selection_changed`：用户主动选择了另一个有效模型，不撤销连接权威。
- `selection_invalidated`：已选模型或推理强度从实时目录消失，或 ChatGPT 认证失效。

只有真正失效才进入故障处理。主动切换不得发送 `connection_invalidated` 或 `model_unavailable`。

### 3. 运行时模型切换

为桌面运行时增加明确的 `switchModel(selection)` 边界。它只管理 Companion/Codex 会话，不重建 Minecraft 连接。

切换过程：

1. 对实时模型目录验证并解析目标 `modelId` 和 `reasoningEffort`；自动选择也必须解析为一个当时可用的具体模型。
2. 序列化模型切换请求，拒绝并发提交造成的旧结果覆盖新结果。
3. 若有正在执行的 AI 任务，以 `model_changed` 原因停止该任务并撤销其工具租约。
4. 在现有 Codex app-server 会话中，用新模型创建并验证新的聊天线程和任务线程。
5. 新线程准备成功后持久化选择。
6. 原子替换 Companion 使用的线程与实际模型字段。
7. 关闭旧线程并发布模型已更新的运行时事件。

Mineflayer、MCP 动作服务器、当前 LAN、世界绑定、主人身份、记忆范围和安全配置在整个过程中保持不变。

### 4. UI 行为

模型页提交后进入“正在切换”状态并禁用重复提交。成功时显示“已切换到 {model} · {effort}”；首页模型卡随运行时事件更新。

模型页展示的选中项来自后端确认结果，而不是尚未提交的草稿。应用失败时恢复显示旧的实际模型并给出可重试错误。

## 失败与回滚

- 实时目录验证失败：不停止任务、不修改持久化状态。
- 新线程创建失败：关闭已创建的新线程，保留旧线程和旧偏好。
- 持久化失败：关闭新线程，继续使用旧模型。
- 旧线程关闭失败：新模型已经成为唯一活动权威；记录脱敏诊断并异步清理旧线程，不能回退到双活动状态。
- 已选模型后来消失：停止 AI 任务和线程，但保留 Minecraft/LAN；模型页要求重新选择，不能把用户送回完整首次设置向导。
- ChatGPT 登录失效：停止 AI 能力并进入登录恢复流程，但仍不伪装为 Minecraft 连接失效。

## 测试设计

### 单元测试

- 模型偏好文档的默认值、迁移、修订冲突和非法值拒绝。
- `selection_changed` 不触发连接 invalidation。
- `selection_invalidated` 保持故障关闭行为。
- 新线程或持久化失败时保留旧模型。

### 集成测试

- 从运行中的 Terra 切换到 Luna，Minecraft session id、LAN authority 和 world binding 均不变化。
- 活动任务先停止且旧工具租约失效，然后新模型线程接管。
- 设置页选择在子进程重启和应用重启后仍保留。
- 首次向导与模型页读取同一选择，旧 `localStorage` 不能覆盖后端值。
- 连续快速选择时最终只应用最后一个有效意图。

### 桌面与安装版验收

1. 连接本地 Minecraft 1.21.5 LAN 世界。
2. 首页确认当前模型为 Terra。
3. 在模型页选择 Luna 并应用。
4. 界面不跳转，机器人不退出世界，首页更新为 Luna。
5. 重启 WhiteLily 后仍为 Luna。
6. 切回 Terra，重复验证。

## 完成标准

- 主动切换不会产生 `connection_invalidated`。
- 运行中模型切换不改变 Minecraft session id。
- 模型选择能跨子进程和应用重启保持。
- 失败场景全部回滚到唯一、可用的旧模型。
- 相关单元、集成、桌面和安装版冒烟测试通过。
