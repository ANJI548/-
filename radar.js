/**
 * 反缩水雷达 · 核心计算层
 * ============================================================
 * 设计原则：取数交给 MCP，算术交给代码，表达交给 Agent。
 * 本模块全部是纯函数：输入官方数据，输出评分与结论，不发请求、不调大模型，
 * 不生成任何图表或 Markdown 表格——对外只产出纯文本终端结果。
 *
 * 指标说明（重要）：
 *   麦当劳 MCP 的营养接口不提供克重，只提供每份热量（kcal）。
 * 热量与分量基本成正比，因此内部以「元/100kcal」折算性价比；
 * 该中间度量不对外暴露，报告只呈现现价、热量与星级。
 */

/** 默认配置：星级阈值、价位带、基准有效期等，均可按需覆盖 */
export const DEFAULT_CONFIG = {
  // 衰减百分比（性价比较基准的降幅）分界，映射 1~5 星
  starThresholds: [0, 5, 15, 30],
  // 无有效基准时，按菜单内横向百分位评级的档位
  percentileBands: [20, 40, 60, 80],
  // 替代品价位带：目标价格 ±20%
  priceBand: 0.2,
  // 基准最大有效天数：超过则视为过期，纵向缩水评分才可信
  baselineMaxAgeDays: 90,
  // 基准至少存在的天数：不足则只记录不评分，走横向百分位
  baselineMinAgeDays: 30,
};

/**
 * 历史基准（Skill 配置常量）：纵向缩水检测的依据。
 * 每个条目记录采集时的价格与热量；建议每季度用 MCP 实时数据刷新，
 * 基准越老，衰减百分比越能反映真实缩水趋势。
 * 当前为首测基线：2026-10-14 由麦当劳 MCP 实时抓取（北京中关村店）。
 */
export const DEFAULT_BASELINES = {
  巨无霸: { price: 25.5, kcal: 513, capturedAt: '2026-10-14' },
  麦辣鸡腿汉堡: { price: 22.5, kcal: 485, capturedAt: '2026-10-14' },
  板烧鸡腿堡: { price: 23.5, kcal: 391, capturedAt: '2026-10-14' },
  双层吉士汉堡: { price: 23.0, kcal: 429, capturedAt: '2026-10-14' },
  麦香鱼: { price: 22.5, kcal: 325, capturedAt: '2026-10-14' },
  麦香鸡: { price: 17.0, kcal: 369, capturedAt: '2026-10-14' },
  麦乐鸡5块: { price: 14.0, kcal: 213, capturedAt: '2026-10-14' },
  中薯条: { price: 13.5, kcal: 289, capturedAt: '2026-10-14' },
  圆筒冰淇淋: { price: 5.0, kcal: 93, capturedAt: '2026-10-14' },
  麦辣鸡翅: { price: 15.0, kcal: 224, capturedAt: '2026-10-14' },
};

/** 从基准配置常量中取某个产品的基准；没有则返回 null */
export function lookupBaseline(productName, baselines = DEFAULT_BASELINES) {
  return baselines[productName] ?? null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 单位价格：元/份 与 元/100kcal（内部度量，不对外展示） */
export function unitPrice(price, kcal) {
  const p = Number(price);
  const k = Number(kcal);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    perServing: round2(p),
    per100kcal: Number.isFinite(k) && k > 0 ? round2((p / k) * 100) : null,
  };
}

/** 基准年龄（天） */
export function baselineAgeDays(capturedAt, today = new Date()) {
  if (!capturedAt) return Infinity;
  const then = new Date(`${capturedAt}T00:00:00`);
  if (Number.isNaN(then.getTime())) return Infinity;
  return Math.floor((today.getTime() - then.getTime()) / 86400000);
}

/**
 * 衰减百分比：当前性价比相对基准的降幅（以单位价格升幅计）。
 * 正数 = 变贵了（涨价或缩水）；负数 = 更值了。无基准返回 null。
 */
export function decayPercent(currentUnit, baselineUnit) {
  if (!Number.isFinite(baselineUnit) || baselineUnit <= 0) return null;
  if (!Number.isFinite(currentUnit) || currentUnit <= 0) return null;
  return round2(((currentUnit - baselineUnit) / baselineUnit) * 100);
}

/** 横向百分位：单位价格在全部可比单品中的位置（0 = 最便宜，100 = 最贵） */
export function unitPricePercentile(unit, allUnits = []) {
  const valid = allUnits.filter((u) => Number.isFinite(u) && u > 0);
  if (valid.length === 0 || !Number.isFinite(unit)) return null;
  const below = valid.filter((u) => u < unit).length;
  return Math.round((below / valid.length) * 100);
}

/**
 * 衰减百分比 → 1~5 星。
 * decay 为 null 时走百分位兜底；两者皆无返回 null。
 */
export function scoreStars({ decay, percentile }, config = DEFAULT_CONFIG) {
  const [t0, t1, t2, t3] = config.starThresholds;
  if (Number.isFinite(decay)) {
    if (decay <= t0) return 5;
    if (decay <= t1) return 4;
    if (decay <= t2) return 3;
    if (decay <= t3) return 2;
    return 1;
  }
  if (Number.isFinite(percentile)) {
    const [p0, p1, p2, p3] = config.percentileBands;
    if (percentile <= p0) return 5;
    if (percentile <= p1) return 4;
    if (percentile <= p2) return 3;
    if (percentile <= p3) return 2;
    return 1;
  }
  return null;
}

