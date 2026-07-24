# ClawSense GitHub 与 npm 发布清单

这份清单面向“第一次公开发布这个项目”的场景。

目标不是一步到位做成大而全，而是先把下面两件事做好：

1. 用户能在 GitHub 上看到项目、文档和截图
2. 用户后续能通过 npm 安装插件

## 1. 推荐发布策略

建议按这个顺序发布：

### 第一步：先发 GitHub 仓库

原因：

- 这是项目的公开首页
- 用户先看 README、截图、限制说明、部署文档
- 你也需要一个地方收 issue、发 release、放变更记录

建议仓库名：

- `ClawSense`

建议仓库描述：

- `Always-on sensory companion plugin for OpenClaw`

建议仓库可见性：

- `Public`

### 第二步：再发 npm 包

原因：

- OpenClaw 插件更适合通过 `openclaw plugins install <npm-spec>` 安装
- 比让用户自己拉源码、传服务器更标准

建议首发用“你自己的 npm scope”，不要一开始就赌品牌 scope。

推荐包名优先级：

1. `@你的-npm-用户名/clawsense`
2. `clawsense`
3. `clawsense-openclaw-plugin`

说明：

- 我在 `2026-03-09` 实测查过 npm registry，`clawsense`、`clawsense-openclaw-plugin`、`@clawsense/clawsense` 这三个名字当时都没有现成公开包。
- 我在 `2026-07-14` 复查 `npm view clawsense version --json`，仍返回 404，说明 `clawsense` 目标包名当前尚未发布。
- 但 `@clawsense/clawsense` 只有在你拥有 `clawsense` 这个 npm scope 时才能发，不适合作为第一次发布的默认方案。

### 第三步：以后再考虑 ClawHub

不建议把 ClawHub 当第一发布面。

原因：

- ClawHub 更适合 `skills`
- 当前 ClawSense 的主交付物是 OpenClaw 插件，不是 skill 包

## 2. 当前仓库在发布前需要注意的地方

当前代码已经能跑。最开始的几个发布阻塞项是：

- `package.json` 里是 `"private": true`，这会直接阻止 npm 发布
- `package.json` 里的包名是 `@clawsense/clawsense`，如果你没有这个 scope，就发不出去
- 没有显式 `LICENSE`
- 没有完善的 `repository` / `homepage` / `bugs` 元数据

当前这份仓库已经改成了更适合第一次发布的状态：

- `private: false`
- 包名改为 `clawsense`
- 已补 `LICENSE`
- 已补 `repository / homepage / bugs`

## 3. 先发布 GitHub 仓库

### 3.1 在 GitHub 网页上创建仓库

用你的 GitHub 账号新建一个仓库：

- Repository name: `ClawSense`
- Visibility: `Public`

不要勾选：

- `Add a README file`
- `Add .gitignore`
- `Choose a license`

原因：

- 你本地已经有这些内容或即将补这些内容
- 先不要让远端生成额外初始提交，避免第一次 push 多一次处理

### 3.2 本地首次提交并推送

在仓库根目录执行：

```bash
git add .
git commit -m "Initial public release"
git remote add origin git@github.com:你的GitHub用户名/ClawSense.git
git push -u origin main
```

如果你更习惯 HTTPS，也可以把 `origin` 换成：

```bash
https://github.com/你的GitHub用户名/ClawSense.git
```

### 3.3 GitHub 首屏建议放什么

第一次公开，不要追求太满，先把这几样放好：

- 项目一句话介绍
- 当前已跑通能力
- 当前限制
- Android 真机截图
- 部署文档入口
- 安装方式说明

## 4. 再发布 npm 包

### 4.1 当前 npm 包名

当前仓库已经把首发包名定为：

```json
{
  "name": "clawsense"
}
```

发布前必须再确认一次：

```bash
npm view clawsense version
```

如果仍然是 404，说明这个无 scope 包名还可用于首发；如果已经被占用，就需要改成 `@你的-npm-用户名/clawsense` 并同步 README / install docs。

### 4.2 发布前要改哪些字段

发布前，至少确认 `package.json` 保持下面这类状态：

```json
{
  "name": "clawsense",
  "version": "0.1.0",
  "private": false,
  "description": "Always-on sensory companion plugin for OpenClaw",
  "license": "MIT"
}
```

最好再补：

- `repository`
- `homepage`
- `bugs`

### 4.3 登录 npm

先确认本机有没有登录：

```bash
npm whoami
```

如果提示未登录，就执行：

```bash
npm login
```

### 4.4 首次发布

确认无误后执行：

```bash
npm run check:release
npm publish --dry-run --access public
npm publish --access public
```

说明：

- `npm publish --dry-run --access public` 不会真正发布包，用来确认 prepack、包内容和 registry 发布参数。
- 如果你用的是带 scope 的包名，比如 `@你的用户名/clawsense`，通常要显式加 `--access public`
- 如果你是无 scope 包名，有时可以不加，但我建议统一加上

### 4.5 发布后用户怎么安装

如果你最终发布成：

```text
clawsense
```

那用户安装可以写成：

```bash
CLAWSENSE_NPM_SPEC="clawsense@latest" bash install.sh
```

后面如果 OpenClaw 侧完全走标准插件安装，也可以直接写：

```bash
openclaw plugins install clawsense
```

## 5. 我建议你第一次发布时这样做

这是我认为最稳的最小路径：

1. 先建 GitHub 仓库 `ClawSense`
2. 先把当前仓库 push 上去
3. 先不急着发 npm
4. 我帮你把 `package.json` 调整成可发布状态
5. 你跑一次 `npm login`
6. 我再带你执行第一次 `npm publish --access public`

## 6. 我建议你现在就做的事

如果你要最稳地往前走，下一步就做这个：

1. 在 GitHub 网页上创建 `ClawSense` 公共仓库
2. 把仓库地址发给我

例如：

```text
git@github.com:你的用户名/ClawSense.git
```

或者：

```text
https://github.com/你的用户名/ClawSense.git
```

你把地址发给我后，我下一步可以直接帮你：

- 补发布前需要的元数据
- 检查 `package.json` 发布阻塞项
- 给你一套可以直接复制执行的 `git add / commit / remote add / push` 命令
