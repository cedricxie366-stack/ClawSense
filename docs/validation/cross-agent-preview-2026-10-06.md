# ClawSense 跨 Agent 开发预览验收

日期：2026-10-06（Asia/Shanghai）

## 交付范围

当前源码已实现独立伴随服务、通用 MCP、面谈与更正版本、工作交接和结果回流、浏览器工作台、宿主安装配置以及 Android 私有持久化补传。保留原有 OpenClaw 插件和 Android 上传接口。

这是可安装的开发预览，尚未达到全部主流宿主、真机语音和公共市场完成验收的产品状态。

## 自动化结果

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `CHECK_ANDROID=0 npm run check:release` | 通过 | 包括构建、19文件355测试、calibration、stdio、既有evidence/phase9/live/final fixtures及pack边界 |
| `node --test calibration-fixtures/*.test.mjs` | 3/3通过 | 英文录制否定、日志后的多行ASR JSON、HTTP协议大小写 |
| `npm run check:cross-agent` | 通过 | 真实HTTP MCP与两个stdio进程；使用SDK客户端，不代表品牌客户端实际问答 |
| `node scripts/check-cross-agent-stdio.mjs` | 23项断言通过 | 隔离配置安装、可信身份、共享纠正、工作交接、成果导出、后台启动/停止 |
| `node scripts/check-package-install.mjs` | 通过 | 本地tarball安装至干净prefix，CLI入口和依赖可加载；未发布 |
| Android `testDebugUnitTest` 定向spool测试 | 9/9通过 | JVM文件恢复、校验、容量、配对隔离、存储失败；未使用真实手机 |
| Android `assembleDebug` | 通过 | 可构建APK，不等于真机功能签核 |
| `git diff --check` | 通过 | 未提交或发布代码 |
| `prepare-asr` 与 `check:local-sensevoice` | 通过 | 真实下载、加载、公开中文样例本地转写、异步入库、证据查询；不代表远场精度或真机验收 |

测试使用临时状态和合成素材；跨Agent集成测试清空模型凭据环境变量，没有调用付费模型，没有读取私有录音，没有修改个人宿主配置。现有模型单元测试使用替身。

## 本地语音识别首装验证

`start --local-asr` / `prepare-asr` 会准备 SenseVoice int8，两文件合计239,549,735字节。下载按固定revision和SHA256检查；已有缓存同样复查；自定义本地目录执行原生加载验证。

当前网络访问Hugging Face超时，自动改用Sherpa官方GitHub release后成功。归档仅用tar将指定成员写到标准输出，模型文件由本程序写入临时目录并核对同样的哈希，再原子发布；不将归档中的路径或链接直接解压到文件系统。

模型来源：[Sherpa官方模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)，固定模型revision为`2365baeacb507f821a0c8120fcee3d484dba7a07`。中文样例为同版公开`test_wavs/zh.wav`，178,988字节，Git blob校验为`24a2bfc5c039f9d97db2cf1f2461699b582e0a90`。

实际读取结果为“开放时间早上9点至下午5点。”，本机本次直接解码耗时635ms；该数字只是单一样例的读数，不作为性能承诺。相同文本经HTTP音频上传、后台本地分析后写入state，并能从`clawsense_session_evidence`读取。报告位于`.local/cross-agent-asr-validation/local-sensevoice-report.json`。测试没有云端模型调用，也没有使用物理麦克风。

## 六步协议验证

1. 使用现有Android配对协议创建测试设备，经HTTP保存合成图片/音频，验证原件字节与重启后的设备状态。
2. Agent A创建命名面谈，Agent B通过MCP读取证据；图片原件可通过原生MCP image内容返回，音频工具具备相同受限通道。
3. Agent A保存人物和承诺更正，原始证据保持不变。
4. Agent B读取相同更正版本；旧revision写入被拒绝。
5. A指定B处理工作，A不能冒充B完成；B保存正文后可从CLI或浏览器导出。
6. 重启后，下一次面谈通过previousSessionId恢复上次事实和成果。更正再次变化后，旧成果保留原文并标过期。

补充验证：撤销B凭据后立即拒绝新请求，A仍可使用；客户端传入的身份不能覆盖认证身份；匿名/手机凭据不能进入Agent工具；跨域请求被拒绝；损坏状态不会被空状态覆盖。

## 浏览器走查

Playwright在独立临时库中完成：一次性登录、选择面谈、保存任务更正、revision递增、旧工作过期提示、读取/下载Markdown成果、创建关联的第二次面谈、恢复上次事实、显示可扫码的SVG二维码。刷新后的页面无控制台错误。

本地截图保存在 `output/playwright/companion-work-result.png` 与 `output/playwright/companion-pairing.png`，仅为合成演示数据。二维码指向临时loopback服务，服务关闭后失效，不作为真实手机配对证明。

## 兼容性状态

| 宿主 | 当前交付 | 品牌客户端验收 |
| --- | --- | --- |
| Pi / Codex / Claude Code / OpenCode | 配置生成、安全合并、独立token；Codex/Claude另有原生包 | 待完成 |
| WorkBuddy / TRAE / 千问办公 | 配置/原生导入指引；TRAE安装链接 | 待完成 |
| 豆包工作 | HTTP模板与接入指引，远程部署与授权仍需配置 | 待完成 |
| OpenClaw | 保留原入口，增加通用面谈/更正/工作工具 | 原有fixtures通过；新版本真实环境待复测 |

协议一致不代表各宿主的音频、图片、后台事件及插件导入体验一致。

## 尚未通过的门槛

- 2026-10-06 Android doctor为`waiting-for-device`，没有已授权的物理Android。
- 没有本轮真实语音识别、TTS听感和现场回答质量报告。
- 新面谈工具使用已有证据，最终推理由宿主承担；本地ASR命令行自动准备已完成，图形化模型准备及视觉分析预设仍待完善。
- 工作交接是共享任务对象与产物回写，不会自动启动其它Agent或执行对外发送。
- 当前revision覆盖人工更正与面谈元数据；原始素材和异步分析快照的版本仍待补。
- 当前Agent授权为单所有者全库范围，未完成按面谈ACL和远程OAuth。
- 后台启动不等于系统开机启动；强制退出的残留锁需安全恢复，长模型任务可能延缓优雅停止。
- 尚未发布npm、GitHub release或各平台市场。
