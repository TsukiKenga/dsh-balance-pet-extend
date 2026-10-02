// ============================================================================
// 厂商模板 —— 「怎么查这一家的余额/额度」
// ============================================================================
// 口径与覆盖面对齐 dsh-whale-widget 的 API_TEMPLATES，但只保留**真的能自动查到**的部分：
//   · kind: 'balance' —— 用 API key 查**金额**（元/美元）
//   · kind: 'quota'   —— 用 API key 查**订阅额度**（窗口用量 % + 重置时间，不是钱）
//   · kind: 'none'    —— 官方没有「用 API key 查余额」的接口，装了也查不到 → 不进来源菜单
//
// autoQueryable() 返回的是**只给一个 API key 就能查到**的那些（url 里不含 {base}）。
// 需要 baseUrl / 自定义地址的（openai_compat、custom）只能通过 .dshw-api.json 注册表带进来。
//
// auth 支持两种模板：'Bearer {key}' 与 '{key}'（智谱那类不带 Bearer 的）。
// url 支持 {base} 占位（仅注册表驱动的模板会用到）。
//
// ⚠️ quota 类必须标 sem：各家接口给的百分比语义**不统一** —— 有的报「已用 %」，
//    有的报「剩余 %」。不标就会被当成同一个意思显示出去。宿主统一换算成「剩余 %」再展示。
//      sem: 'used'   → 接口给的是已用百分比
//      sem: 'remain' → 接口给的是剩余百分比
// ============================================================================

