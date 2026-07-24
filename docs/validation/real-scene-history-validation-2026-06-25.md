# ClawSense 真实场景历史素材验收报告

## 目标素材
- 日期：2026-06-25，北京时间。
- 场景：最近 7 天盘点中唯一明确成组的真实素材窗口，主要集中在 09:58-11:16。系统识别为高置信 work/office 场景，包含会议/演示式讨论、环境图片、自动触发短视频和视频关键帧。
- 用户预期：验证历史真实语音、图片、视频是否能支撑“那天发生了什么”“过去 4 小时聊了什么”“会议重点、行动项、风险、待跟进”“人物/speaker 线索”“观看视频/访谈内容”等问题。
- 人工真值：本次线程未获得用户额外标注，因此只做数据存在性、证据链、回答行为和问题分类验收。

## 数据盘点
- events：`scripts/local-openclaw.sh openclaw clawsense media 2026-06-25` 返回 457 个 event，457 个 artifact，1 个设备。
- audio：132 条 audio event，磁盘上 132 个音频文件。media 统计中约 112 条有可读转写/文本摘要，14 条呈现降级/失败迹象。
- image：321 条 image event，磁盘上 321 张图片，321/321 有 summary/caption 类文本。
- video：4 条 video event，磁盘上 4 个视频文件。4/4 的 video event 都是 `video_analysis_disabled_by_mode`。
- keyframe：8 条关键帧以 `image` modality 存在，`note` 带 `videoKeyframe=1`、`keyframe=N`、`videoRequestId=...`，并能在 evidence bundle 中关联回 4 个 video request。
- transcript 覆盖：evidence bundle 显示 `totalAudioWindows=1`、`transcriptReadyWindows=1`、`pendingAudioWindows=0`、`degradedAudioEvents=14`。主窗口为 `09:58-11:15`，转写长度约 18k 字符，`transcriptSpans=12`。
- caption / OCR 覆盖：图片和关键帧有 caption/summary；OCR 为 0。视频 evidence 显示 `groupsWithOcrHints=0`。
- 缺失或降级：18 条降级事件，失败原因包括 `runtime_stt_empty`、`primary_multimodal_error`、`primary_multimodal_input_format_error`、`query_time_asr_empty`、`query_time_asr_low_signal`、`openai_stt_error`、`video_analysis_disabled_by_mode`。
- 媒体库入口：`http://127.0.0.1:18789/plugins/clawsense/library?date=2026-06-25`，公网/LAN URL 为 `http://172.16.6.173:18789/plugins/clawsense/library?date=2026-06-25`。
- followups：`scripts/local-openclaw.sh followups` 返回 today scope 下空数组，没有主动待确认项。
- acceptance：当前 `phaseState=hardening`，进度 40%。音频补强链和视频证据链通过；办公场景、课堂场景、标注和稳定性仍 needs-work。

## 证据摘要
- 音频转写可证明会议/讨论主题包括：数据仓库/阿里云数据来源、跨域访问与安全风险、AI 平台相关功能、根据文本文档/聊天记录生成剧本、语料大小和格式限制、剧本编辑流程、对练方式、智能体/知识点/人设、任务管理与学员指派等。
- 视觉证据多数质量弱：多张图片/关键帧为黑屏、深灰噪点、镜头遮挡或纯色背景；少量关键帧能看到室内天花板、灯具、桌面、笔记本电脑和眼镜。
- 视频证据可回放且有关键帧，但直接视频理解关闭，实际语义来自关联 keyframe caption，不足以回答“访谈视频讲了什么”。
- 人物线索：目标窗口没有已确认 person；系统给出 `speaker_1`、`speaker_2` 两个待标注槽位，时间范围均为 09:58-11:15。全局 speaker 标注主要来自 fixture，不适用于本次真实窗口。

## 问答验收
| 问题 | 期望 | 实际 | 是否引用音频 | 是否引用图片/视频 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 最近 7 天按日期总结真实事件，并说明用了哪些音频、图片、视频证据 | 按日期分组，列出 2026-06-25 的音频、图片、视频证据 | 最终 answer 仍是通用范围摘要：“2026-06-23 22:44 - 2026-06-30 22:44...”，没有按日期组织 | 部分，summary 引用了一段 transcript 开头 | 部分，提到黑屏和 video request | 不通过，回答组装未遵守问题形态 |
| 只总结 2026-06-25，并区分会议、日常环境、观看视频/访谈 | 应聚焦 2026-06-25，区分会议音频、环境图片、视频关键帧，说明无晚上访谈证据 | 最终 answer 仍回到 7 天范围摘要；`responseHints` 能识别 work 场景和 speaker 槽位，但没有进入最终答案 | 证据层可用，最终答案只截取很短开头 | 证据层可用，最终答案没有清楚分组 | 不通过，日期过滤/answer assembly 失败 |
| 2026-06-25 09:58-11:15 会议重点、人物、行动项、风险、待跟进，说明 transcript 是否可用 | 应总结 AI 平台/剧本生成/语料导出/安全风险/后续沟通等，并明确 transcript ready | 证据层给出 12 个 transcript span，但最终 answer 仍是通用范围摘要，未输出重点、行动项、风险 | 是，证据层强可用 | 混入若干视频关键帧，但对会议帮助有限 | 不通过，转写存在但回答没用好 |
| 以 2026-06-25 11:16 为结束时间，总结之前 4 小时聊了什么 | 应只看约 07:16-11:16，实际主要为 09:58-11:15 的对话，输出话题和待跟进 | 最终 answer 仍是 7 天范围摘要；证据层仍能召回同一会议 transcript | 是，证据层强可用 | 是，但最终答案没有区分 | 不通过，历史时间范围解析/回答模板失败 |
| 2026-06-25 晚上观看访谈视频讲了什么 | 若无晚上视频，应明确说没有晚上访谈视频证据；若有，应引用视频/音频 | `--modality video` 只召回上午 10:05、10:20、11:00、11:10 的短视频/关键帧；最终 answer 未明确“晚上访谈素材不存在” | 否，video modality 下 `totalAudioWindows=0` | 是，引用关键帧 caption | 部分通过数据召回，不通过问题回答和缺失说明 |

