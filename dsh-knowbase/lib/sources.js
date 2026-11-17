/**
 * 权威来源清单。
 *
 * 这份清单是插件的核心资产：它不是"允许列表"（用户可自己决定抓哪里），
 * 而是一份**质量有保证的起点**，并带上每个站点的许可提示，
 * 免得模型抓到来源不明、错漏多的转手资料。
 *
 * 字段说明：
 *   id      稳定标识
 *   name    展示名
 *   host    主机名（用于匹配与提示）
 *   entry   检索或入口网址
 *   use     取用方式说明
 *   license 许可与限制（很重要，必须如实告知用户）
 *   topic   主题分类
 *   verified 最近一次人工核实可访问的日期
 */

export const TOPICS = {
  science: '自然科学',
  humanities: '马列原理 / 人文社科',
}

export const SOURCES = [
  /* ───────────────── 自然科学 ───────────────── */
  {
    id: 'nstl',
    topic: 'science',
    name: '国家科技图书文献中心 NSTL',
    host: 'nstl.gov.cn',
    entry: 'https://www.nstl.gov.cn',
    use: '检索中外文期刊、会议、学位论文；只取公开摘要与开放全文。',
    license: '部分资源需机构账号；未授权内容不要抓全文。',
    verified: '2026-11-16',
  },
  {
    id: 'ncpssd',
    topic: 'science',
    name: '国家哲学社会科学文献中心',
    host: 'ncpssd.org',
    entry: 'https://www.ncpssd.org',
    use: '注册后免费下载社科期刊全文。',
    license: '注册后免费，但禁止批量抓取；请遵守站点条款。',
    verified: '2026-11-16',
  },
  {
    id: 'stats-gov',
    topic: 'science',
    name: '国家统计局',
    host: 'data.stats.gov.cn',
    entry: 'https://data.stats.gov.cn',
    use: '统计数据、年鉴、普查数据。',
    license: '公开数据，引用时须注明来源。',
    verified: '2026-11-16',
  },
  {
    id: 'openstd',
    topic: 'science',
    name: '国家标准全文公开系统',
    host: 'openstd.samr.gov.cn',
    entry: 'https://openstd.samr.gov.cn',
    use: '强制性国家标准在线阅读。',
    license: '以在线阅读为主；**不得商用转载**，仅供个人学习参考。',
    verified: '2026-11-16',
  },
  {
    id: 'arxiv',
    topic: 'science',
    name: 'arXiv 预印本',
    host: 'arxiv.org',
    entry: 'https://arxiv.org',
    use: '数理、计算机、生物等领域的预印本论文。',
    license: '**非同行评议**，引用时必须标注「预印本（preprint）」。',
    verified: '2026-11-16',
  },
  {
    id: 'pmc',
    topic: 'science',
    name: 'PubMed Central 开放获取',
    host: 'ncbi.nlm.nih.gov',
    entry: 'https://www.ncbi.nlm.nih.gov/pmc/',
    use: '生物医学开放获取全文。',
    license: '仅开放获取子集；按单篇许可，商用前需核对。',
    verified: '2026-11-16',
  },
  {
    id: 'openstax',
    topic: 'science',
    name: 'OpenStax 开放教材',
    host: 'openstax.org',
    entry: 'https://openstax.org',
    use: '大学基础学科教材，可整本下载。',
    license: '**CC BY**：可再利用，但必须署名。',
    verified: '2026-11-16',
  },
  {
    id: 'libretexts',
    topic: 'science',
    name: 'LibreTexts 教材库',
    host: 'libretexts.org',
    entry: 'https://libretexts.org',
    use: '多学科开放教材与讲义。',
    license: '多为 **CC BY-NC-SA**，注意非商用条款。',
    verified: '2026-11-16',
  },
  {
    id: 'doaj',
    topic: 'science',
    name: 'DOAJ 开放获取期刊目录',
    host: 'doaj.org',
    entry: 'https://doaj.org',
    use: '检索开放获取期刊文章。',
    license: '按单篇许可（多为 CC）。',
    verified: '2026-11-16',
  },
  {
    id: 'cas-ir',
    topic: 'science',
    name: '中国科学院机构知识库',
    host: 'ir.ac.cn',
    entry: 'https://www.ir.ac.cn',
    use: '中科院院属研究所的论文与报告。',
    license: '按单篇许可，多为作者保留或 CC。',
    verified: '2026-11-16',
  },

  /* ───────────────── 马列 / 人文社科 ───────────────── */
  {
    id: 'qstheory',
    topic: 'humanities',
    name: '求是网（《求是》杂志）',
    host: 'qstheory.cn',
    entry: 'https://www.qstheory.cn',
    use: '党的理论文章、评论、理论学习材料。',
    license: '公开可读；转载须注明出处。',
    verified: '2026-11-16',
  },
  {
    id: 'dswxyjy',
    topic: 'humanities',
    name: '中央党史和文献研究院',
    host: 'dswxyjy.org.cn',
    entry: 'https://www.dswxyjy.org.cn',
    use: '经典著作、文献研究、党史资料。',
    license: '公开文献；**经典原文以官方出版版本为准**，注意版本差异。',
    verified: '2026-11-16',
  },
  {
    id: 'nopss',
    topic: 'humanities',
    name: '全国哲学社会科学工作办公室',
    host: 'nopss.gov.cn',
    entry: 'http://www.nopss.gov.cn',
    use: '社科基金项目成果、通知公告。',
    license: '公开信息。',
    verified: '2026-11-16',
  },
  {
    id: 'nlc',
    topic: 'humanities',
    name: '国家图书馆公开资源',
    host: 'nlc.cn',
    entry: 'https://www.nlc.cn',
    use: '民国文献、古籍数字化资源。',
    license: '部分需注册；**古籍使用另有专门规定**，商用前务必确认。',
    verified: '2026-11-16',
  },
]

/** 按主题分组 */
export function sourcesByTopic() {
  const groups = {}
  for (const source of SOURCES) {
    if (!groups[source.topic]) {
      groups[source.topic] = { topic: source.topic, label: TOPICS[source.topic] ?? source.topic, sources: [] }
    }
    groups[source.topic].sources.push(source)
  }
  return Object.values(groups)
}

/** 按主机名找来源（抓取时提示许可用） */
export function sourceForHost(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (host === '') return null
  return SOURCES.find((s) => host === s.host || host.endsWith(`.${s.host}`)) ?? null
}

/** 生成给模型看的来源摘要（放在技能或工具提示里） */
export function sourcesSummary() {
  const lines = ['## 可优先考虑的公开来源', '']
  for (const group of sourcesByTopic()) {
    lines.push(`### ${group.label}`, '')
    for (const s of group.sources) {
      lines.push(`- **${s.name}**（${s.host}）— ${s.use} 许可：${s.license}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
