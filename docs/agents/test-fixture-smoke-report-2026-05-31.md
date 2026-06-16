# ClawSense 公开素材 Host Replay 验证报告

生成时间：2026-05-31 16:31（Asia/Shanghai）

## 验证目标

用公开会议 / 课堂 / 课堂视频素材验证当前 ClawSense host 侧产品链路是否能回答：

- `刚才讨论的重点是什么？`
- `过去四个小时我们聊了什么？`
- `刚才老师讲了什么重点？有哪些概念需要复习？`
- `这段视频里老师讲了什么重点？`
- 是否能把音频 transcript、图片/关键帧场景、视频 artifact、follow-up target 和 speaker/person 标注一起放进 evidence，而不是只看图片。

本轮是 **Host replay**，不验证 Android 真机 VAD、上传队列、唤醒词、TTS。

## 素材

### 办公会议：AMI Meeting Corpus

- 来源：[AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/)
- 场景：办公会议 / 产品设计启动会
- 片段：`ES2002a`
- 本地缓存：`.local/test-fixtures/ami-es2002a/`
- 输入：`ES2002a.Mix-Headset.wav`、`instrumented_meeting_room_300.jpg`、AMI manual annotations。
- 复用说明：公开素材的真实媒体保留在 `.local/test-fixtures`，不进入 npm 包。

### 课堂学习：MIT OpenCourseWare

