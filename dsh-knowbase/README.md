# dsh-knowbase

DeepSeek Harness 的本地知识库插件。文档导入、语义检索、权威来源采集，数据全部留在本机。

> **开发中** — 当前处于 P0（插件骨架）阶段。

## 目录结构

```
dsh-knowbase/
├── package.json        插件清单（bundle patch + client 声明）
├── cordis.patch.yml    插入 Host 插件行
├── index.js            Host 半：知识库服务、状态接口
├── client.js           Client 半：侧栏图标、主面板页面
├── lib/                业务模块（P1 起填充）
├── locale/
│   ├── zh.json         中文界面文案与插件元信息
│   └── en.json         英文
└── icon.svg            插件图标
```

## 界面位置

- **左侧栏图标**：位于「日程」与「上下文」之间
- **主面板**：点击图标后居中显示，与 DSH 主题一致，深浅色自动适配

## 开发阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 插件骨架、图标、双语、界面框架 | 进行中 |
| P1 | 导入与存储 | 待做 |
| P2 | 检索 | 待做 |
| P3 | 模型接入 | 待做 |
| P4 | 权威来源采集 | 待做 |
| P5 | 界面打磨 | 待做 |
| P6 | 打包发布 | 待做 |

## 技术要点

- **样式**：只用主题变量 `--dsw-alias-*`，不引入任何 UI 库
- **动效**：CSS 实现，遵守 `prefers-reduced-motion`
- **数据目录**：默认 `$DSH_HOME/knowbase`，可用配置项 `dataRoot` 覆盖
- **接口**：通过 `ctx.connection.fetch.register` 注册，路径 `/api/dsh-knowbase/*`

## 许可

[MIT](../LICENSE)
