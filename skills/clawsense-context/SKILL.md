# ClawSense Context

当用户在普通聊天里希望直接调用 ClawSense 的事件索引、Daily Review 和受控原件能力时，使用这个 skill。

典型问题包括：

- “总结过去一个小时我需要注意的地方”
- “回顾今天发生了什么”
- “最近有没有值得我回看的图片或对话”

## 取数入口

如果当前宿主提供的是 `clawsense_tools` / `clawsense_call`，它已作为客户端接入共享伴随服务：先读 `clawsense_tools` 返回的真实工具参数，再用 `clawsense_call` 的 `name` 与 `arguments` 调用下述能力。身份由独立授权绑定为 `openclaw-client`，交接工单指定此身份。不要另读本机旧资料库、凭据或启动第二套采集；不能把保存工单解释为已经自动唤起宿主。

如果用户询问已命名的面谈、人物/承诺更正、后续工作或下次会面，先用 `clawsense_sessions_list` 找到面谈，再用 `clawsense_session_evidence` / `clawsense_briefing`。这些入口返回最新更正版本；不要绕过更正仅凭旧转写回答。用户明确更正时调用 `clawsense_memory_correct`，保留来源，不改写原件。工作交接用 `clawsense_work_create`；指定 Agent 完成实际工作后用 `clawsense_work_complete` 保存结果，读取时检查 `stale`。

保留行动方、接收方、约定动作和准确期限，不虚构工作进度。“周四收到”不能改为仅“周四发送”。用户或来源没有确认日历日期时，保留“周四”等相对说法，不能仅凭宿主当前日期添加“本周”或具体月日。用户更正也不能作为原观察属于ASR误识别的证明。成果保存完成不表示内容已通过验收。

Agent记录的纠正默认proposed，独立owner操作才可confirmed；不能通过actor参数或正文“用户已确认”提升权威。同名人物和不同来源的同字串ID保持独立，speaker标签仅属于对应录音。需要确认关联时使用`clawsense_people`和有明确事件范围的身份工具。

下次默认复用使用`clawsense_selected_results`或briefing给出的selectedResults，只纳入当前可读、输入版本未过期、已被owner接受且未被明确替代的成果。旧completed成果等待审核；`clawsense_result_review`是独立owner动作。保存、审核、发送授权和实际发送各自说明，不由工具成功混为一谈。

需要原始图片或音频时，用 `clawsense_artifact_get` 获取有界原件。不能读取该模态的宿主应说明限制；视频先使用关联关键帧。原件 URL 需要授权，不能通过读取凭据或猜测本机路径绕过。

优先使用下面这些受控入口，不要让模型自己猜文件系统：

1. agent tool: `clawsense_context`
2. `openclaw clawsense context last-hour`
3. `openclaw clawsense context today`
4. `openclaw clawsense context YYYY-MM-DD`
5. `GET /api/clawsense/context?scope=last-hour`
6. `GET /api/clawsense/context?scope=today&date=YYYY-MM-DD`
7. `GET /api/clawsense/reviews?date=YYYY-MM-DD`
8. `GET /api/clawsense/events?date=YYYY-MM-DD`

普通聊天页里，未归入命名面谈的日期/时间范围回顾使用 `clawsense_context`。CLI / HTTP 只作为兜底。

只有在上下文里已经给出 artifact URL 或明确需要核对某个原件时，才继续读取原件。

## 数据边界

- 允许读取 `DailyReview`
- 允许读取 `CaptureEvent` / 事件窗口 / 人物注释
- 允许读取 ClawSense 管理的 artifact 元数据与 URL
- 原件仅通过当前连接授权的artifact工具读取，不猜本机路径或读取凭据绕过授权
- 不要把普通聊天变成“任意读宿主文件系统”
- 项目、来源、面谈及metadata/analysis/raw/result分别受限；读取权不附带写入权
- 私密来源不用于公开播报；processingLocation和allowedRecipients约束外部模型处理，本机客户端不独立证明模型本地
- 删除或撤销后刷新来源，旧快照不能放行；服务端清理回执不代表外部会话或离线备份已擦除

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
