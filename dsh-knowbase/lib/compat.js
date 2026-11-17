/**
 * 宿主能力探测。
 *
 * ⚠️ 这里踩过一个坑，留作教训：
 *   最初在 apply() 开头用 ctx.get('connection') 判断路由能力，
 *   但 Cordis 的服务是**异步就绪**的——apply 执行时 ctx.get() 往往还返回
 *   undefined。结果探测判定「版本不兼容」，apply 直接 return，
 *   工具和路由一个都没注册。插件在列表里显示 active，一用就「请求失败」。
 *
 * 所以现在分两层：
 *   core     —— ctx.effect / ctx.inject 这类 Cordis 核心方法，apply 时一定有，
 *               可以用它决定「要不要继续」；
 *   deferred —— connection / tools / skills 这类服务，apply 时不可靠，
 *               只能在 ctx.inject 回调里确认，且**永远不用于阻止注册**。
 *
 * 探测的用途是「诊断」，不是「拦截」。
 */

/**
 * 检查 Cordis 核心方法。
 * 这两个缺失说明插件系统本身有问题，任何插件都跑不起来。
 * @param {object} ctx
 */
export function checkCore(ctx) {
  const missing = []
  if (typeof ctx?.effect !== 'function') missing.push('ctx.effect')
  if (typeof ctx?.inject !== 'function') missing.push('ctx.inject')
  return {
    available: missing.length === 0,
    missing,
  }
}

/**
 * 检查可选服务。**只能在 ctx.inject 回调里调用**，
 * 那时服务已经就绪，结果才可信。
 * @param {object} scope 注入后的作用域
 */
export function checkServices(scope) {
  const has = (name, path) => {
    try {
      let value = scope
      for (const key of path) value = value?.[key]
      return typeof value === 'function'
    } catch {
      return false
    }
  }

  return {
    // connection.fetch.register 是前端所有 API 的唯一入口
    routes: has('connection', ['connection', 'fetch', 'register']),
    tools: has('tools', ['tools', 'register']),
    skills: has('skills', ['skills', 'register']),
    credentials: (() => {
      try {
        return scope?.credentials !== undefined
      } catch {
        return false
      }
    })(),
  }
}

/**
 * 生成给人看的诊断。
 * @param {{ available: boolean, missing: string[] }} core
 * @param {{ routes?: boolean, tools?: boolean, skills?: boolean, credentials?: boolean }} [services]
 */
export function describeCapabilities(core, services) {
  if (!core.available) {
    return `当前 DSH 缺少 Cordis 核心方法：${core.missing.join('、')}。`
      + '这不是插件能处理的，请重新安装 DeepSeek Harness。'
  }

  if (!services) {
    // 服务还没确认，不要妄下结论
    return 'Cordis 核心方法齐全，可选服务待连接后确认。'
  }

  const ok = []
  if (services.routes) ok.push('前端接口')
  if (services.tools) ok.push('智能体工具')
  if (services.skills) ok.push('技能')
  if (services.credentials) ok.push('凭据库')

  const lost = []
  if (!services.routes) lost.push('前端接口')
  if (!services.tools) lost.push('智能体工具')
  if (!services.skills) lost.push('技能')
  if (!services.credentials) lost.push('凭据库')

  if (lost.length === 0) {
    return `宿主 API 完整（${ok.join('、')}均可用）`
  }
  if (!services.routes) {
    return `前端接口不可用，界面无法工作；其余能力：${ok.join('、') || '无'}`
  }
  return `宿主 API 基本可用，缺少：${lost.join('、')}`
}
