/**
 * 智能体工具：让模型能主动操作知识库。
 *
 * 为什么需要这些工具：
 *   光有界面只能人查；模型能自己调用工具，才能在对话里"先查资料再回答"，
 *   并把书名和页码一起给出来。这是这个插件区别于普通搜索框的地方。
 *
 * 实现说明：
 *   不 import @deepseek-ai/dsh-tools 的 defineTool——插件不在 DSH 的模块解析
 *   上下文里，直接 import 会 ERR_MODULE_NOT_FOUND。
 *   defineTool 的真实作用只是把简写参数转成 JSON Schema，这里直接写 JSON Schema。
 */

/** 把任意值包成工具结果（模型看到的是可读文本） */
function textResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * 清洗成无损 JSON。
 * 工具结果会做序列化校验：对象里带 undefined 会被判成「不是无损 JSON」，
 * 所以返回前统一过一遍，undefined 字段直接丢掉。
 */
function clean(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

/** 通用输出声明 */
function outputOf(schema) {
  return {
    schema,
    render: (_args, value) => textResult(value),
  }
}

/** 统一的错误包装：让工具失败可读，且不中断整轮对话 */
function guarded(name, fn) {
  return async (args, exec) => {
    try {
      const result = await fn(args ?? {}, exec)
      return clean(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${name} 失败：${message}`)
    }
  }
}

/**
 * 注册五个知识库工具。
 * @param {object} ctx 插件上下文
 * @param {object} kb  知识库服务实例
 * @returns {() => void} 卸载函数
 */
export function registerTools(ctx, kb) {
  const disposers = []

  const register = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  /* ─────────────── 1. kb_list：列库 / 列文档 / 看状态 ─────────────── */

  register({
    name: 'kb_list',
    description:
      '列出本地知识库、其中的文档，或查看运行状态。用于回答"我有哪些资料"、'
      + '确认某个库是否已建索引。不确定库名时先调用它。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['collections', 'documents', 'status'],
          description: 'collections 列所有库；documents 列某库的文档；status 看索引状态。默认 collections。',
        },
        collection: {
          type: 'string',
          description: '知识库名称或 id，target=documents 时必填。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: outputOf({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    execute: guarded('kb_list', async (args) => {
      const target = args.target ?? 'collections'

      if (target === 'status') {
        return kb.status()
      }

      if (target === 'collections') {
        const list = kb.listCollections()
        return {
          count: list.length,
          collections: list.map((c) => ({
            id: c.id,
            name: c.name,
            documents: c.document_count,
            chunks: c.chunk_count,
            bytes: c.bytes ?? 0,
            lastActivity: c.last_activity ? new Date(c.last_activity).toISOString() : null,
          })),
          hint: list.length === 0 ? '还没有知识库，先让用户在界面里新建一个。' : undefined,
        }
      }

      // target === 'documents'
      const collection = kb.resolveCollection(args.collection)
      if (!collection) {
        throw new Error(
          args.collection
            ? `找不到知识库「${args.collection}」`
            : '请指定 collection（知识库名称或 id）',
        )
      }
      const docs = kb.listDocuments(collection.id)
      return {
        collection: collection.name,
        count: docs.length,
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          type: String(d.ext ?? '').replace(/^\./, ''),
          pages: d.page_count ?? null,
          chunks: d.chunk_count,
          status: d.status,
          error: d.error ?? undefined,
        })),
      }
    }),
  })

  /* ─────────────── 2. kb_search：检索（核心工具）─────────────── */

  register({
    name: 'kb_search',
    description:
      '在本地知识库中检索资料，返回原文片段、文档名与页码。'
      + '当用户问的问题可能在他自己的文档里时，必须先调用它，再基于结果回答，'
      + '并注明出处。宁可先查一次，也不要凭记忆编造。'
      + '如果用户用输入框上方的「知识库」选了库，省略 collection 即在该库内检索。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索问题或关键词，用自然语言即可。',
        },
        collection: {
          type: 'string',
          description: '限定在某个知识库内检索；省略则在所有库中检索。',
        },
        limit: {
          type: 'number',
          description: '返回条数，默认 8，最多 20。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: outputOf({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    execute: guarded('kb_search', async (args, exec) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')

      let collectionId = null
      let scopeNote = null

      if (args.collection) {
        const collection = kb.resolveCollection(args.collection)
        if (!collection) throw new Error(`找不到知识库「${args.collection}」`)
        collectionId = collection.id
      } else {
        /*
         * 没指定库时，回落到用户在输入框上方选中的库。
         *
         * 这样模型按工具描述办事（只传 query）也能查到对的库，
         * 不必知道用户选了哪个。
         */
        const sessionId = exec?.agent?.id
        const picked = sessionId === undefined
          ? []
          : (kb.composerScopes?.get(String(sessionId))?.names ?? [])

        if (picked.length === 1) {
          const only = kb.resolveCollection(picked[0])
          if (only) collectionId = only.id
        } else if (picked.length > 1) {
          // 多选时全局检索会混库，明确告诉调用方当前范围
          scopeNote = `用户本轮选中了多个库：${picked.join('、')}；本次在全部库中检索`
        }
      }

      const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20)
      const result = await kb.semanticSearch(query, { collectionId, limit })

      const hits = (result.hits ?? []).map((hit) => ({
        title: hit.title,
        page: hit.page ?? null,
        heading: hit.heading ?? null,
        text: hit.text,
        similarity: typeof hit.similarity === 'number'
          ? Number(hit.similarity.toFixed(3))
          : null,
        rerankScore: typeof hit.rerankScore === 'number'
          ? Number(hit.rerankScore.toFixed(4))
          : null,
      }))

      return {
        query,
        mode: result.mode,
        count: hits.length,
        note: result.note,
        ...(scopeNote === null ? {} : { scopeNote }),
        hits,
        guidance: hits.length === 0
          ? '没有命中。可以换关键词再试，或如实告诉用户库里没有相关资料。'
          : '回答时请引用文档名与页码，例如「（《书名》第 3 页）」。',
      }
    }),
  })

  /* ─────────────── 3. kb_ingest：导入文件 ─────────────── */

  register({
    name: 'kb_ingest',
    description:
      '把文件或整个目录导入知识库。支持 PDF、Word、PPT、Excel、Markdown、TXT、HTML。'
      + '当用户说"把这份资料加进去"、或模型自己下载了文档需要入库时使用。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '一个或多个文件/目录路径。相对路径按当前工作目录解析。',
        },
        collection: {
          type: 'string',
          description: '目标知识库名称；省略则用第一个库。',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    output: outputOf({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    execute: guarded('kb_ingest', async (args, exec) => {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string') : []
      if (paths.length === 0) throw new Error('paths 不能为空')

      const collection = args.collection
        ? kb.resolveCollection(args.collection)
        : kb.ensureDefaultCollection()
      if (!collection) throw new Error(`找不到知识库「${args.collection}」`)

      const results = await kb.ingestPaths({
        paths,
        collectionId: collection.id,
        sessionId: exec?.agent?.session?.id ?? exec?.agent?.id ?? null,
      })

      return {
        collection: collection.name,
        imported: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      }
    }),
  })

  /* ─────────────── 4. kb_source_fetch：从网址抓取 ─────────────── */

  register({
    name: 'kb_source_fetch',
    description:
      '从一个公开网址抓取网页或文档并存入知识库，同时记录来源与抓取时间。'
      + '仅用于公开可访问的页面；遇到登录、付费、验证码会失败并返回原因。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的网址，必须是 http 或 https。',
        },
        collection: {
          type: 'string',
          description: '目标知识库名称；省略则用第一个库。',
        },
        title: {
          type: 'string',
          description: '存入库时的标题，省略则用网址。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: outputOf({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    execute: guarded('kb_source_fetch', async (args) => {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')

      const collection = args.collection
        ? kb.resolveCollection(args.collection)
        : kb.ensureDefaultCollection()
      if (!collection) throw new Error(`找不到知识库「${args.collection}」`)

      return kb.fetchSource({
        url,
        collectionId: collection.id,
        title: args.title ? String(args.title) : undefined,
      })
    }),
  })

  /* ─────────────── 5. kb_job：查进度 ─────────────── */

  register({
    name: 'kb_job',
    description:
      '查看知识库的长任务进度，例如正在建立的向量索引、批量导入。'
      + '用户问"好了没"、或需要确认后台任务状态时使用。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '任务 id；省略则列出最近的任务。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: outputOf({
      type: 'object',
      properties: {},
      additionalProperties: true,
    }),
    execute: guarded('kb_job', async (args) => {
      if (args.id) {
        const job = kb.store.getJob(String(args.id))
        if (!job) throw new Error(`找不到任务「${args.id}」`)
        return job
      }
      return {
        recent: kb.store.recentJobs(10),
        embed: kb.embedStatus(null),
      }
    }),
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载时忽略个别工具的清理失败
      }
    }
  }
}
