# ClawSense Context

当用户在普通聊天里希望直接调用 ClawSense 的事件索引、Daily Review 和受控原件能力时，使用这个 skill。

典型问题包括：

- “总结过去一个小时我需要注意的地方”
- “回顾今天发生了什么”
- “最近有没有值得我回看的图片或对话”

## 取数入口

优先使用下面这些受控入口，不要让模型自己猜文件系统：

1. agent tool: `clawsense_context`
2. `openclaw clawsense context last-hour`
3. `openclaw clawsense context today`
4. `openclaw clawsense context YYYY-MM-DD`
5. `GET /api/clawsense/context?scope=last-hour`
6. `GET /api/clawsense/context?scope=today&date=YYYY-MM-DD`
7. `GET /api/clawsense/reviews?date=YYYY-MM-DD`
8. `GET /api/clawsense/events?date=YYYY-MM-DD`

普通聊天页里，如果 tool 可用，优先直接调用 `clawsense_context`。CLI / HTTP 只作为兜底。

只有在上下文里已经给出 artifact URL 或明确需要核对某个原件时，才继续读取原件。

## 数据边界

- 允许读取 `DailyReview`
- 允许读取 `CaptureEvent` / 事件窗口 / 人物注释
- 允许读取 ClawSense 管理的 artifact 元数据与 URL
- 如果必须读文件，只能限于 `~/.openclaw/plugins/clawsense/media/...`
- 不要把普通聊天变成“任意读宿主文件系统”

## 回答策略

- 先用 `context` 的 `summary` 和 `review`
- 再看 `windows`
- 最后只在必要时引用 `highlights.recentImages` 或 `highlights.recentConversations`
- 如果看到 `analysisStatus=degraded` 或 `analysisFailureReason`，要诚实说明素材质量限制
- 不要把 `windowId`、`audio-window`、`eventId` 直接当成人话结论输出

## 针对问题的最小路径

### 过去一个小时

- 先取 `openclaw clawsense context last-hour`
- 优先用 `summary`
- 再从 `highlights.recentConversations` 和 `recentImages` 补 2 到 4 个最值得注意的点

### 回顾今天

- 先取 `openclaw clawsense context today`
- 如果 `review` 存在，直接以 `review.sections` 为主
- 如果 `review` 太空，再下钻 `windows`

### 值得回看的图片或对话

- 先看 `highlights.recentImages`
- 再看 `highlights.recentConversations`
- 说明为什么值得回看，并附上 artifact URL

## 守则

- 多模态是主路径，runtime STT 是兜底
- 如果图片摘要或音频转写失败，要明确说“素材不足”或“当前只拿到降级摘要”
- 不要编造人物身份、项目归属、情绪或意图
- 如果用户已经说明某个 `personRef` 是谁，优先调用 `clawsense_annotate_person` 回写，避免下次还重复追问同一个人