- 来源：[MIT OpenCourseWare 18.085 Lecture 31](https://ocw.mit.edu/courses/18-085-computational-science-and-engineering-i-fall-2008/resources/18-085f08-l31/)
- 场景：课堂 / 数学与工程计算学习
- 片段：Lecture 31 transcript，主题为 fast Fourier transform and convolution。
- 本地缓存：`.local/test-fixtures/mit-18-085-l31/`
- 输入：`transcript.pdf`、`transcript.txt`。
- 复用说明：脚本会在缺失时下载 PDF，并用本地 `PyPDF2` 抽取 transcript。

### 课堂视频：MIT OpenCourseWare / Internet Archive

- 来源：[MIT OCW 18.085 Lecture Videos](https://ocw.mit.edu/courses/18-085-computational-science-and-engineering-i-fall-2008/resources/lecture-videos/) 与 [Internet Archive MIT18.085F08](https://archive.org/details/MIT18.085F08)
- 场景：课堂视频 / 数学与工程计算学习
- 片段：Lecture 31 MP4 + SRT 字幕 + 3 张 derivative thumbnails，主题为 discrete Fourier transform、convolution、cyclic convolution 和 FFT-style computation。
- 本地缓存：`.local/test-fixtures/mit-18-085-l31-video/`
- 输入：`ocw-18.085-f08-lec31_300k.mp4`、`ocw-18.085-f08-lec31_300k.srt`、3 张 `ocw-18.085-f08-lec31_300k_*.jpg` 关键帧。
- 复用说明：真实视频约 118MB，仅保留在 `.local/test-fixtures`，不进入 npm 包。

## 新增回放脚本

```bash
node scripts/replay-ami-fixture.mjs --reset --force
node scripts/replay-mit-lecture-fixture.mjs --reset --force
node scripts/replay-mit-lecture-video-fixture.mjs --reset --force
```

脚本行为：

- AMI 脚本把 `ES2002a` 前 20 分钟人工转写切成 4 个连续音频事件，并加入 1 个会议室图片事件。
- MIT 脚本把 Lecture 31 transcript 前 3200 words 切成 4 个连续课堂音频事件。
- MIT 视频脚本把 Lecture 31 MP4 作为 1 个 video artifact 入库，把 SRT 字幕切成 3 个同 `videoRequestId` 的 audio transcript 事件，并把 3 张公开缩略图作为 keyframe image evidence 入库。
- 三个脚本都写入 repo-local runtime：`.local/openclaw/state`。
- 三个脚本默认幂等：当天已回放同一 fixture 时会跳过；需要重跑时使用 `--reset --force`。
- 幂等跳过时会刷新对应 fixture device heartbeat，避免验收因 fixture 设备心跳过期误报。
- 三个脚本都带 `fixture=...` note marker，便于 reset、evidence 和验收线程定位。

回放后的媒体库基线：

```json
{
  "events": 16,
  "artifacts": 16,
  "devices": 3,
  "amiEvents": 5,
  "mitEvents": 4,
  "mitVideoEvents": 7
}
```

## Rubric / Expected

新增 fixture manifest 与 expected rubric：

```text
fixtures-manifest/ami-es2002a/manifest.json
fixtures-manifest/ami-es2002a/expected.md
fixtures-manifest/mit-18-085-l31/manifest.json
fixtures-manifest/mit-18-085-l31/expected.md
fixtures-manifest/mit-18-085-l31-video/manifest.json
fixtures-manifest/mit-18-085-l31-video/expected.md
```

AMI 期望回答必须覆盖：

- remote-control project kickoff。
- 角色 / 职责线索。
- 25 Euro 售价、约 12.50 Euro 生产成本限制。
- 产品需求或功能点。
- 至少一个 follow-up / uncertainty。

MIT 期望回答必须覆盖：

- convolution。
- Fourier coefficients。
- signal processing / filtering。
- cyclic convolution / FFT / polynomial multiplication 等复习方向。
- 不应虚构作业截止时间、考试日期或学生姓名。

MIT 视频期望回答必须覆盖：

- 这是课堂视频，不只是静态图片。
- 回答必须结合字幕/音频 transcript 与关键帧/OCR。
- 原始 video artifact、关键帧 artifact、`videoRequestId` 聚合、关键帧 offset 回链可见。
- 不应把 `hostModelVideoMode=keyframes` 的 fixture 说成原生视频理解。

## 验证命令

```bash
node scripts/replay-ami-fixture.mjs --reset --force
node scripts/replay-mit-lecture-fixture.mjs --reset --force
node scripts/replay-mit-lecture-video-fixture.mjs --reset --force
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '"keyframes"' --strict-json
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh openclaw clawsense evidence today --focus what_happened --question "刚才讨论的重点是什么？"
scripts/local-openclaw.sh openclaw clawsense evidence today --focus what_happened --question "刚才老师讲了什么重点？有哪些概念需要复习？"
scripts/local-openclaw.sh openclaw clawsense evidence --lookbackDays 7 --modality video --focus what_happened --question "这段视频里老师讲了什么重点？"
scripts/local-openclaw.sh acceptance
npm run check
npm test
npm run check:release
npm run check:phase
```

视频证据诊断刻意使用 `--lookbackDays 7` custom-range，不使用 `evidence today`；这样只验证视频 artifact、关键帧、OCR/caption、transcript 回链，不触发日级 review / consolidation 生成。

报告原始输出缓存于：

```text
.local/test-fixtures/reports/ami-es2002a-*.json
.local/test-fixtures/reports/mit-18-085-l31-*.json
.local/test-fixtures/reports/mit-18-085-l31-video-*.json
.local/test-fixtures/reports/mixed-*.json
.local/test-fixtures/reports/speaker-annotation-smoke.json
```

## 结果

### 通过项

- 媒体库可见：`media-today` 显示公开素材事件、artifact 和 fixture 设备；加入视频 fixture 后基线为 16 个事件、16 个 artifact、3 个 fixture 设备。
- 音频窗口合并正确：AMI 4 个音频事件被合并为 1 个 20 分钟会议窗口，MIT 4 个音频事件被合并为 1 个 20 分钟课堂窗口。
- Evidence 使用了 transcript：`audioCoverage.totalAudioWindows=2`，`transcriptReadyWindows=2`，`pendingAudioWindows=0`。
- 视频 evidence 真通过：`hostModelVideoMode=keyframes` 时 `video-evidence` 仍为 pass，且 `videoModeEnabled=true`、`videoEvents=1`、`keyframeEvents=3`、`videoRequestGroups=1`、`playableVideoArtifacts=1`。
- `modality=video` 查询会带上同一 `videoRequestId` 的音频/字幕 transcript：视频 evidence 返回 `audioCoverage.totalAudioWindows=1`、`transcriptReadyWindows=1`、`transcriptSpans=3`、`videoEvidenceGroups[0].transcriptSpans=3`。
- `刚才讨论的重点是什么？` 能总结会议主线：新型遥控器项目启动、财务目标、国际化销售、功能 brainstorm。
- `过去四个小时我们聊了什么？` 能命中会议窗口，并保留 transcript spans 和 top evidence。
- `刚才老师讲了什么重点？有哪些概念需要复习？` 能抓到卷积、傅里叶系数、信号处理 / filtering、FFT 计算基础。
- `这段视频里老师讲了什么重点？` 能暴露原始 MP4、关键帧、OCR hint、片段内 offset、linked video artifact 和字幕 transcript，避免只看关键帧图像。
- `followups` / evidence follow-up targets 能输出 transcript-ready audio target。
- Speaker 标注烟测通过：AMI `speakerRef` 写入 `Laura (fixture)` 后，后续 evidence 可读到该身份。
- `acceptance` 从 40% / 60% 继续提升到 100%：5 个 criteria 全部通过，`phaseState=ready-to-close`。
- 办公与课堂缺口信号已可识别：办公回答可保留任务/人物/待确认重点，课堂回答可拆出学习点、待确认知识点与发言者线索。
- embedding 404 已改为确定性向量降级提示，不再把 `text-embedding-3-small` / 404 原文打进验收 stderr。
- `npm run check`、`npm test`、`npm run check:release` 均通过；当时全量 197 tests passed，npm pack dry-run 仍为 21 files。
- `npm run check:phase` 已新增并通过：一键覆盖 release gate、Android debug build、AMI/MIT/MIT video replay、AMI speaker annotation smoke、`acceptance 5/5` 和视频 evidence transcript/keyframe 断言。
- SRT 时间戳解析已修复：无毫秒格式 `00:00:01` 会正确转成 `00:01`，不再把公开视频字幕全部显示为 `00:00-00:00`。

### Speaker Annotation Smoke

执行命令由 evidence 的 `annotationSuggestions.speakers[0]` 自动生成：

```bash
scripts/local-openclaw.sh openclaw clawsense annotate-speaker \
  'speaker:audio-session::9bc06f89-790f-4745-8e37-2207cb50526c::ami-es2002a-2026-05-31T07-22-11-655Z:1' \
  'Laura (fixture)' \
  --relationship 'project manager' \
  --notes 'AMI ES2002a speaker annotation smoke; verifies speakerRef persistence and identity history.' \
  --windowId 'audio-session::9bc06f89-790f-4745-8e37-2207cb50526c::ami-es2002a-2026-05-31T07-22-11-655Z'
```

结果：

```json
{
  "ok": true,
  "displayName": "Laura (fixture)",
  "relationship": "project manager"
}
```

验收影响：

```json
{
  "passedCriteria": 5,
  "totalCriteria": 5,
  "progressPct": 100,
  "phaseState": "ready-to-close",
  "office-recap": "pass",
  "school-recap": "pass",
  "audio-reinforcement": "pass",
  "video-evidence": "pass (hostModelVideoMode=keyframes, playableVideoArtifacts=1)",
  "annotation-and-stability": "pass"
}
```

## 未通过 / 缺口

- 这轮没有验证 Android 真实采集、唤醒词、TTS、按键录音边界。
- 这轮使用 AMI / MIT 的公开 transcript，不代表本地 ASR 或模型直接听原始音频的能力已经达标。
- 这轮视频 criterion 已在 `hostModelVideoMode=keyframes` 下通过；但它是 Host replay，不代表 Android 手动 6 秒短视频真机入库已经通过。
- embedding fallback 仍会提示“使用确定性向量降级”；如果要完全静默，需要配置可用 embedding model 或显式设置 `retrievalEmbeddingBackend=none`。

## 本轮结论

三件事已经完成：

- MIT 课堂 transcript fixture replay 已脚本化，AMI 办公会议 replay 保持可复跑。
- MIT 课堂视频 fixture replay 已脚本化，能回放真实 MP4、公开视频关键帧和 SRT transcript。
- AMI / MIT / MIT video expected rubric 已落盘。
- Speaker/person annotation smoke 已跑通，并让 `annotation-and-stability` 通过。

当前 host 侧已经可以在“有可用 transcript 的办公会议 / 课堂素材 / 课堂视频素材”上产出可用回顾，且不会只依赖图片。对当前产品目标而言，这是一个明确的阶段绿灯：只要音频能形成 transcript，OpenClaw 聊天页就可以稳定回答“刚才重点 / 过去几小时聊了什么 / 有什么待跟进 / 老师讲了什么重点 / 这段视频讲了什么”。

下一步不应再继续扩 fixture 数量，而应进入 release 收口与真机验收：

- 按 Batch A-E 拆分 review / commit。
- 真机验证语音对话、TTS、真实 Android 采集、手动 6 秒视频入库。
- 决策是否发布 `clawsense@0.1.0`，以及是否进入自动/连续视频下一阶段。

## 2026-05-31 独立复核补充

验证 agent 后续只读复核确认：

- 本报告记录的 host fixture 结论可复现。
- 当时 `npm test` 仍为 197 tests passed。
- `npm run check:release` 仍通过。
- repo-local `acceptance` 仍为 `5/5 ready-to-close`，且不是通过关闭视频绕过。
- 视频 gate 走 `hostModelVideoMode=keyframes`，有 `playableVideoArtifacts=1`、`videoRequestGroups=1`、`keyframeEvents=3`。
- 视频 evidence query 返回 `audioCoverage.transcriptReadyWindows=1`、`videoEvidenceGroups`、3 段 `transcriptSpans`、caption、OCR hints、`linkedVideoUrl`。
- `npm run check:phase` 把上述复核固化为可复跑门禁；默认记录 `android.connectedDevices`，但不把真机缺失视为 host fixture 失败。

独立复核同时确认一个边界：

> 当前只能证明 host / fixture / release gate 成立；不能替代 Android 真机语音、TTS 和手动视频上传验收。
