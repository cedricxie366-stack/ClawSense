# Android VAD封装的隔离对照

日期：2026-10-16。承接[愿景与源码评估](nanomuse-reuse-2026-10-14.md)及[主计划C批次](../产品演进路线与执行计划.md)。本轮只做独立原型，没有替换ClawSense的录音回路或正式Android依赖，也没有加入nanoMuse／OpenMinis的GPL产品代码。

## 取得与运行的内容

从[RealTimeCut Android固定提交](https://github.com/helloooideeeeea/RealTimeCutVADLibraryForAndroid/tree/a4450c2b5fb0f2d14a9ef2ac727e0ee2ae9a9116)取得Java／JNI源码及Silero v5模型；该提交的[源码许可](https://github.com/helloooideeeeea/RealTimeCutVADLibraryForAndroid/blob/a4450c2b5fb0f2d14a9ef2ac727e0ee2ae9a9116/LICENSE)为MIT。JitPack的两个1.0.5制品地址未取得可用AAR，保留超时／连接失败，没有把自行构建标成该发行二进制已验收。

按其构建文件引用的官方[原生1.0.8发行资产](https://github.com/helloooideeeeea/RealTimeCutVADLibraryForXCFramework/releases/tag/v1.0.8)，用已有NDK编译JNI桥接，另建只供实验的`ai.openclaw.clawsense.vadprobe`应用。[该标签源码许可](https://github.com/helloooideeeeea/RealTimeCutVADLibraryForXCFramework/blob/v1.0.8/LICENSE)为MIT；此核对不替代ORT、WebRTC、模型及最终发行包的完整许可审查。实验APK、原生库与模型均留在私有`.local/p1-tail-2026-10-16/`，未加入ClawSense发行包。

原生zip SHA256：`488d50da9c39698d5aa4cda22ac980bb4facfe0504edb79f1399cb3f0ea2d571`。两条v5路径使用同一模型文件，SHA256：`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`。当前生产路径的既有模型SHA为`9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`，没有被覆盖。

## 有限结果

后台只读Android模拟器`SDK gphone64 arm64`／API36.1，未打开真实麦克风。12项PCM情况在一个原生用例中运行通过，耗时1.382秒：合成问题、衰减到8%的同一句话、单字“停”、静音、生成噪声与敲击，各做上游默认阈值及较短轮次阈值（起音2帧／尾部14帧）的对照。PCM没有按实时节拍送入，数值是算法处理与回调位置，不是耳机、传输或真人打断时延。

| 输入 | 默认首次触发位置 | 短轮次首次触发位置 |
| --- | --- | --- |
| 合成问题 | 1312ms | 1184ms |
| 衰减问题 | 1248ms | 1088ms |
| 单字“停” | 1248ms | 1152ms |
| 静音／生成噪声／敲击 | 未触发 | 未触发 |

前三种输入包含人为添加的一秒前置静音，原始语音文件本身也可能有静音；不能直接把表中位置当成真实发声到检测的延迟。单次过程CPU时间约12至72ms，含模型内部工作线程，但不含模型初始化；没有据此推断真实手机电耗。

同一v5文件也通过直接Sherpa适配在Mac上运行了语音、衰减语音、静音、生成噪声和敲击检查；前两项首次触发为输入起点后160ms，后三项未触发。该输入没有Android实验额外的一秒前置静音，阈值、硬件、噪声生成器与处理框架也不同，**不据此给两个框架的速度或准确率排名**。

## 当前选择

当前生产Silero文件也用相同合成语音另做5项RMS对照：正常／8%音量语音均被检测；静音、生成噪声与敲击均未触发。固定RMS阈值0.0015在生成噪声及敲击上分别标出9984ms和896ms。这里对照的是固定最低阈值，不是完整自适应RMS后备路径，也不据此推断真实房间误触发率。生产模型与上面v5文件不同，不能把两组差异全归因于封装。

P1继续使用已有的直接Silero路径，保留RMS对照和同一音频所有者。Android封装已从“仅查过许可”推进到独立JNI运行可行；将来需要手机本地VAD时，可以使用直接上游源码再做目标手机对照。默认分段等待适合什么任务，应按短口令和面谈分别调校，不能照搬nanoMuse的封装与参数。

该实验不证明手机本地ASR、TTS、语言模型或完整Live已交付；VAD也不识别说话人和意图。电视、旁人、重叠说话、真实远场及手机电耗保留为设备／真人范围。

脱敏结果见[数据记录](android-vad-comparison-2026-10-16.json)。
