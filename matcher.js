/**
 * 反缩水雷达 · 匹配层
 * 职责：把用户的口语输入（"双吉"、"板烧"）解析成官方品名，
 * 再在营养表里定位该产品的官方营养数据。
 * 纯函数，不发任何网络请求，不生成任何图表或表格。
 */

/**
 * 口语别名 → 官方品名（Skill 配置常量）。
 * 麦当劳 MCP 的菜单与营养表使用官方全称，用户嘴上说的是简称，先过这张表。
 * 新增别名直接在这里追加即可。
 */
export const DEFAULT_ALIASES = {
  双吉: '双层吉士汉堡',
  双吉堡: '双层吉士汉堡',
  板烧: '板烧鸡腿堡',
  板烧堡: '板烧鸡腿堡',
  麦辣: '麦辣鸡腿汉堡',
  辣堡: '麦辣鸡腿汉堡',
  麦辣堡: '麦辣鸡腿汉堡',
  巨无霸: '巨无霸',
  麦香鱼: '麦香鱼',
  鱼堡: '麦香鱼',
  麦香鸡: '麦香鸡',
  不素之霸: '不素之霸双层牛堡',
  双牛堡: '不素之霸双层牛堡',
  鳕鱼堡: '双层深海鳕鱼堡',
  安格斯: '芝士安格斯厚牛堡',
  培根安格斯: '培根安格斯厚牛堡',
  // 菜单上一个品名对应营养表多个规格时，取默认规格：
  薯条: '中薯条',
  中薯: '中薯条',
  大薯: '大薯条',
  麦乐鸡: '麦乐鸡5块',
  鸡翅: '麦辣鸡翅',
  大鸡排: '那么大鸡排',
  圆筒: '圆筒冰淇淋',
  新地: '朱古力新地',
  麦旋风: '奥利奥麦旋风',
  派: '香芋派',
  可乐: '可乐中杯',
  雪碧: '雪碧中杯',
  玉米杯: '大杯玉米杯',
};

/** 口语别名 → 官方品名 */
export function resolveAlias(input, aliasMap = DEFAULT_ALIASES) {
  const key = String(input).trim();
  if (aliasMap[key]) return aliasMap[key];
  for (const [alias, official] of Object.entries(aliasMap)) {
    if (key.includes(alias)) return official;
  }
  return key;
}

/**
 * 在营养表里找产品。匹配优先级：
 *   1. 官方品名精确匹配
 *   2. 营养名是输入的前缀 / 输入是营养名的前缀（麦乐鸡 ⊂ 麦乐鸡5块）
 *   3. 互相包含（薯条 ⊂ 中薯条）
 * 返回 null 表示无营养数据（该产品无法评级，需如实告知）。
 */
export function matchNutrition(officialName, nutritionList = []) {
  const name = String(officialName).trim();
  if (!name) return null;

  const exact = nutritionList.find((n) => n.productName === name);
  if (exact) return exact;

  const prefix = nutritionList.find(
    (n) => n.productName.startsWith(name) || name.startsWith(n.productName)
  );
  if (prefix) return prefix;

  const contains = nutritionList.find(
    (n) => n.productName.includes(name) || name.includes(n.productName)
  );
  return contains ?? null;
}

/**
 * 从 MCP query-meals 响应中提取餐品清单。
 * 返回 [{ code, name, price, tags, isSingle }]，价格单位：元。
 */
export function parseMenu(menuResponse) {
  const data = menuResponse?.data;
  if (!data?.meals) return [];
  const tagOf = new Map();
  for (const cat of data.categories ?? []) {
    for (const m of cat.meals ?? []) {
      const prev = tagOf.get(m.code) ?? [];
      tagOf.set(m.code, [...new Set([...prev, ...(m.tags ?? [])])]);
    }
  }
  return Object.entries(data.meals).map(([code, m]) => {
    const tags = tagOf.get(code) ?? [];
    return {
      code,
      name: String(m.name ?? ''),
      price: Number(m.currentPrice ?? m.originalPrice ?? 0),
      tags,
      isSingle: tags.includes('单品'),
    };
  });
}

/** 从 MCP list-nutrition-foods 响应中提取营养列表（kcal 为分量代理指标） */
export function parseNutrition(nutritionResponse) {
  const rows = nutritionResponse?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.productName && Number(r.energyKcal) > 0)
    .map((r) => ({
      productName: String(r.productName),
      kcal: Number(r.energyKcal),
      protein: Number(r.protein ?? 0),
      fat: Number(r.fat ?? 0),
      carb: Number(r.carbohydrate ?? 0),
    }));
}
