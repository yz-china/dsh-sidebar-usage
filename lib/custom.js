/**
 * dsh-deepseek-usage — 自定义 provider（自定义 URL）。
 *
 * 能力表里没有的网关 / 中转（例如自建的 new-api、one-api、任何返回 JSON 余额的
 * 中间层）可以用 `customProviders` 显式登记：给一个 baseUrl、一条路径、认证方式，
 * 再用点路径（`data.limit_remaining`、`0.total_balance`）指出哪个字段是余额。
 *
 * 设计口径与 lib/providers.js 一致：**不猜**。地址、路径、字段名全部由用户给出；
 * 猜出来的读数与账单无关。所以：
 *   · 没给 baseUrl → 整条丢弃并记 warning；
 *   · 没给 totalPath 且不是预设形态 → 解析失败（shape），不假装读到了 0；
 *   · 读不到剩余额度时（例如 new-api 的 `/v1/dashboard/billing/subscription`
 *     只返回哨兵值 1e8），退回显示「已用」，币种位写 USED —— 绝不把已用当成余额。
 *
 * 预设三种常见形态，省掉手填路径：
 *   · json              通用 GET，一个响应里按 totalPath 取值；
 *   · deepseek-balance  `GET /user/balance`（与官方同形，可指向中转）；
 *   · openai-billing    `/v1/dashboard/billing/{subscription,usage}` 两段式（OpenAI 口径，usage 为分）；
 *   · newapi           同上，但 usage 按 new-api 的 quota 单位（默认不缩放，币种 CNY）。
 */

/** provider id 的宽松上限；只挡空白与异常长度（与 providers.js 同口径）。 */
const MAX_ID_LENGTH = 128;

/** 凭据引用名必须是环境变量名形态。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const CUSTOM_KINDS = ['balance', 'usage'];
export const CUSTOM_AUTHS = ['bearer', 'raw', 'none'];
export const CUSTOM_PRESETS = ['json', 'deepseek-balance', 'openai-billing', 'newapi', 'newapi-account', 'jichuanai'];

/**
 * 预设默认值。`path` 是主请求，`usagePath` 是第二段请求（可选）。
 * `scale` 乘在解析出的数字上：OpenAI 的 usage 单位是"分"，所以 0.01；
 * new-api 实测的 total_usage 已经是"额度单位"（1 单位 = quota_per_unit），保持 1。
 */
const PRESET_DEFAULTS = {
  json: { path: '', usagePath: '', currency: 'CNY', scale: 1 },
  'deepseek-balance': { path: '/user/balance', usagePath: '', currency: 'CNY', scale: 1 },
  'openai-billing': {
    path: '/v1/dashboard/billing/subscription',
    usagePath: '/v1/dashboard/billing/usage',
    currency: 'USD',
    scale: 0.01,
  },
  newapi: {
    path: '/v1/dashboard/billing/subscription',
    usagePath: '/v1/dashboard/billing/usage',
    currency: 'CNY',
    scale: 1,
  },
  // new-api 账号接口：GET /api/user/self → data.quota（剩余额度）/ data.used_quota（已用）
  // 换算率每家不同（1 元 = 500000 配额是 new-api 默认），由 currency/scale 决定怎么显示。
  // availablePath 用 data.status：status 为 1 表示账号可用，0 表示被禁用。
  'newapi-account': {
    path: '/api/user/self',
    totalPath: 'data.quota',
    usedPath: 'data.used_quota',
    availablePath: 'data.status',
    currency: 'CNY',
    scale: 1 / 500000,
  },
  // 济川AI（jc.jichuanai.com）：实测 GET /api/v1/subscriptions →
  //   data[0].group.weekly_limit_usd（额度）/ weekly_usage_usd（已用）/ expires_at（到期）
  // 余额口径：GET /api/v1/user/profile → data.balance
  jichuanai: {
    path: '/api/v1/subscriptions',
    totalPath: 'data.0.group.weekly_limit_usd',
    usedPath: 'data.0.weekly_usage_usd',
    expiresPath: 'data.0.expires_at',
    balancePath: '/api/v1/user/profile',
    balanceTotalPath: 'data.balance',
    currency: 'USD',
    scale: 1,
  },
};

