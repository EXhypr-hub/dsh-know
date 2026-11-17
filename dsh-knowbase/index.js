/**
 * dsh-knowbase — Host 半
 *
 * P0 阶段职责：
 *   1. 注册知识库服务（后续 P1 起承载库、文档、检索）
 *   2. 暴露一条只读状态接口给前端，用于验证「Host ↔ Client」链路打通
 *   3. 提供运行时信息（数据目录、版本），供界面展示
 *
 * 设计约束：
 *   - 不写 profile 配置文件（配置走 Config schema + configEditor）
 *   - 所有资源注册都通过 ctx.effect / ctx.on，卸载时自动清理
 *   - 可选依赖用 ctx.get() 检查，避免在缺少服务的组合里抛错
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/** 插件版本，与 package.json 保持一致 */
const VERSION = '0.1.0'

/** 数据目录的候选根：优先用户配置，其次 DSH_HOME，最后回落到用户目录 */
function defaultDataRoot() {
  const configured = process.env.DSH_KNOWBASE_DIR
  if (configured && configured.trim() !== '') return configured

  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim() !== '') return join(dshHome, 'knowbase')

  return join(homedir(), '.dsh', 'knowbase')
}

/**
 * 知识库服务。
 *
 * P0 只提供只读状态；P1 起在此之上叠加库管理、导入、检索。
 */
class KnowledgeBase {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.dataRoot = config.dataRoot?.trim() || defaultDataRoot()
    this.ready = false
    this.readyError = null
  }

  /** 准备数据目录。失败不抛错，记录原因由状态接口返回。 */
  async start() {
    try {
      await mkdir(this.dataRoot, { recursive: true })
      this.ready = true
    } catch (error) {
      this.ready = false
      this.readyError = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.('dsh-knowbase: 数据目录不可用 %s (%s)', this.dataRoot, this.readyError)
    }
  }

  /** 供状态接口与后续界面使用的运行时快照 */
  status() {
    return {
      version: VERSION,
      stage: 'P0',
      ready: this.ready,
      readyError: this.readyError,
      dataRoot: this.dataRoot,
      counts: { collections: 0, documents: 0, chunks: 0 },
      capabilities: {
        ingest: false,
        search: false,
        rerank: false,
        ocr: false,
        fetch: false,
      },
    }
  }
}

// logger 在部分组合里可能不存在，做成可选依赖而非必需
export const inject = []

export function apply(ctx, config) {
  const kb = new KnowledgeBase(ctx, config ?? {})

  ctx.effect(() => {
    kb.start()
    return () => {
      // P0 无后台资源需要关闭；P1 起在此关闭数据库连接与任务队列
    }
  }, 'dsh-knowbase: lifecycle')

  // 只读状态接口，前端据此确认链路并显示运行时信息
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    if (connection?.fetch?.register === undefined) return

    return scope.effect(
      () =>
        connection.fetch.register({
          path: '/api/dsh-knowbase/status',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async () =>
            Response.json(
              { ok: true, value: kb.status() },
              { headers: { 'cache-control': 'no-store' } },
            ),
        }),
      'dsh-knowbase: status route',
    )
  })
}

export { KnowledgeBase, VERSION, defaultDataRoot }