export const TEMPLATES = {
  // ---------- 金额类：能用 API key 直接查 ----------
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', currency: 'CNY', keyRef: 'DEEPSEEK_API_KEY',
    kind: 'balance', builtin: true, matchIds: ['deepseek'],
    // DeepSeek 是内置特例：有 key 用 key，没 key 退回 DSH 账号登录态（见 index.js）
    balance: { url: 'https://api.deepseek.com/user/balance', auth: 'Bearer {key}', json: { remaining: 'balance_infos[0].total_balance' } },
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', currency: 'USD', keyRef: 'OPENROUTER_API_KEY',
    kind: 'balance', matchIds: ['openrouter'],
    balance: { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer {key}', json: { remaining: 'data.total_credits', minus: 'data.total_usage' } },
  },
  moonshot: {
    id: 'moonshot', name: 'Kimi / Moonshot（CN）', currency: 'CNY', keyRef: 'MOONSHOT_API_KEY',
    keyRefs: ["MOONSHOT_API_KEY"],
    kind: 'balance', matchIds: ['moonshot', 'kimi'],
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
  },
  moonshot_intl: {
    id: 'moonshot_intl', name: 'Kimi / Moonshot（国际）', currency: 'USD', keyRef: 'MOONSHOT_INTL_API_KEY',
    keyRefs: ["MOONSHOT_INTL_API_KEY"],
    kind: 'balance', matchIds: ['moonshot', 'kimi'],
    balance: { url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
  },
  stepfun: {
    id: 'stepfun', name: '阶跃星辰 StepFun', currency: 'CNY', keyRef: 'STEPFUN_API_KEY',
    kind: 'balance', matchIds: ['stepfun', 'step-'],
    balance: { url: 'https://api.stepfun.com/v1/accounts', auth: 'Bearer {key}', json: { remaining: 'balance' } },
  },
  novita: {
    id: 'novita', name: 'Novita AI', currency: 'USD', keyRef: 'NOVITA_API_KEY',
    kind: 'balance', matchIds: ['novita'],
    balance: { url: 'https://api.novita.ai/v3/user/balance', auth: 'Bearer {key}', json: { remaining: 'availableBalance', scale: 0.0001 } },
  },

  // ---------- 金额类：需要额外配置地址，只能由注册表带入 ----------
  openai_compat: {
    id: 'openai_compat', name: 'OpenAI 兼容中转站', currency: 'USD', keyRef: 'CUSTOM_API_KEY',
    kind: 'balance', needsBaseUrl: true, matchIds: [],
    // OneAPI / New API 一类网关的经典账单接口：额度(美元) 与 已用(美分) 分两个请求
    balance: { url: '{base}/v1/dashboard/billing/subscription', auth: 'Bearer {key}', json: { remaining: 'hard_limit_usd' } },
    usage: { url: '{base}/v1/dashboard/billing/usage', auth: 'Bearer {key}', json: { used: 'total_usage', scale: 0.01 } },
  },
  custom: {
    id: 'custom', name: '自定义 HTTP', currency: 'CNY', keyRef: 'CUSTOM_API_KEY',
    kind: 'balance', needsBaseUrl: true, matchIds: [],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },

  // ---------- 订阅额度类：查的是「窗口用量 %」，不是钱 ----------
  zhipu_glm_coding: {
    id: 'zhipu_glm_coding', name: '智谱 GLM Coding Plan（订阅）', currency: 'CNY', keyRef: 'ZHIPU_API_KEY',
    keyRefs: ["ZAI_CODING_CN_API_KEY","ZHIPU_API_KEY"],
    sem: 'used',
    kind: 'quota', matchIds: ['glm', 'zhipu'],
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      auth: '{key}', // 智谱此接口不带 Bearer
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
  },
  zhipu_glm_coding_intl: {
    id: 'zhipu_glm_coding_intl', name: '智谱 GLM Coding Plan（国际 z.ai）', currency: 'USD', keyRef: 'ZHIPU_INTL_API_KEY',
    keyRefs: ["ZAI_API_KEY","ZHIPU_INTL_API_KEY"],
    sem: 'used',
    kind: 'quota', matchIds: ['glm', 'zhipu'],
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      auth: '{key}',
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
  },
  kimi_coding: {
    id: 'kimi_coding', name: 'Kimi Coding（订阅）', currency: 'CNY', keyRef: 'KIMI_CODING_KEY',
    keyRefs: ["KIMI_API_KEY","KIMI_CODING_KEY"],
    sem: 'remain',
    kind: 'quota', matchIds: ['kimi'],
    quota: {
      url: 'https://api.kimi.com/coding/v1/usages', auth: 'Bearer {key}',
      json: { remain: 'usage.remaining', total: 'usage.limit', resetAt: 'usage.resetTime' },
    },
  },
  minimax_coding: {
    id: 'minimax_coding', name: 'MiniMax Coding（订阅）', currency: 'CNY', keyRef: 'MINIMAX_API_KEY',
    keyRefs: ["MINIMAX_CN_API_KEY"],
    sem: 'remain',
    kind: 'quota', matchIds: ['minimax'],
    quota: {
      url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
  },
  minimax_coding_intl: {
    id: 'minimax_coding_intl', name: 'MiniMax Coding（国际）', currency: 'USD', keyRef: 'MINIMAX_INTL_API_KEY',
    keyRefs: ["MINIMAX_API_KEY","MINIMAX_INTL_API_KEY"],
    sem: 'remain',
    kind: 'quota', matchIds: ['minimax'],
    quota: {
      url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
  },
  opencode_go: {
    id: 'opencode_go', name: 'OpenCode Go（订阅）', currency: 'USD', keyRef: 'OPENCODE_GO_API_KEY',
    keyRefs: ["OPENCODE_API_KEY","OPENCODE_GO_API_KEY"],
    sem: 'used',
    kind: 'quota', matchIds: ['opencode'],
    quota: {
      url: 'https://opencode.ai/zen/go/v1/usage', auth: 'Bearer {key}',
      json: {
        windows: [
          { key: 'rolling', label: '5h', percent: 'usage.rolling.percent', resetAt: 'usage.rolling.resetsAt' },
          { key: 'weekly', label: '周', percent: 'usage.weekly.percent', resetAt: 'usage.weekly.resetsAt' },
          { key: 'monthly', label: '月', percent: 'usage.monthly.percent', resetAt: 'usage.monthly.resetsAt' },
        ],
      },
    },
  },

  // ---------- 官方没有「用 API key 查余额」的接口：记录在案，但**不进来源菜单** ----------
  // 保留它们的意义：写清「为什么查不到」，免得日后又去试一遍。
  siliconflow_cn: { id: 'siliconflow_cn', name: '硅基流动（CN）', currency: 'CNY', keyRef: 'SILICONFLOW_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方已下线 /user/info 余额接口（2026-08-14 起停止服务）', matchIds: ['siliconflow', 'Qwen'] },
  siliconflow_en: { id: 'siliconflow_en', name: '硅基流动（EN）', currency: 'USD', keyRef: 'SILICONFLOW_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '同国内站：/user/info 余额接口已停止服务', matchIds: ['siliconflow'] },
  volcengine_ark: { id: 'volcengine_ark', name: '火山方舟 Ark', currency: 'CNY', keyRef: 'ARK_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '余额/用量需火山引擎 AK/SK 签名的 OpenAPI，API key 查不到', matchIds: ['doubao', 'ep-'] },
  openai: {
    id: 'openai', name: 'OpenAI', currency: 'USD', keyRef: 'OPENAI_API_KEY', kind: 'none', noBalanceApi: true,
    // 试过了，**结构上不可能**，不是「看 key 类型」也不是地区问题 —— OpenAI 自己的回复说得很清楚：
    //
    //   GET /v1/dashboard/billing/credit_grants
    //   → 403 {"error":"Your request to GET /v1/dashboard/billing/credit_grants must be made with
    //           a session key (that is, it can only be made from the browser).
    //           You made it with the following key type: secret."}
    //
    // 即：该接口只接受**浏览器会话 key**，而 DSH 凭据里存的是 sk-… **secret key**，永远不可能满足。
    // 换成 Admin key 也不行（那是另一套 /v1/organization/* 接口，给的是用量/花费而不是余额）。
    // 结论记在这里，别再试了。
    apiNote: '官方无公开余额接口。旧接口 /v1/dashboard/billing/credit_grants 只接受**浏览器会话 key**，'
      + '而 DSH 存的是 secret key → 403「must be made with a session key」，结构上不可能，已不提供。',
    matchIds: ['gpt', 'o1-', 'o3-', 'o4-'],
  },
  anthropic: { id: 'anthropic', name: 'Anthropic Claude', currency: 'USD', keyRef: 'ANTHROPIC_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口；用量要走 Admin API', matchIds: ['claude'] },
  gemini: { id: 'gemini', name: 'Google Gemini', currency: 'USD', keyRef: 'GEMINI_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口（配额只在控制台）', matchIds: ['gemini'] },
  xai: { id: 'xai', name: 'xAI Grok', currency: 'USD', keyRef: 'XAI_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无公开的余额查询接口', matchIds: ['grok'] },
  groq: { id: 'groq', name: 'Groq', currency: 'USD', keyRef: 'GROQ_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['llama', 'mixtral'] },
  mistral: { id: 'mistral', name: 'Mistral AI', currency: 'USD', keyRef: 'MISTRAL_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['mistral'] },
  together: { id: 'together', name: 'Together AI', currency: 'USD', keyRef: 'TOGETHER_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['meta-llama'] },
  fireworks: { id: 'fireworks', name: 'Fireworks AI', currency: 'USD', keyRef: 'FIREWORKS_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['accounts/fireworks'] },
  deepinfra: { id: 'deepinfra', name: 'DeepInfra', currency: 'USD', keyRef: 'DEEPINFRA_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: [] },
  cerebras: { id: 'cerebras', name: 'Cerebras', currency: 'USD', keyRef: 'CEREBRAS_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['llama'] },
  dashscope: { id: 'dashscope', name: '阿里云百炼（通义千问）', currency: 'CNY', keyRef: 'DASHSCOPE_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '云厂商：余额要走阿里云 AK/SK 的 OpenAPI', matchIds: ['qwen', 'qwq'] },
  qianfan: { id: 'qianfan', name: '百度千帆（文心）', currency: 'CNY', keyRef: 'QIANFAN_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '云厂商：余额要走百度云 AK/SK', matchIds: ['ernie'] },
  hunyuan: { id: 'hunyuan', name: '腾讯混元', currency: 'CNY', keyRef: 'HUNYUAN_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '云厂商：余额要走腾讯云 SecretId/Key', matchIds: ['hunyuan'] },
  spark: { id: 'spark', name: '讯飞星火', currency: 'CNY', keyRef: 'SPARK_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['spark'] },
  modelscope: { id: 'modelscope', name: '魔搭 ModelScope', currency: 'CNY', keyRef: 'MODELSCOPE_API_KEY', kind: 'none', noBalanceApi: true, apiNote: '官方无余额接口', matchIds: ['Qwen'] },
  ollama: { id: 'ollama', name: '本地模型（Ollama / LM Studio）', currency: 'CNY', keyRef: '', kind: 'none', noBalanceApi: true, apiNote: '本地推理没有余额概念', matchIds: ['llama', 'gemma'] },
  codex: { id: 'codex', name: 'Codex（本地会话）', currency: 'CNY', keyRef: '', kind: 'none', noBalanceApi: true, apiNote: '只有本地 token 统计，没有金额', matchIds: ['codex'] },
}

// 只给一个 API key 就能查到（url 里没有 {base} 占位）
export function autoQueryable() {
  const out = []
  for (const key of Object.keys(TEMPLATES)) {
    const t = TEMPLATES[key]
    if (t.kind !== 'balance' && t.kind !== 'quota') continue
    if (t.needsBaseUrl) continue
    const url = t.kind === 'quota' ? (t.quota && t.quota.url) : (t.balance && t.balance.url)
    if (!url || url.indexOf('{base}') >= 0) continue
    out.push(t)
  }
  return out
}

// 认证头：支持 'Bearer {key}' 与 '{key}'（智谱那类不带 Bearer 的）
export function authHeader(auth, key) {
  const a = String(auth || '')
  if (!a) return {}
  const v = a.replace(/\{key\}/g, String(key == null ? '' : key))
  return { Authorization: v }
}

// URL 占位替换：{base} 去掉尾部斜杠
export function fillUrl(url, base) {
  return String(url || '').replace(/\{base\}/g, String(base || '').replace(/\/+$/, ''))
}