/**
 * 雷达主入口：测一个单品。
 * 输入：
 *   product     { name, price, kcal }          当前实时数据（MCP）
 *   baseline    { price, kcal, capturedAt } | null | undefined
 *               不传（默认）= 自动查 DEFAULT_BASELINES；传 null = 明确不用基准
 *   menuSingles [{ name, price, kcal }]         菜单内全部可比单品（找替代品 + 算百分位）
 *   today       Date（可注入，便于测试）
 * 输出完整报告对象（供 formatReport 渲染为纯文本）。
 */
export function scan({
  product,
  baseline,
  menuSingles = [],
  today = new Date(),
  config = DEFAULT_CONFIG,
}) {
  const current = unitPrice(product.price, product.kcal);
  if (!current) {
    return { ok: false, reason: 'PRICE_INVALID', product: product.name };
  }
  if (current.per100kcal == null) {
    return { ok: false, reason: 'NO_NUTRITION', product: product.name, price: current.perServing };
  }

  const base = baseline === undefined ? lookupBaseline(product.name) : baseline;
  const ageDays = base ? baselineAgeDays(base.capturedAt, today) : Infinity;
  const baselineUnit = base ? unitPrice(base.price, base.kcal) : null;
  const decay =
    base && ageDays >= config.baselineMinAgeDays && baselineUnit?.per100kcal
      ? decayPercent(current.per100kcal, baselineUnit.per100kcal)
      : null;

  const allUnits = menuSingles
    .map((m) => unitPrice(m.price, m.kcal)?.per100kcal)
    .filter((u) => Number.isFinite(u));
  const percentile = unitPricePercentile(current.per100kcal, allUnits);

  const stars = scoreStars({ decay, percentile }, config);
  const mode = Number.isFinite(decay) ? 'decay' : 'percentile';

  const report = {
    ok: true,
    product: product.name,
    price: current.perServing,
    kcal: product.kcal,
    unitPrice: current,
    mode,
    comparableCount: allUnits.length,
    baseline: base
      ? {
          price: base.price,
          kcal: base.kcal,
          capturedAt: base.capturedAt,
          ageDays,
          unitPrice: baselineUnit,
        }
      : null,
    decayPercent: decay,
    percentile,
    stars,
    alternatives: [],
    notes: [],
  };

  if (base && ageDays < config.baselineMinAgeDays) {
    report.notes.push(
      `基准采集于 ${base.capturedAt}（${ageDays} 天前），不足 ${config.baselineMinAgeDays} 天，暂不参与纵向评分；本次按菜单横向百分位评级。`
    );
  }
  if (!base) {
    report.notes.push('无历史基准，本次按菜单横向百分位评级。');
  }

  // ≤2 星才推替代品
  if (stars != null && stars <= 2) {
    report.alternatives = findAlternatives(product, menuSingles, config);
  }
  return report;
}

/**
 * 替代品：同价位带（±priceBand）、性价比更优的单品，按单位价格升序取前 3。
 */
export function findAlternatives(target, menuSingles = [], config = DEFAULT_CONFIG) {
  const targetUnit = unitPrice(target.price, target.kcal)?.per100kcal;
  if (targetUnit == null) return [];
  const low = target.price * (1 - config.priceBand);
  const high = target.price * (1 + config.priceBand);
  return menuSingles
    .filter((m) => m.name !== target.name)
    .map((m) => ({ ...m, unitPrice: unitPrice(m.price, m.kcal) }))
    .filter((m) => m.unitPrice?.per100kcal != null)
    .filter((m) => m.price >= low && m.price <= high)
    .filter((m) => m.unitPrice.per100kcal < targetUnit)
    .sort((a, b) => a.unitPrice.per100kcal - b.unitPrice.per100kcal)
    .slice(0, 3)
    .map((m) => ({
      name: m.name,
      price: m.unitPrice.perServing,
      kcal: m.kcal,
      per100kcal: m.unitPrice.per100kcal,
      savingVsTarget: round2(targetUnit - m.unitPrice.per100kcal),
    }));
}

/** 把报告渲染成纯文本终端结果（表达层最小实现，Agent 可在此基础上润色） */
export function formatReport(r) {
  if (!r.ok) {
    if (r.reason === 'NO_NUTRITION') {
      return `${r.product}：现价 ¥${r.price}，但营养表中查不到该产品的分量数据，无法评级。`;
    }
    return `${r.product}：数据不足，无法评级。`;
  }
  const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
  const lines = [
    `【${r.product}】反缩水雷达报告`,
    `现价 ¥${r.price} / ${r.kcal} 大卡`,
    `性价比评分：${stars}（${r.stars}/5）`,
  ];
  if (r.mode === 'decay') {
    lines.push(
      `纵向对比：较基准（${r.baseline.capturedAt}，¥${r.baseline.price}/${r.baseline.kcal} 大卡）性价比衰减 ${Math.abs(r.decayPercent)}%`
    );
  } else {
    lines.push(
      `横向对比：贵过菜单 ${r.percentile}% 的可比单品（共 ${r.comparableCount} 个）`
    );
  }
  for (const n of r.notes) lines.push(`注：${n}`);
  if (r.alternatives.length > 0) {
    lines.push('同价位更值替代：');
    for (const a of r.alternatives) {
      lines.push(`  - ${a.name}：¥${a.price}/${a.kcal}kcal`);
    }
  }
  lines.push('（数据来自麦当劳 MCP 实时接口；热量为分量代理指标，结论仅供参考）');
  return lines.join('\n');
}
