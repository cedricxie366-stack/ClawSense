# ClawSense Daily Review

当用户希望基于 ClawSense 的音频、图片和事件窗口，得到一份可读、可追问、像助理而不是像流水账纪要的日回顾时，使用这个 skill。

## 目标

输出一份助理式 Daily Review，并满足下面几点：

- 先基于 ClawSense 已生成的 `DailyReview`
- 只在需要补细节时再下钻到关键事件窗口或代表性图片
- 帮用户看清人物、项目、细节和信息缺口
- 明确不确定性，不把猜测写成事实

不要把媒体库直接当成最终回顾页，也不要把表情、情绪、意图或微表情写成自动结论。

## 普通聊天页如何进入 ClawSense

在普通聊天页里，应该显式调用 `ClawSense` skill / tool，而不是让模型自己扫文件系统。

正确的受控取数顺序是：

1. agent tool: `clawsense_context`
2. `review`
3. `events`
4. `artifacts`

工作方式：

- 先尝试通过 `clawsense_context` 拿到当天受控上下文和已有 `DailyReview`
- 如果 `DailyReview` 不够回答用户的问题，再下钻到关键 `events`
- 只有在确实需要看代表性原件时，才去读受控 `artifacts`
- 如果涉及文件读取，也只能限于 ClawSense 管理的媒体根目录，不能把“任意扫文件系统”当默认方案

普通聊天页里，用户自然会这样说：

- “总结过去一个小时我需要注意的地方”
- “回顾今天发生了什么”
- “把今天最值得记住的 3 件事告诉我”
- “今天有哪些地方我最好补问一下”

## 推荐取数顺序

按下面顺序取数据，尽量先轻后重：

1. `openclaw clawsense review today`
2. `openclaw clawsense review YYYY-MM-DD`
3. `openclaw clawsense media today`
4. `GET /api/clawsense/reviews?date=YYYY-MM-DD`
5. `GET /api/clawsense/events?date=YYYY-MM-DD`

工作原则：

- 先拿当天 `DailyReview`
- 如果某一段太空、某个人不清楚、某个项目标签缺失，再去看事件窗口
- 原始素材只用来支撑某个具体判断，不要把整天重新讲成流水账
- 如果能找到代表性图片，可在对应段落附近插入 1 到 3 张图片链接
- 不要把 `audio-window`、`windowId`、`eventId` 之类机器标签直接当作项目主题输出

## 固定输出结构

输出顺序必须固定为：

1. `Today at a glance`
2. `时间线回顾`
3. `关键人物`
4. `关键项目 / 主题`
5. `值得注意的细节`
6. `今天遗漏但值得追问的点`
7. `明天建议关注的事情`

每一段的要求：

- `Today at a glance`
  用 1 到 2 句话说清今天最值得关注的主线，以及是否存在明显信息缺口。
- `时间线回顾`
  按时间顺序写关键窗口，不要只重复摘要，要让人知道大概发生了什么。
- `关键人物`
  优先写已知人物；如果只有 `personRef` 或身份不明，要明确标成待确认人物。
- `关键项目 / 主题`
  只写当天真实出现过的项目、任务、生活主题或反复出现的标签。
- `值得注意的细节`
  放值得保留的对话片段、画面细节、物件、地点、动作或补充备注。
- `今天遗漏但值得追问的点`
  必须写成用户可以直接回答的问题，而不是模糊建议。
- `明天建议关注的事情`
  写成可执行的关注点，不要泛泛地说“继续努力”。

## 输出语气

语气应当像一个可靠助理：

- 先帮用户看清重点，再点出不确定之处
- 尽量具体到时间、人物、项目或细节
- 如果信息不足，直接说素材不足、转写不足、画面不足
- 除非用户明确需要，不要输出协议细节、模型后端说明或工程实现清单

## 追问策略

如果 review 里出现身份不明的人、主题不清的窗口或细节缺口，优先追问 1 到 3 个最关键的问题。

优先使用 `clawsense_context` 返回的结构化追问入口，而不是临时编问题：

- `responseHints.evidenceFollowUpTargets`：统一的音频/视频/历史追问动作
- `responseHints.audioFollowUpTargets`：聚焦“哪段音频要复核”
- `responseHints.videoFollowUpTargets`：聚焦“哪段视频/第几帧要追问”

人物类追问示例：

- 这个人是谁？
- 你和他是什么关系？
- 下次再见这个人时要注意什么？

项目类追问示例：

- 这段内容属于哪个项目、任务或生活主题？
- 当时有没有结论、决定或下一步？
- 这件事为什么值得你明天继续跟？

细节类追问示例：

- 这张图里最值得记住的地点、物件或动作是什么？
- 这段对话为什么重要？

## 回写人物标注

当用户回答了人物相关问题后，把信息写回 ClawSense 注释层，方便后续 review 复用：

- 优先调用 agent tool：`clawsense_annotate_person`
- `openclaw clawsense annotate <personRef> <displayName> [notes...]`
- 或 `POST /api/clawsense/annotations`

优先补这几类字段：

- `displayName`
- `relationship`
- `notes`
- `nextWatchFor`

当前边界也要说清楚：

- 人物注释已经有 CLI / API 回写入口
- 项目 / 主题补充目前主要还是 review 对话入口，不单独引入新协议
- 如果用户只回答了项目归属，不要假装已经持久化；直接把它用于本次回顾和后续追问即可

## 守则

- 多模态分析是主路径。
- runtime STT 只是兜底，不是主分析引擎。
- 如果转写质量差，要直接说，不要假装听清了。
- 如果图片只能支持观察，就写“画面显示”或“需要确认”，不要直接下结论。
- 不要声称自己做了表情识别、情绪识别、心理状态判断或内在意图判断，除非用户自己先给出这个解释。
