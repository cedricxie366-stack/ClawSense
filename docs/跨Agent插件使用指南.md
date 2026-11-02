# ClawSense 跨 Agent 插件使用指南

当前为源码预览版本：手机、独立伴随服务和 Agent 通过同一份证据与更正协作。既有 OpenClaw 安装可继续使用；其它 Agent 不需要额外安装 OpenClaw。

开发顺序以[总体执行计划](./产品演进路线与执行计划.md)为准：H负责真实宿主执行，I/N负责P2主手机数字输入与随身记忆，K负责逐宿主安装/升级/分发。默认先完成DSH和Codex的实际回路，其余宿主继续按支持矩阵验收；主手机基础功能不依赖手表。下方已实现的命令与按日期记录的验收范围各自保留。

2026-10-14：共同上下文G2已接入，原件、分析、纠正、审核和默认复用分层。需要办公项目隔离时使用`--context-project`、`--context-source`、`--context-operation`及独立写入能力生成新连接；原可信个人整库连接保留legacy权限，不自动变成项目隔离。人物同名不合并，completed稿等待owner审核，`clawsense_selected_results`只选当前已接受稿。配置、处理范围及迁移命令见[G2实现与使用](./G2统一上下文实现与使用.md)，实际检查见[G2验收](./validation/g2-unified-2026-10-14.md)。后文带日期的旧验收状态按当时记录理解。

## 启动与手机配对

需要 Node.js 22.12 或更高版本。在仓库中执行：

```bash
npm install
npm run build
node dist/src/cli.js start --lan --local-asr
node dist/src/cli.js open
```

`start` 后台启动服务，`open` 用一次性本机登录码打开面谈工作台。点“连接手机”获取临时配对码，手机使用现有 Android 客户端完成配对并明确启动采集。

- 默认端口为 `18790`，不会占用本项目 OpenClaw 的 `18789`。
- 若本机端点被其他监听器占用，启动会拒绝该端口；可指定另一个端口，例如 `--port 19490`，之后继续使用相同状态目录。
- 默认状态目录是 `~/.clawsense`；可用 `--state-dir` 指定另一个目录，之后各命令使用相同目录。
- `--lan` 选择本机私有 IPv4 地址。多网卡时使用 `--public-url http://正确地址:18790`；防火墙和手机网络仍需允许连接。
- 不加 `--lan` 时仅监听本机，手机不能从另一台设备访问。
- 本机工作台只在 loopback 地址登录；手机使用独立设备凭据。
- `serve` 是前台运行方式。`start` 不是系统开机启动注册器。
- 宿主与手机断连时，Android 私有补传缓存最多 6 条、64MiB；超限会明确丢弃最旧素材，不能承诺无限离线记录。

## 接入 Agent

源码方式示例：

```bash
node dist/src/cli.js connect codex --apply
node dist/src/cli.js connect claude-code --apply
node dist/src/cli.js connect pi --apply
node dist/src/cli.js connect opencode --apply
```

每次连接签发独立凭据，明文只保存在权限受限的 token 文件中，配置只引用文件路径。凭据目前允许访问本人的整份 ClawSense 素材库，尚不是按单次面谈划分权限。

`--apply` 对上述四种已知格式安全合并 MCP 配置，保留其它设置并备份；如配置复杂或存在未受管理的同名项，会明确拒绝。生成包内还有技能和原生插件，按输出指引导入；仅配置 MCP 不代表技能已安装。

其它入口生成包：

```bash
node dist/src/cli.js connect workbuddy
node dist/src/cli.js connect trae
node dist/src/cli.js connect qwenwork
node dist/src/cli.js connect doubao-work
node dist/src/cli.js connect openclaw
node dist/src/cli.js connect dsh
```

TRAE 包含官方格式的安装链接；WorkBuddy、千问办公按原生导入指引操作。豆包工作提供 HTTP 模板，仍需可达的 HTTPS 地址、凭据导入和实际连接验证。没有实现通用 OAuth 托管或绕过平台审核。

OpenClaw 可接入与其它 Agent 相同的伴随服务。先安装当前版本的原生 ClawSense 插件，再将生成的 `openclaw.json` 中 `companionUrl`、`companionTokenFile` 合并到目标运行环境的 `plugins.entries.clawsense.config`，重启 OpenClaw。这是配置片段，不能直接覆盖整个配置文件，当前也不自动修改全局 OpenClaw 设置。

此模式提供 `clawsense_tools`（查询最新工具及参数）和 `clawsense_call`（用 `name`、`arguments` 调用），由伴随服务保存证据、更正与成果。手机配对到伴随服务；OpenClaw 不再另启采集服务，其授权身份为 `openclaw-client`，交接工单应指定这个身份。两项连接配置都未设置时，原 OpenClaw 配对、采集和 CLI 入口仍保留。切换模式前停止旧采集；两种服务不能同时写同一个状态目录。停止或取消网络等待不表示已经撤回服务端接受的写入。

DSH 生成 Cordis 增量配置，使用 `@deepseek-ai/dsh-mcp-client` 连接工具；在所选 profile 启动时通过 `--patch /生成目录/cordis.patch.yml` 加载，不覆盖已有 profile，也不自动设置模型或密钥。工具名称带 `mcp__clawsense__` 前缀。独立DSH已使用获准GLM网关完成真实杯子原图及限定跨宿主工作案例；图像附件通过不能外推原生音频或所有模型能力。

`connect all` 批量生成，`--out 新目录` 指定输出。已有包不会静默覆盖；失败会按宿主报告，已成功的安装保持有效。默认输出目录在状态目录的 `agent-installs` 下。源码安装包引用当前编译文件的绝对路径，移动仓库后需重新连接。

