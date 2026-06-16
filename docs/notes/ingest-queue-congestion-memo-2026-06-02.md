# ClawSense ingest 队列拥堵备忘录（2026-06-02）

## 背景

本次发生在本机局域网 OpenClaw 场景：

- 手机与 Mac 在同一局域网。
- ClawSense `publicBaseUrl` 已从 `127.0.0.1` 切换为 `http://172.16.4.71:18789`。
- Gateway 已确认监听 `*:18789`。
- 手机端可以上传音频和图片，不是配对或网络不可达问题。

用户截图显示：

> 图片上传遇到拥堵，已加入补传队列（服务端队列深度 24），预计 8s 后重试。待补传 6 条。

## 现场只读排查结果

执行：

```bash
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh openclaw gateway status --json
lsof -nP -iTCP:18789 -sTCP:LISTEN
curl -sS -m 3 -o /dev/null -w '%{http_code}\n' http://172.16.4.71:18789/api/clawsense/pair
```

结论：

- Gateway 正常运行。
- `18789` 正常监听 LAN。
- Pair endpoint 返回 `405`，说明路由活着，只是 GET 方法不匹配。
- 当天 `media-today` 中已有手机上传的音频事件与 artifacts。
- 所以不是“需要重新配对”，而是服务端 ingest 后续处理变慢。

## 关键证据

当天落库音频事件中，多条 summary 为：

```text
Audio captured, but primary multimodal audio analysis timed out.
```

近期 gateway log 中出现：

```text
2026-06-02T06:42:36.015Z [gateway] [clawsense] runtime STT produced empty transcript; trying primary multimodal audio understanding
2026-06-02T06:44:47.779Z [gateway] [clawsense] primary multimodal audio understanding returned no reliable summary; trying compatible ASR fallback
2026-06-02T06:45:20.668Z [gateway] [clawsense] compatible ASR fallback produced no reliable transcript (runtime_stt_empty|primary_multimodal_timeout|openai_stt_timeout); storing degraded audio summary
```

这说明单条音频处理可能占用约 2-3 分钟。

之后又出现：

```text
2026-06-02T06:48:43.551Z [gateway] [clawsense] evicted older queued visual ingest to admit audio requestId=... evicted=... queueDepth=24
2026-06-02T06:49:13.143Z [gateway] [clawsense] evicted older queued visual ingest to admit audio requestId=... evicted=... queueDepth=24
2026-06-02T06:55:49.576Z [gateway] [clawsense] evicted older queued visual ingest to admit audio requestId=... evicted=... queueDepth=24
```

手机 UI 同步显示服务端队列深度 `24`，与日志一致。

## 判断

这是典型的：

```text
手机采集/上传速度 > 服务端同步分析速度
```

尤其音频 ingest 目前会进入较重链路：

```text
runtime STT -> primary multimodal audio -> compatible ASR fallback
```

当 runtime STT 为空，后续 primary multimodal 和 fallback 都超时时，一条音频会长时间占住 ingest worker，导致：

- 图片请求排队；
- 新音频继续进入；
- 队列深度升到 24；
- 服务端返回 `503 ingest_queue_full`；
- Android 客户端进入补传队列。

所以用户看到的“拥堵”不是坏事本身，它说明背压机制生效了；但当前背压触发太频繁，影响产品体验。

## 临时操作建议

给用户的即时建议：

1. 不用重新配对。
2. 先在手机端点“停止服务”，暂停持续采集。
3. 等服务端消化 1-3 分钟后再启动。
4. 如果需要快速恢复，可重启 gateway，但会丢弃当前服务端内存队列；手机端待补传项通常会重新补传。

## 给主线程的修复建议

### P0：ingest 先落库，分析异步化

当前最核心的问题是：上传请求不应等待完整 ASR/多模态分析完成。

建议改成：

```text
HTTP upload -> 保存 artifact + 创建 pending event/window -> 立即返回 200/202
后台 analysis worker -> 慢慢补 transcript/summary/status
```

这样即使 ASR 或多模态模型超时，也不会阻塞图片/音频继续上传。

### P0：拆分上传队列与分析队列

现在的拥堵看起来像 ingest 队列同时承担了接收与分析。

建议拆成：

- `ingestQueue`：只负责写 artifact/state，必须很快。
- `analysisQueue`：负责 ASR、caption、OCR、LLM summary，可慢、可重试、可降级。

### P0：音频分析 timeout 降级策略

当前音频链路超时太长。

建议：

- runtime STT empty 后，不要每条都同步打 primary multimodal audio。
- 对低信号音频（`peakRms` 低、`voicedMs` 少）先标记 `pending/low_signal`，交给 late recheck。
- 给 primary multimodal audio 和 ASR fallback 设置更短超时，超时后直接 pending，不阻塞 ingest。

### P1：图片优先保证 recent context

在实时助手阶段，图片 caption/OCR 对“我现在看到什么”很重要。

建议在拥堵时：

- 不要让音频长期挤掉视觉 ingest。
- 可保留当前 coalesce 视觉帧策略，但至少保证最近 1-2 张图片快速落库。

### P1：增加队列状态可观测性

建议 CLI / API 暴露：

```text
openclaw clawsense queue-status
```

或 HTTP endpoint：

```text
/api/clawsense/queue/status
```

至少返回：

- ingest queue depth
- analysis queue depth
- current processing modality
- oldest queued age
- recent timeout count
- recent 503 count

Android 端也可以把“服务端正在分析拥堵”和“网络失败”区分显示。

### P2：自适应采集节流

当服务端返回队列拥堵时，客户端可以临时降频：

- 图片定格拍照间隔加长；
- 音频 clip 合并更长窗口；
- 暂停低信号音频上传；
- 等 queue depth 恢复再恢复正常采集。

## 与当前产品目标的关系

这个问题直接影响“带着旧手机上班，全天候记录和回顾”的可用性。

短期必须保证：

- 上传通道不能被 ASR 卡死；
- 证据先稳定落库；
- 分析可以稍后补齐。

否则用户会频繁看到“待补传”和“拥堵”，并误以为配对或网络坏了。

## 建议主线程下一步

优先实现：

1. Ingest 快速落库 + 分析异步化。
2. 上传队列和分析队列拆分。
3. 音频 timeout 降级为 pending late recheck。
4. 增加 queue-status 可观测性，便于验证和解释。
