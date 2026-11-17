# 上架到 DSH 插件市场

这个目录放的是提交到 **awesome-dsh-plugin** 策展仓库的条目文件。

## 先搞清楚一件事

| 角色 | 是什么 | 要往哪提 |
|---|---|---|
| `dshmarket`（市场 App） | **只是客户端**，负责浏览/安装/更新 | ❌ 不要往它的仓库提条目 |
| [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | **唯一数据源**，站点与市场都读它 | ✅ 在这里提 PR |

不先被收录，普通用户在「发现」里是搜不到也装不上的——市场的安装只接受策展清单里出现过的源。

## 提交步骤

1. **给仓库加 topic**
   打开 https://github.com/EXhypr-hub/dsh-know → 右侧 About 齿轮 → Topics 填 `dsh-plugin`

2. **确认仓库已满 1 天**
   CI 自动检查；PR 前几分钟才建好的仓库会被拒。
   本仓库首次提交是 2026-11-17，**11-18 之后**提交即可。

3. **Fork 策展仓库并加一个文件**

   ```bash
   # 在 GitHub 网页上 fork，然后：
   git clone https://github.com/<你的账号>/awesome-dsh-plugin.git
   cd awesome-dsh-plugin
   cp <本目录>/EXhypr-hub__dsh-know.yml data/plugins/
   git checkout -b add-dsh-know
   git add data/plugins/EXhypr-hub__dsh-know.yml
   git commit -m "Add EXhypr-hub/dsh-know"
   git push origin add-dsh-know
   ```

4. **在 GitHub 上开 PR**
   一个 PR 只加这一个文件。不要手工改 README——那两个由脚本从 `data/plugins/*.yml` 生成。

5. 等维护者合并。CI 通常几分钟，人工评审看仓库本身。

## 条目内容

```yaml
url: https://github.com/EXhypr-hub/dsh-know
name: EXhypr-hub/dsh-know
category: memory
description:
  en: Local knowledge base with hybrid keyword and vector search, five agent tools, and citation-ready excerpts.
  zh: 本地知识库：关键词与向量混合检索，提供五个智能体工具，返回带书名与页码的原文片段。
tarball: https://github.com/EXhypr-hub/dsh-know/releases/latest/download/dsh-knowbase.tgz
icon: https://raw.githubusercontent.com/EXhypr-hub/dsh-know/main/dsh-knowbase/icon.svg
```

### 关于 `category`

选的是 `memory`——知识库本质是把资料存起来再检索，属于这一类。

可选的完整清单：
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

> 分类选得不够准**不会**被打回，维护者会直接改。`tools` 也是个合理的选择（插件确实提供了五个工具）。

### 关于 `tarball`（重要）

- 文件名**不能带版本号**。`releases/latest/download/` 里的 `latest` 在请求时解析，但文件名照字面取——带版本号的文件名在下次发版后会静默 404。
- 必须是 GitHub Release 自己托管的 `https` `.tgz`。
- 发版前先跑 `npm run build:tgz` 生成本地产物，然后用 `gh release create` 上传。

### 关于 `icon`

用仓库里的 `icon.svg` 原始链接即可（指南允许 SVG）。

## 提交前的自检

```bash
cd dsh-knowbase
npm run publish:check
```

这个脚本会逐条核对：`dsh.bundle` 声明、patch 文件存在、包名合规、semver 合法、
keywords、license、repository、`engines.dsh` 的预发布覆盖、README 安装说明、
真实代码、图标、locale meta、描述是否含营销词、`npm pack` 产物完整性。

GitHub 侧的两项（满 1 天、加 topic）本地验证不了，输出里会单独提醒。

## 同一个插件还能提交到别处

- [dsh.so 提交页](https://www.dsh.so/zh/submit/)：粘贴仓库地址即可，它会自动拉取、校验、安全扫描
- npm：`npm publish` 后可作为独立发行渠道（本次未做）

收录不等于安全背书——市场自己也这么声明。
