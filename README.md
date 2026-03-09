# ClawSense Plugin

ClawSense 是一个面向 OpenClaw 的全天候感知插件原型，提供：

- 终端二维码引导配对
- 一次性 setup token 换永久 `deviceSecret`
- Android 采集端上传音频、图片与心跳
- 音频转写、视觉摘要与 LanceDB 记忆落库

## 当前状态

当前仓库已经跑通下面这些主链路：

- OpenClaw 服务端配对二维码生成
- Android 真机扫码配对
- 永久 `deviceSecret` 持久化
- 前台感知服务启动 / 停止
- 音频上传
- 图片上传
- 心跳上报

如果你是第一次接触这个项目，先看这份文档：

- [小白部署与使用指南](/Users/cedric/Documents/ClawSense/docs/小白部署与使用指南.md)

## 本地开发

```bash
npm install
npm run check
npm test
```

## 安装

当前有 3 种安装来源：

- 仓库源码已经在服务器上
- 远程插件压缩包 URL
- 已发布到 npm 的包名

如果源码仓库已经在服务器上，直接在仓库根目录执行：

```bash
bash install.sh
```

如果要让服务器从远程压缩包下载安装：

```bash
CLAWSENSE_SOURCE_URL="https://your-host.example/clawsense-plugin.tar.gz" bash install.sh
```

如果插件已经发布到 npm：

```bash
CLAWSENSE_NPM_SPEC="@clawsense/clawsense@latest" bash install.sh
```
