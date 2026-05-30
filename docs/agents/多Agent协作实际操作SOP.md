# ClawSense 多 Agent 协作实际操作 SOP

这份 SOP 不是理念说明，而是你从今天开始就可以照着执行的操作流程。

适用角色：

- 你：项目 owner
- 统筹 agent：负责架构、审查、集成、验收顺序
- 3 个执行 agent：
  - Android / Sensor Agent
  - Backend / Event Intelligence Agent
  - Product Surface / Review Experience Agent

## 0. 先记住一句话

正确流程是：

**执行 agent 做事 -> 你收交付 -> 统筹 agent 先审 -> 再决定你要不要人工验证**

不是：

**执行 agent 做事 -> 你自己立刻全量验证 -> 你自己决定合并**

补充边界：

- 如果任何执行 agent 提议“把当前 ClawSense 数据面整体切换成官方 Android Companion / node 协议”
- 不要直接让它推进
- 先交给统筹 agent 判断

## 1. 每轮协作的标准顺序

每一轮都按下面 7 步走：

1. 你给执行 agent 发“第一条开工消息”
2. 执行 agent 开发并自测
3. 执行 agent 按固定格式给你交付
4. 你把交付原样转给统筹 agent
5. 统筹 agent 先做技术审查
6. 统筹 agent 告诉你：
   - 是否通过
   - 是否需要你现在人工验证
   - 该验证什么
7. 你只做被指定的验证，再把结果反馈给统筹 agent

## 2. 你今天第一步该做什么

### Step 1: 启动 3 个执行 agent

你分别给 3 个执行 agent 发下面两类内容：

- 对应 agent 的开场 prompt
- 第一轮具体任务单里属于它的部分

文件入口：

- 分工说明：
  - `/Users/cedric/Documents/ClawSense/docs/多Agent协作分工说明.md`
- 第一轮任务单：
  - `/Users/cedric/Documents/ClawSense/docs/agents/第一轮具体任务单.md`
- Android agent prompt：
  - `/Users/cedric/Documents/ClawSense/docs/agents/android-sensor-agent-prompt.md`
- Backend agent prompt：
  - `/Users/cedric/Documents/ClawSense/docs/agents/backend-intelligence-agent-prompt.md`
- Review agent prompt：
  - `/Users/cedric/Documents/ClawSense/docs/agents/review-experience-agent-prompt.md`

### Step 2: 给每个 agent 统一补一句规则

你额外再补一句：

```text
请只交付你本轮负责的最小闭环，不要主动修改共享契约文件；如果你认为必须改，请先单独说明原因和影响。
```

## 3. 执行 agent 交付时，必须长什么样

执行 agent 的交付必须包含这 5 项：

1. 本轮目标
2. 实际改动
3. 验证结果
4. 风险 / 未完成项
5. 是否触碰共享契约

如果缺任何一项，你先不要急着找统筹 agent，先让执行 agent 补齐。

## 4. 执行 agent 做完后，你怎么转给统筹 agent

不要自己先总结，不要自己先裁剪。

你直接用这个模板把交付转给统筹 agent：

```text
这是 <Agent 名称> 的本轮交付，请你作为统筹 agent 审查：

<把 agent 原始交付内容完整贴上>

补充信息：
- 当前分支（如果有）：
- 它提到改动的文件：
- 它是否声称触碰共享契约：

请你给我一个明确结论：
1. 可以收，进入人工验证
2. 可以收，但先不要人工验证，等别的 agent
3. 不能收，需要打回补改
4. 需要共享契约审议
```

## 5. 统筹 agent 审查后，你怎么执行

统筹 agent 的返回，只会落在 4 类里：

### A. 可以收，进入人工验证

你这时去做它指定的最小验证。

例如：

- 真机说话 10 秒
- 检查 `openclaw clawsense review today`
- 用当前 OpenClaw 的同一地址打开 `/plugins/clawsense/library`

不要做额外的全量测试。

### B. 可以收，但先不要人工验证，等别的 agent

你这时什么都别测。

原因通常是：

- 当前改动依赖另一个模块先合并
- 现在测也测不出有效信息

这时你只需要继续等其他 agent 交付。

### C. 不能收，需要打回补改

你把统筹 agent 的审查意见原样转回给那个执行 agent。

