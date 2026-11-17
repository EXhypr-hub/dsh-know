/**
 * 宿主能力探测。
 *
 * 为什么要这个：
 *   插件要支持 DSH 的多个版本（当前声明 >=0.1.7-rc.2）。
 *   与其猜版本号，不如直接检查要用的 API 在不在——
 *   缺失就走降级路径，而不是让整个插件抛错。
 *
 * 依据：DSH 安装目录自带的 docs/upgrade-guide/ 里，
 *   从 v0.1.7-rc.2 到 v0.2.2-rc.1 的 213 条破坏性变更中，
 *   没有一条涉及本插件用到的 slots / connection.fetch / tools / skills / locale。
 *   这份探测是防御性的：万一将来变了，降级而不是崩。
 */

/**
 * 探测 Host 侧能力。
 * @param {object} ctx 插件上下文
 * @returns {{ slot: boolean, tools: boolean, skills: boolean, routes: boolean, credentials: boolean, missing: string[] }}
 */
export function detectHostCapabilities(ctx) {
  const missing = []

  const hasEffect = typeof ctx?.effect === 'function'
  if (!hasEffect) missing.push('ctx.effect')

  const hasInject = typeof ctx?.inject === 'function'
  if (!hasInject) missing.push('ctx.inject')

  // connection.fetch.register 是前端所有 API 的唯一入口，缺失时插件等于不可用
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  const routes = typeof connection?.fetch?.register === 'function'
  if (!routes) missing.push('connection.fetch.register')

  const tools = typeof ctx?.get === 'function'
    && typeof ctx.get('tools')?.register === 'function'
  if (!tools) missing.push('tools.register')

  const skills = typeof ctx?.get === 'function'
    && typeof ctx.get('skills')?.register === 'function'
  if (!skills) missing.push('skills.register')

  // 凭据是可选增强：没有它就用「存本地」的降级路径
  const credentials = typeof ctx?.get === 'function'
    && ctx.get('credentials') !== undefined

  return {
    effect: hasEffect,
    inject: hasInject,
    routes,
    tools,
    skills,
    credentials,
    missing,
    /**
     * 能不能提供最基本的服务。
     * 没有路由注册能力就完全没法用；effect/inject 缺失则生命周期不可靠。
     */
    usable: hasEffect && hasInject && routes,
  }
}

/**
 * 生成一句人看的诊断，写进状态和日志。
 *
 * 区分「必需」和「可选」：缺 tools/skills/credentials 只是少几个能力，
 * 缺 effect/inject/connection.fetch 才是真的不能用。
 * @param {ReturnType<typeof detectHostCapabilities>} caps
 */
export function describeHostCapabilities(caps) {
  const CRITICAL = ['ctx.effect', 'ctx.inject', 'connection.fetch.register']
  const criticalMissing = CRITICAL.filter((name) => caps.missing.includes(name))

  if (criticalMissing.length > 0) {
    return `当前 DSH 版本缺少必要的插件 API：${criticalMissing.join('、')}。`
      + '请升级 DeepSeek Harness 后重试。'
  }

  const lost = []
  if (!caps.tools) lost.push('智能体工具')
  if (!caps.skills) lost.push('技能')
  if (!caps.credentials) lost.push('凭据库')

  const base = '宿主 API 完整'
  if (lost.length === 0) return `${base}（检索、导入、工具、技能、凭据库均可用）`
  return `${base}，但当前版本缺少可选能力：${lost.join('、')}；检索与导入不受影响。`
}