## 主要问题分类
- 数据缺失：部分成立。2026-06-25 真实办公/会议素材存在；但“晚上观看访谈视频”在最近 7 天 video evidence 中未找到，只看到上午自动触发短视频。应归为该子场景数据不存在、未上传、未同步、未索引或被清理，不能归因为模型不会总结访谈。
- ASR 缺失：部分成立。主会议窗口 transcript ready，足够支撑总结；但仍有 14 条降级 audio event，失败原因含 STT empty/low signal/openai_stt_error。不是主失败原因，但会影响覆盖完整度。
- 检索 / evidence routing：主要问题。多次问题中证据层已召回 transcript、video groups、keyframes，但最终 answer 反复回退到统一 7 天摘要，没有执行“按日期”“只总结目标日”“过去 4 小时”“会议行动项/风险”的问法。命令还出现 `embedding request failed; using deterministic fallback vectors`，语义召回稳定性需要单独排查。
- 显式提问误判：疑似风险，未确认。本次 09:58-11:15 主体是 passive sensing 会议音频，不是 assistant query 目录里的显式提问 wav；当前 evidence 回答没有明显把环境音频标成“用户刚问的问题”，但系统将会议内容直接作为最近可读对话进入回答，仍需要检查 assistant query 与 passive sensing 在 UI 层的边界。
- TTS 截断：未验证。本线程只跑 host-side evidence/CLI，没有手机 UI 长答案朗读数据，不能判定。

## 建议主开发修复顺序
1. 修 answer assembly：当 evidence bundle 已有 `responseHints`、`practicalOutputs`、`transcriptSpans` 时，最终 answer 必须按用户问题输出，而不是只返回默认范围摘要。
2. 修历史时间范围解析：支持目标日期、相对历史窗口和“以某时刻为结束的过去 4 小时”，并在无目标子场景数据时明确说明缺失。
3. 修 transcript 使用：会议类问题应优先用 `transcriptSpans` 生成重点、行动项、风险、待跟进，而不是只取 transcript 开头一句作为任务候选。
4. 修视频/访谈缺失说明：`--modality video` 只召回上午短视频时，应明确“没有找到晚上访谈视频”，同时说明视频直理解关闭、当前只能引用 keyframe caption。
5. 修 embedding/retrieval 配置：处理 `embedding request failed; using deterministic fallback vectors`，避免历史素材问答依赖弱召回 fallback。
6. 补目标窗口 speaker 标注闭环：至少将 `speaker_1`、`speaker_2` 映射到真实人物或待确认角色，减少弱身份猜测。

## 可复现命令
```bash
pwd
git status --short
scripts/local-openclaw.sh env
scripts/local-openclaw.sh devices || true
scripts/local-openclaw.sh acceptance || true
scripts/local-openclaw.sh acceptance-plan || true
scripts/local-openclaw.sh library-url today || true
scripts/local-openclaw.sh library-url 2026-06-25 || true

scripts/local-openclaw.sh openclaw clawsense evidence --lookbackDays 7 --focus what_happened || true
scripts/local-openclaw.sh evidence-video 7 || true
scripts/local-openclaw.sh followups || true
scripts/local-openclaw.sh openclaw clawsense media 2026-06-25 || true

scripts/local-openclaw.sh openclaw clawsense evidence \
  --lookbackDays 7 \
  --focus what_happened \
  --question "请按日期总结最近 7 天 ClawSense 记录到的真实事件，明确说明用了哪些音频、图片和视频证据。" || true

scripts/local-openclaw.sh openclaw clawsense evidence \
  --lookbackDays 7 \
  --focus what_happened \
  --question "请只总结 2026-06-25 这一天发生了什么。请区分会议、日常环境、观看视频/访谈，并说明每部分证据来自音频转写、图片还是视频关键帧。" || true

scripts/local-openclaw.sh openclaw clawsense evidence \
  --lookbackDays 7 \
  --focus meeting \
  --question "请重点回顾 2026-06-25 09:58-11:15 左右那场会议：讨论重点是什么？谁提到了什么？有哪些行动项、风险和待跟进？回答时必须说明音频转写是否可用。" || true

scripts/local-openclaw.sh openclaw clawsense evidence \
  --lookbackDays 7 \
  --focus what_happened \
  --question "以 2026-06-25 11:16 为结束时间，请总结之前 4 小时内聊了什么；请列出主要话题、行动项、风险、待跟进，并说明是否用了音频 transcript。" || true

scripts/local-openclaw.sh openclaw clawsense evidence \
  --lookbackDays 7 \
  --modality video \
  --focus what_happened \
  --question "请回顾 2026-06-25 晚上观看访谈视频的片段：视频大概讲了什么？画面证据是什么？音频转写是否被用上？如果没用上，请明确说明。" || true

scripts/local-openclaw.sh openclaw clawsense annotate-suggestions 2026-06-25 \
  --question "2026-06-25 09:58-11:15 会议里有哪些 speaker/person 需要补标注？" || true
```