模板：

```text
统筹 agent 审查结论：当前交付不能收，需要你补改。

审查意见如下：
<把统筹 agent 的意见完整贴上>

请按这些意见修正后，再按原来的 5 段格式重新交付。
```

### D. 需要共享契约审议

这类情况你不要自己判断。

你只需要把统筹 agent 的意见继续交回给相关执行 agent，并明确：

```text
当前问题涉及共享契约，不能直接推进。请只做最小契约调整方案，不要直接重构。
```

## 6. 你什么时候做人工验证

只有在统筹 agent 明确说：

- `现在去验证`

你才去验证。

否则不要验证。

原因：

- 你是最稀缺的人类验证资源
- 你不应该替 3 个执行 agent 做无效劳动

## 7. 你怎么把验证结果反馈回来

你验证完后，用这个模板发给统筹 agent：

```text
这是我对 <Agent 名称 / 任务名称> 的人工验证结果：

验证动作：
1.
2.
3.

验证结果：
- 通过的：
- 不通过的：
- 现象：
- 截图 / 日志（如果有）：

请你判断：
1. 可以合并
2. 需要回到原 agent 修
3. 需要另一个 agent 跟进
```

## 8. 多个 agent 同时完成时，怎么排队

如果多个 agent 同时交付，不要一起乱发。

按这个优先级给统筹 agent：

1. Backend / Event Intelligence Agent
2. Android / Sensor Agent
3. Product Surface / Review Experience Agent

原因：

- Backend 最容易影响共享契约
- Android 依赖 backend 协议稳定
- Product Surface 最适合最后对齐

## 9. 什么时候可以让 agent 互相看对方结果

默认：

**不要让执行 agent 互相直接沟通。**

只有统筹 agent 明确要求时，才允许你把一方的结果转给另一方。

推荐方式也不是“让他们聊天”，而是你转发一段明确结论：

```text
这是统筹 agent 审查后的 backend 输出结论，你只需要按这个结论调整你这边，不需要重新讨论协议：
<结论>
```

## 10. 你今天最推荐的实际启动顺序

### 第一波

同时启动：

- Backend / Event Intelligence Agent
- Android / Sensor Agent

Review / Product Agent 也可以启动，但要求它：

- 第一轮先不要假设后端会改协议
- 先做不依赖协议变化的页面与文档优化

### 第二波

谁先交付，你先把谁交给统筹 agent。

不要等 3 个都做完。

### 第三波

统筹 agent 审查后，再决定：

- 你是否去做人工验证
- 是否打回
- 是否让下一个 agent 跟进

## 11. 你最容易踩的坑

### 坑 1：你自己做技术仲裁

不要自己判断“这个改法好像也行”。

如果涉及：

- 数据结构
- HTTP 接口
- Android 上传协议
- review 输出结构

都先交给统筹 agent。

### 坑 2：过早人工验证

不要每个 agent 一完成，你就立刻真机测、手动测、服务端测一遍。

这会把你拖进重复劳动。

### 坑 3：执行 agent 直接互相对齐

不要让 3 个执行 agent 自己互相商量接口。

这会导致：

- 你最后拿到 3 份互相矛盾的结果

### 坑 4：一次让 agent 做太多

一轮只做“最小闭环”。

不要一轮里同时要求：

- 修稳定性
- 做大 UI
- 改协议
- 写文档
- 做发布

## 12. 统筹 agent 的职责，你可以怎么理解

如果你把我当统筹 agent，那我的职责就是：

- 看执行 agent 的交付是否越界
- 判断它是不是碰了共享契约
- 判断现在值不值得你去验证
- 决定先合谁、后合谁
- 防止整个项目在并行过程中失控

所以你不需要每次都问：

- “我现在该怎么办？”

你只要做两件事：

1. 把 agent 交付原样转给我
2. 按我给你的最小验证动作去验证

## 13. 最后给你的极简版流程

如果你只记得住最短版本，就记这个：

1. 你发任务给执行 agent
2. 执行 agent 交付给你
3. 你把交付发给统筹 agent
4. 统筹 agent 先审
5. 我告诉你该不该验、该不该打回
6. 你只做最小验证
7. 再把结果回给统筹 agent

这就是当前阶段最稳、最省心、最不容易乱的工作流。
