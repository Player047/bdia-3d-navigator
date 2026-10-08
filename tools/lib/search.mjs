/**
 * 搜索索引。
 *
 * 每个设施除了固定字段（name / nameEn / aliases / pinyin / category）之外，
 * 还可以带一组「索引标签」—— 类别级字段定义 + 设施级取值：
 *
 *   manifest.facilityCategories[cat].fields[]   ← 字段定义（对所有该类别设施生效）
 *   facility.properties.fields { key: value }   ← 设施级取值
 *
 * 这里把它们统一编译成一条可搜索的记录：一段拼好的检索文本 + 结构化字段，
 * 客户端拿到就能做前缀/包含/拼音匹配，校验器也能统计索引覆盖率。
 *
 * ★ 字段定义写在类别上是刻意的：值机柜台的「字母编号 / 航空公司 / 航司代码」
 *   对【每一个】值机柜台都必须有。放在类别上，新增柜台时字段自动出现；
 *   放在单个设施上，就一定会有人漏填。
 *   而设施级也允许加临时字段（比如这家店多了个「是否有座位」），
 *   编辑器里能一键把它提升成类别级。
 */

/** 归一化：转小写、去空白、全角转半角，让搜索更容易命中。 */
export function normalizeTerm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取某个类别的字段定义。 */
export function categoryFields(manifest, category) {
  return manifest?.facilityCategories?.[category]?.fields ?? [];
}

/**
 * 一条设施的搜索记录。
 *
 * @returns {
 *   id, level, category, categoryName, kind,        // kind: 'area' | 'point'
 *   name, nameEn, aliases, pinyin,
 *   fields,          // { key: value } 只含非空值
 *   terms,           // [string] 参与检索的词（已归一化）
 *   text,            // 拼好的检索文本，方便做 includes
 *   missingRequired, // [fieldKey] 类别定义里必填但没填的
 * }
 */
export function searchRecord(manifest, facility) {
  const p = facility.properties ?? {};
  const defs = categoryFields(manifest, p.category);
  const values = p.fields ?? {};

  const fields = {};
  for (const d of defs) {
    const v = values[d.key];
    if (v !== undefined && v !== null && String(v).trim() !== '') fields[d.key] = v;
  }
  // 类别定义之外的临时字段也带上（编辑器允许加，搜索也该能命中）
  for (const [k, v] of Object.entries(values)) {
    if (fields[k] !== undefined) continue;
    if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = v;
  }

  const missingRequired = defs
    .filter((d) => d.required && !(d.key in fields))
    .map((d) => d.key);

  const catName = manifest?.facilityCategories?.[p.category]?.name ?? '';
  const raw = [
    p.name, p.nameEn, catName,
    ...(p.aliases ?? []),
    ...Object.values(fields),            // ★ 字段值全部进检索文本
    ...(p.pinyin ?? []),
  ];

  const terms = [...new Set(raw.map(normalizeTerm).filter(Boolean))];
  // 字段值可能用 / 或 、 分隔多个词，拆开单独入索引
  for (const v of Object.values(fields)) {
    for (const piece of String(v).split(/[/、,，|]/)) {
      const t = normalizeTerm(piece);
      if (t) terms.push(t);
    }
  }

  return {
    id: facility.id,
    level: p.level,
    zone: p.zone,
    category: p.category,
    categoryName: catName,
    kind: facility.geometry?.type === 'Polygon' ? 'area' : 'point',
    /*
     * ★ 显示名。类别可以用 manifest 的 labelKey 声明「我的显示名是哪个字段」——
     *   登机口就是这样：旅客认的是编号（E42），不是 name。
     *   名字留空、编号单独成字段，地图上才画得出干净的「E42」，
     *   而不是 25 个都带「登机口」三个字的尾巴。
     */
    name: p.name
      || (() => {
        const lk = manifest?.facilityCategories?.[p.category]?.labelKey;
        const v = lk ? fields[lk] : null;
        return v === undefined || v === null ? '' : String(v);
      })(),
    nameEn: p.nameEn ?? '',
    aliases: p.aliases ?? [],
    pinyin: p.pinyin ?? [],
    fields,
    terms: [...new Set(terms)],
    text: [...new Set(terms)].join(' '),
    missingRequired,
  };
}

/** 整份设施表 → 索引。 */
export function buildSearchIndex(manifest, facilities) {
  const records = facilities.map((f) => searchRecord(manifest, f));
  const byTerm = new Map();
  for (const r of records) {
    for (const t of r.terms) {
      if (!byTerm.has(t)) byTerm.set(t, []);
      byTerm.get(t).push(r.id);
    }
  }
  return {
    records,
    byId: new Map(records.map((r) => [r.id, r])),
    byTerm,
    stats: {
      total: records.length,
      withFields: records.filter((r) => Object.keys(r.fields).length).length,
      missingRequired: records.filter((r) => r.missingRequired.length).length,
      terms: byTerm.size,
    },
  };
}

/**
 * 把一个字段提升为「该类别所有设施都有」。
 * 编辑器里点「所有 X 都用」时调用，直接改 manifest。
 */
export function promoteField(manifest, category, def) {
  const cat = manifest.facilityCategories?.[category];
  if (!cat) throw new Error(`未知类别 ${category}`);
  if (!Array.isArray(cat.fields)) cat.fields = [];
  if (cat.fields.some((d) => d.key === def.key)) return false;
  cat.fields.push(def);
  return true;
}