/** `ASNIA` → `ASNIA_API_KEY`：与 providers.js 的派生引用同一规则。 */
export function derivedKeyRef(provider) {
  return `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 同 text()，但 undefined/null 也给空串以外的东西不炸：专供预设默认值。 */
function orEmpty(value) {
  return typeof value === 'string' ? value : '';
}

/** 接受字符串或数字，返回有限数或 null（绝不把缺失变成 0）。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** baseUrl：只接受 http(s)，保留路径前缀（网关常挂在 /api 下），去掉尾部斜杠。 */
function normalizeBaseUrl(raw) {
  const value = text(raw);
  if (value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** 路径：缺省用预设值；必须以 / 开头。 */
function normalizePath(raw, fallback) {
  const value = text(raw);
  const fb = typeof fallback === 'string' ? fallback : '';
  const path = value === '' ? fb : value;
  if (path === '') return '';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * 按点路径从 JSON 里取值：`data.limit_remaining`、`balance_infos.0.total_balance`、
 * `items[0].total` 都支持。取不到返回 undefined（调用方据此报 empty，而不是 0）。
 */
export function readPath(body, path) {
  const spec = text(path);
  if (spec === '') return undefined;
  let current = body;
  for (const rawSegment of spec.split('.')) {
    let segment = rawSegment.trim();
    if (segment === '') return undefined;
    let index = null;
    const bracket = segment.match(/^(.*)\[(\d+)\]$/);
    if (bracket !== null) {
      segment = bracket[1];
      index = Number(bracket[2]);
    }
    if (segment !== '') {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[segment];
    }
    if (index !== null) {
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    }
  }
  return current;
}

/**
 * 把配置里的 `customProviders` 整理成可查询的 Map。
 *
 * 接受 `[{ provider, baseUrl, … }]`；非法项整体丢弃并记一条 warning（由调用方写进
 * 日志，避免坏配置静默生效）。重复 provider 取第一条。
 *
 * @param {unknown} raw `config.customProviders`
 * @returns {{ providers: Map<string, object>, warnings: string[] }}
 */
export function normalizeCustomProviders(raw) {
  const providers = new Map();
  const warnings = [];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.get === 'function') {
    try {
      return normalizeCustomProviders(raw.get());
    } catch {
      warnings.push('customProviders 无法读取，已忽略');
      return { providers, warnings };
    }
  }
  if (raw === undefined || raw === null) return { providers, warnings };
  if (!Array.isArray(raw)) {
    warnings.push('customProviders 不是数组，已忽略');
    return { providers, warnings };
  }

  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push('忽略了一条不是对象的自定义 provider');
      continue;
    }
    const provider = text(item.provider);
    if (provider === '' || provider.length > MAX_ID_LENGTH || /\s/.test(provider)) {
      warnings.push('忽略了一条 provider id 非法的自定义 provider');
      continue;
    }
    const baseUrl = normalizeBaseUrl(item.baseUrl);
    if (baseUrl === null) {
      warnings.push(`忽略自定义 provider ${provider}：baseUrl 必须是 http(s) 地址`);
      continue;
    }
    const presetRaw = text(item.preset).toLowerCase();
    const preset = CUSTOM_PRESETS.includes(presetRaw) ? presetRaw : 'json';
    const defaults = PRESET_DEFAULTS[preset];
    const kindRaw = text(item.kind).toLowerCase();
    const kind = CUSTOM_KINDS.includes(kindRaw) ? kindRaw : 'balance';
    const authRaw = text(item.auth).toLowerCase();
    const auth = CUSTOM_AUTHS.includes(authRaw) ? authRaw : 'bearer';
    const currency = (text(item.currency) || defaults.currency).toUpperCase();
    const scale = num(item.scale);
    const quota = num(item.quota);
    const refRaw = text(item.apiKeyRef);
    // 引用名与明文密钥都允许：明文原样保留，交给取数层直接当 secret；
    // 只有留空时才回退到派生引用（provider → PROVIDER_API_KEY）。
    const ref = refRaw !== "" ? refRaw : derivedKeyRef(provider);

    // 账户类型：balance = 看余额接口；subscription = 看订阅额度（含已用与到期）；
    // auto = 配了 usedPath/expiresPath 就按订阅，否则按余额。
    const typeRaw = text(item.accountType).toLowerCase();
    const balancePath = normalizePath(item.balancePath, defaults.balancePath ?? '');
    const balanceTotalPath = text(item.balanceTotalPath) || (defaults.balanceTotalPath ?? '');
    const configuredType = typeRaw === 'balance' || typeRaw === 'subscription' ? typeRaw : 'auto';
    const looksSubscription = text(item.usedPath) !== '' || text(item.expiresPath) !== '';
    const accountType = configuredType === 'auto'
      ? (looksSubscription ? 'subscription' : 'balance')
      : configuredType;

    const path = normalizePath(item.path, defaults.path);
    if (path === '') {
      warnings.push(`忽略自定义 provider ${provider}：preset=json 时必须给出 path`);
      continue;
    }
    const usagePath = normalizePath(item.usagePath, defaults.usagePath);

    const key = provider.toLowerCase();
    if (providers.has(key)) {
      warnings.push(`忽略重复的自定义 provider：${provider}`);
      continue;
    }
    // 按当前类型决定实际请求哪一组（另一组字段保留，切换时不必重填）。
    const useSubscription = accountType === 'subscription';
    const pickedPath = useSubscription ? path : (balancePath !== '' ? balancePath : path);
    const subTotalPath = text(item.totalPath) || (defaults.totalPath ?? '');
    const subUsedPath = text(item.usedPath) || (defaults.usedPath ?? '');
    const subExpiresPath = text(item.expiresPath) || (defaults.expiresPath ?? '');
    const pickedTotal = useSubscription ? subTotalPath : (balanceTotalPath !== '' ? balanceTotalPath : subTotalPath);
    // 余额形态也要认 usedPath：new-api 账号接口同时给"剩余 quota"和"已用 used_quota"，
    // 有了两段才能算出百分比条；订阅形态才需要到期时间。
    const balUsedPath = text(item.balanceUsedPath) || (defaults.usedPath ?? '');
    const pickedUsed = useSubscription ? subUsedPath : balUsedPath;
    const pickedExpires = useSubscription ? subExpiresPath : '';
    if (pickedPath === '') {
      warnings.push(`忽略自定义 provider ${provider}：path / balancePath 至少要给一个`);
      continue;
    }

    const label = text(item.label);
    providers.set(key, {
      id: provider,
      displayName: label === '' ? provider : label,
      kind,
      // 只有显式登记的 provider 才带 custom：accounts.js 据此走自定义取数分支。
      custom: {
        preset,
        baseUrl,
        // 生效组（按 accountType 选好）
        path: pickedPath,
        totalPath: pickedTotal,
        usedPath: pickedUsed,
        expiresPath: pickedExpires,
        availablePath: text(item.availablePath),
        // 两组原始值，编辑表单切换类型时用
        accountType,
        rawPath: path,
        rawTotalPath: subTotalPath,
        rawUsedPath: subUsedPath,
        rawExpiresPath: subExpiresPath,
        balancePath,
        balanceTotalPath,
        usagePath,
        auth,
        currency,
        scale: scale === null || scale <= 0 ? defaults.scale : scale,
        quota: quota === null || quota <= 0 ? 0 : quota,
        // 原样记住，供取数层判断"引用名还是明文密钥"。
        apiKeyRef: refRaw,
        // 可选：借用哪家主流的单价表算「每 token 价格」。中转站自己的名字不在价格表里，
        // 不填就只能是 known:false（卡片不显示单价）。
        pricing: text(item.pricing).toLowerCase(),
      },
      refs: [ref],
    });
  }
  return { providers, warnings };
}

/** 认证头：raw = 原样放进 Authorization（部分网关要求裸 key），none = 不带。 */
export function customHeaders(auth, secret) {
  if (auth === 'none') return {};
  if (auth === 'raw') return { Authorization: secret };
  return { Authorization: `Bearer ${secret}` };
}

/** 账单类接口按自然月区间查询（当月 1 日 → 今天）。 */
function monthRangeQuery() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `?start_date=${start}&end_date=${end}`;
}

/**
 * 这次读要打哪些请求。
 * @returns {Array<{ key: 'main' | 'usage', url: string }>}
 */
export function customTargets(spec) {
  const targets = [{ key: 'main', url: `${spec.baseUrl}${spec.path}` }];
  if (spec.usagePath !== '' && spec.usagePath !== spec.path) {
    const query = spec.preset === 'openai-billing' || spec.preset === 'newapi' ? monthRangeQuery() : '';
    targets.push({ key: 'usage', url: `${spec.baseUrl}${spec.usagePath}${query}` });
  }
  return targets;
}

function fail(code) {
  return { ok: false, balance: null, usage: null, code };
}

function okBalance(balance, usage = null, expiresAt = null) {
  return { ok: true, balance, usage, expiresAt };
}

/** DeepSeek 同形响应：{ is_available, balance_infos: [{ currency, total_balance }] }。 */
function parseDeepseekShape(spec, body) {
  if (body?.is_available === false) return fail('unavailable');
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) return fail('shape');
  const withTotal = infos.filter((info) => num(info?.total_balance) !== null);
  if (withTotal.length === 0) return fail('empty');
  const want = spec.currency;
  const pick = withTotal.find((info) => String(info?.currency ?? '').trim().toUpperCase() === want) ?? withTotal[0];
  const total = num(pick.total_balance);
  if (total === null) return fail('empty');
  return okBalance({
    isAvailable: true,
    total: round2(total * spec.scale),
    currency: want === '' ? String(pick.currency ?? '').trim().toUpperCase() || null : want,
  });
}

/**
 * 两段式账单（OpenAI / new-api）：
 *   subscription → hard_limit_usd（额度；new-api 实测恒为 1e8 哨兵，视为"额度未知"）
 *   usage        → total_usage（已用）
 *
 * 额度已知 → total = 额度 - 已用，币种按配置；
 * 额度未知 → total = 已用，币种位写 USED（绝不把已用显示成余额）；
 * 配置了 quota → 以 quota 为准（用户自己知道站长给了多少）。
 */
function parseBilling(spec, subscription, usageBody) {
  const hard = num(readPath(subscription, 'hard_limit_usd'));
  const usedRaw = num(readPath(usageBody, 'total_usage'));
  const used = usedRaw === null ? null : round2(usedRaw * spec.scale);
  // 1e7 以上当哨兵：new-api 的 unlimited 占位值是 1e8。
  const shipped = hard !== null && hard > 0 && hard < 1e7 ? hard : null;
  const cap = spec.quota > 0 ? spec.quota : shipped;

  if (cap === null && used === null) return fail('empty');
  // 额度已知但已用读不到（字段缺失/非数字/接口改版）：不能把已用当 0，
  // 那样卡片会显示满额度，看起来像"余额自己涨回去了"。宁可报空，保留上一次读数。
  if (cap !== null && used === null) return fail('empty');
  const balance = { isAvailable: true, total: null, currency: spec.currency };
  if (cap !== null) {
    balance.total = round2(cap - used);
  } else {
    balance.total = used;
    // 「已用」不是余额：币种位写成 USED，卡片会显示 "USED 17.17" 而不是 "¥ 17.17"。
    balance.currency = 'USED';
  }
  const windows = [];
  if (used !== null && cap !== null && cap > 0) {
    windows.push({
      key: 'cycle',
      percent: Math.max(0, Math.min(100, (used / cap) * 100)),
      resetsAt: null,
    });
  }
  return okBalance(balance, windows.length === 0 ? null : { windows });
}

/** 通用 JSON：按用户给的点路径取值。 */
function parseJsonPreset(spec, main, usageBody) {
  const availableRaw = spec.availablePath === '' ? undefined : readPath(main, spec.availablePath);
  if (availableRaw === false) return fail('unavailable');
  // 订阅到期时间（ISO 字符串或秒/毫秒时间戳都接受），仅当配置了 expiresPath。
  let expiresAt = null;
  if (typeof spec.expiresPath === "string" && spec.expiresPath !== "") {
    const raw = readPath(main, spec.expiresPath);
    if (typeof raw === "string" && raw !== "") {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) expiresAt = t;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      expiresAt = raw > 1e12 ? raw : raw * 1000;
    }
  }
  const totalRaw = spec.totalPath === '' ? undefined : readPath(main, spec.totalPath);
  const usedSource = spec.usedPath === '' ? undefined : readPath(usageBody ?? main, spec.usedPath);
  const totalNum = totalRaw === undefined ? null : num(totalRaw);
  const usedNum = usedSource === undefined ? null : num(usedSource);
  if (totalRaw !== undefined && totalNum === null) return fail('shape');
  if (usedSource !== undefined && usedNum === null) return fail('shape');
  if (totalNum === null && usedNum === null) return fail(spec.totalPath === '' ? 'shape' : 'empty');

  const balance = { isAvailable: availableRaw === true ? true : null, total: null, currency: spec.currency };
  if (totalNum !== null && usedNum !== null) {
    // 给了"额度 + 已用"两段（例如订阅卡：weekly_limit_usd / weekly_usage_usd）时，
    // totalPath 表示**额度**而不是剩余，这里算成剩余额度，百分比另由 windows 给出。
    balance.total = round2((totalNum - usedNum) * spec.scale);
  } else if (totalNum !== null) {
    balance.total = round2(totalNum * spec.scale);
  } else {
    balance.total = round2(usedNum * spec.scale);
    balance.currency = 'USED';
  }
  const windows = [];
  if (totalNum !== null && usedNum !== null && totalNum > 0) {
    windows.push({ key: 'cycle', percent: Math.max(0, Math.min(100, (usedNum / totalNum) * 100)), resetsAt: null });
  }
  return okBalance(balance, windows.length === 0 ? null : { windows }, expiresAt);
}

/**
 * 解析自定义 provider 的响应体。
 *
 * @param entry 归一后的自定义 entry（含 `custom` 规格）
 * @param payloads 按 customTargets 的 key 收集到的 JSON 体：{ main, usage? }
 */
export function parseCustomPayload(entry, payloads) {
  const spec = entry?.custom;
  if (spec === undefined || spec === null) return fail('shape');
  const main = payloads?.main;
  const usageBody = payloads?.usage;
  if (spec.preset === 'deepseek-balance') return parseDeepseekShape(spec, main);
  if (spec.preset === 'openai-billing' || spec.preset === 'newapi') {
    return parseBilling(spec, main, usageBody);
  }
  return parseJsonPreset(spec, main, usageBody);
}