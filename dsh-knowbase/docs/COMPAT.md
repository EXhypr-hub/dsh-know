# 版本适配

本插件声明支持 **DSH 0.1.7-rc.2 及之后的版本**。

这份文档说明这个结论是怎么来的、每一处用到的 API 是什么、以及未来版本变化时会发生什么。

---

## 一、结论的依据

DSH 安装目录自带权威的升级指南：`docs/upgrade-guide/`
（本机路径 `…/app.asar/dsh/node_modules/@deepseek-ai/dsh/docs/upgrade-guide/`）

它按「从某版本升级到下一个版本」组织，本机安装覆盖的范围是
**v0.1.7-rc.2 → v0.2.2-rc.1**，索引共 **213 条**破坏性变更。

逐条比对插件实际用到的扩展面后，结论是：**没有一条涉及本插件依赖的 API**。

---

## 二、插件用到的扩展面

### Host 侧（`index.js`）

| API | 用途 | 是否关键 |
|---|---|---|
| `ctx.effect(fn)` | 生命周期管理 | **关键** |
| `ctx.inject([...], fn)` | 等待服务就绪 | **关键** |
| `ctx.get(name)` | 读取服务 | **关键** |
| `connection.fetch.register({...})` | 注册前端 API 路由 | **关键** |
| `ctx.tools.register({...})` | 五个智能体工具 | 可选 |
| `ctx.skills.register({...})` | `knowledge-base` 技能 | 可选 |
| `ctx.get('credentials')` | 存 API Key | 可选（缺失时降级为本地存储） |

### Client 侧（`client.js`）

| API | 用途 | 是否关键 |
|---|---|---|
| `ctx.slots.register({...}, Comp)` | 左侧栏图标与主面板 | **关键** |
| `ctx.slots.inject(owner, fn)` | 随声明塌陷自动清理/重装 | 可选（缺失时直接 register） |
| `ctx.locale.register/bind` | 中英文界面 | 可选（缺失时用内置中文） |
| `ctx.inputTriggers.registerSource(src)` | 输入框 `@` 选知识库 | 可选（缺失时隐藏该入口，其余功能正常） |
| `ctx.inject(['sidebarRightTabs'], ...)` | 对话旁的右侧栏面板 | 可选（缺失时跳过） |
| `require('react')` | 组件运行时 | **关键**（浏览器模块表自带，不重复安装） |

---

## 三、213 条变更里与插件相关的条目

只有一条沾边，且已兼容：

**v0.2.0-rc.2 · Subpath plugins read `<subpath>/icon` instead of `<subpath>/package.json`**

> 子路径插件不再从导出的 `<子路径>/package.json` 读取展示文本和图标，改用 locale meta 和 `<子路径>/icon`。

本插件是 **package-root 插件**（不是子路径插件），并且从一开始就按新写法声明：

```json
"exports": { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" }
```

展示文本来自 `locale/*.json` 的 `meta.title` / `meta.description`，图标来自 `./icon`。
所以这条变更对本插件**没有影响**。

其余条目涉及账号登录、worktree、attachment、Forge、终端、Office、LLM 提供方、消息记录等，
本插件均未使用。

---

## 四、版本声明的写法

`package.json` 里：

```json
"engines": {
  "node": ">=22.12.0",
  "dsh": ">=0.1.7-rc.2 || >=0.2.0-rc.2 || >=0.2.1-rc.1 || >=0.2.2-rc.1"
}
```

### 为什么是一串 `||` 而不是一段范围

node-semver 有个容易踩的规则：**预发布版本只有当范围里存在「与它 major.minor.patch
完全一致、且自身也带预发布标签」的比较符时才会被放行。**

所以看起来最自然的 `>=0.1.7-rc.2` 实际只匹配 `0.1.7-rc.2` 本身和正式版，
**完全不匹配 0.2.x 的任何 rc 版本**——包括本机正在运行的 `0.2.2-rc.3`：

| 版本 | `>=0.1.7-rc.2` | 显式分支写法 |
|---|---|---|
| 0.1.7-rc.2 | ✅ | ✅ |
| 0.2.0-rc.2 | ❌ | ✅ |
| 0.2.1-rc.2 | ❌ | ✅ |
| 0.2.2-rc.1 | ❌ | ✅ |
| 0.2.2-rc.3（当前） | ❌ | ✅ |
| 0.2.2 / 0.3.0 | ✅ | ✅ |

加通配也不管用：`>=0.1.7-rc.2 || >=0.2.0-0` 仍然漏掉 0.2.1 和 0.2.2 的预发布版。
必须为每条预发布线各写一个分支。

自测里有一条专门守这个：若有人把它改回单段写法，或漏掉某个分支，测试会直接失败。

**为什么是 `engines.dsh`**：DSH 的插件管理器读取的版本字段是
`name` / `version` / `engines` / `peerDependencies` / `deprecated` / `dsh`
（见 `@deepseek-ai/dsh-plugin-manager` 的 `VERSION_FIELDS`），
其中与 DSH 版本要求直接相关的是 `engines.dsh` 和 `peerDependencies`。

> 早期版本曾写过 `dsh.compatibility.dshReleases`，经核对该字段在
> `dsh-plugin-manager`、`dsh-client-ui-plugin-manager`、`dsh-bundle`、`dsh-plugin`
> 四个包里被引用 **0 次**，属于无效字段，已移除。

---

## 五、运行时降级行为

不靠版本号判断，而是探测 API 在不在（`lib/compat.js`）。

| 缺失的能力 | 发生时 | 插件行为 |
|---|---|---|
| `ctx.effect` / `ctx.inject` / `connection.fetch` | 极旧版本 | 不注册任何东西，在日志里写明缺什么，**不抛异常** |
| `ctx.tools` | 较早版本 | 跳过工具注册，检索与导入照常 |
| `ctx.skills` | 较早版本 | 跳过技能注册 |
| `credentials` | 较早版本 | Key 存本地设置 |
| `slots.register` | 极旧版本 | 界面不挂载，控制台提示；**Host 侧工具不受影响** |
| `slots.inject` | 较早版本 | 退回直接 `slots.register` |
| `locale` | 较早版本 | 用内置中文静态字典 |

诊断信息会出现在 `status.compatibility` 里，便于排查：

```json
{
  "compatibility": {
    "usable": true,
    "note": "宿主 API 完整（检索、导入、工具、技能、凭据库均可用）",
    "missing": []
  }
}
```

---

## 六、未来版本变化的应对

1. **升级 DSH 后先跑一次 `npm run selftest`**（50 项，含兼容性断言）
2. 如果新版本动了本插件用到的 API，`lib/compat.js` 的探测会让插件**降级而不是崩溃**
3. 需要重新适配时，读本机 `docs/upgrade-guide/<旧版本>/` 对应条目即可

---

## 七、未能验证的部分

- 本结论基于**静态比对**（官方升级指南 × 插件代码），未在真实的 0.1.7-rc.2 环境里跑过。
  本机只装了 0.2.2-rc.3。
- 若你在旧版本上遇到运行时问题，请在 `docs/` 下记一条，不要悄悄改声明。