## 模型与处理位置

`--local-asr` 在首次启动时下载约 240MB 的 SenseVoice int8 模型，检查固定 SHA256，并在独立进程中验证原生引擎可以加载。无需 Python 和付费 API Key；后续复用缓存。默认源连接失败时使用 Sherpa 官方 GitHub release，读取指定成员到标准输出并核对同样的文件哈希，不把归档路径直接解压到文件系统。

也可以单独准备，或选择已有模型目录（包含 `model.int8.onnx` 和 `tokens.txt`）：

```bash
node dist/src/cli.js prepare-asr
node dist/src/cli.js prepare-asr --model-dir /已有模型目录
```

生成的本地预设会在后续普通 `start` 中自动加载；该伴随进程不会继承 OpenAI 兼容云端凭据。它在本地转写语音、保存图片和视频关键帧，由所连接的 Agent 完成最终回答。若需要云端分析等自定义组合，使用单独的 `--config`，不要与 `--local-asr` 同时指定。已运行的服务不会被隐式重配，需要先 `stop`。

安装连接器不等于取得宿主模型 API 密钥。面谈证据工具默认读取已经存储的内容，由当前 Agent 理解和回答；`clawsense_artifact_get` 可返回不超过 8MiB 的图片/音频原件，能否被模型理解仍取决于宿主模态支持。视频用关联关键帧，不能把关键帧当成完整视频理解。

独立服务沿用项目已有 ASR / 多模态分析配置。需要时用 `start --config /绝对路径/配置.json` 传入插件配置对象，具体字段参照 README 的本地 ASR 与 provider 说明。不要将含密钥的配置提交到 Git。没有处理后端时，服务仍能保存原件并准确说明待分析状态，但不承诺自动转写或手机自然语音问答完成。

`hostModelImageMode=metadata-only` 只控制图像，不是全局离线开关。已有 `clawsense_context` 可执行复核和其它配置允许的分析；严格私密运行需要对 ASR、图像、宿主模型和网络查询整个路径单独配置与验证。

## 六步使用流程

1. 在工作台创建面谈，填写标题、项目与参与者，Android 单独启动知情采集。
2. 在宿主中要求读取这场面谈。使用 `clawsense_session_evidence` 查看原始证据和最新更正。
3. 用户更正人物或承诺，Agent 调用 `clawsense_memory_correct`，带当前 `expectedRevision`。同一对象的更正使用 `objectId`，保留历史。人物纠正的说明与参与者名册分别保存；修改名册用 `clawsense_session_update`。
4. 第二个 Agent 重新读取面谈，使用同一更正版本。原始转写不被改写，模型必须明确区分原话与用户确认。
5. 用户要求后续工作时创建 `clawsense_work_create`，指定已授权 Agent。该 Agent 用自己获准的工具实际执行，然后 `clawsense_work_complete` 保存正文。这个接口不会自动启动或给其它 Agent 发消息。
6. 新建下一次面谈并关联 `previousSessionId`；`clawsense_briefing` 返回当前及上一次面谈、更正和工作。浏览器可下载产物；旧结果仍保留，但来源更改后会显示过期。

可直接导出已完成成果：

```bash
node dist/src/cli.js export-work 工作ID --out 跟进方案.md
```

输出文件必须不存在，避免覆盖现有文档。工作结果同时可由 Agent 的 `clawsense_work_get` 读取，不依赖服务端文件路径。

## 权限与维护

```bash
node dist/src/cli.js doctor
node dist/src/cli.js grants
node dist/src/cli.js revoke 授权ID
node dist/src/cli.js stop
```

撤销立即阻止该凭据的后续读取；无法删除它此前已经复制到宿主对话中的内容。`stop` 返回正在停止，会等待在途保存/处理后释放状态锁；若既有模型请求很慢，退出可能等待。前台 `serve` 第二次中断可强制退出，但保留锁，必须确认旧进程已停止后再处理遗留锁，不能让两个服务同时写同一状态目录。

## 验收与限制

```bash
npm test
npm run check:cross-agent
npm run check:calibration
```

这些检查使用临时状态及合成素材，不调用付费模型，不修改个人 Agent 配置。SDK 客户端通过不等于各品牌客户端验收；完整识别质量、所有宿主、图形化安装、系统开机启动、宿主双向会话和市场上架仍需各自完成。

实际验收已逐步推进：10月10日 Codex 的原图、转写、更正、成果保存和重启复用通过，原生音频未能直接消费；Claude 模型401，12日孤立客户端提示未登录。12日用户确认校准问答、追问、短例全文和停止朗读，声音清楚但机械；新版系统TTS及UI停止采集通过。13日 Codex→OpenClaw 交接、正确成果回写、共享服务重启后两个品牌复用通过限定案例。保存成功的错误稿也保留，不能把completed当作语义签核。视觉/背景声、多场景质量和其它宿主仍开放，主手机新增仍暂停。真实模型检查不在以上命令中执行，不能推定整个G0/G1完成。见 [12日真机记录](./validation/g0-live-2026-10-12.md)与 [13日跨宿主记录](./validation/g1-native-2026-10-13.md)。

另有可选真实本地 ASR 检查 `npm run check:local-sensevoice`：使用 `.local/cross-agent-asr-validation` 中已准备模型和官方公开样例；不会读取个人录音。可用 `-- --state-dir ... --wav ...` 指定自己的本地样例，内容仅在本地处理。该检查不会自动把随机录音当作官方精度基准。
