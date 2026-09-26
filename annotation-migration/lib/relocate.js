'use strict';

// 批注迁移定位引擎
// 策略：
//   1. 在新稿中查找批注原文 quote 的全部出现位置（先精确匹配，失败再做忽略空白的模糊匹配）
//   2. 多个出现位置时，用批注原文在旧稿中的前/后文与各候选位置的前/后文做 bigram Dice 相似度比较
//   3. 唯一位置直接定位；上下文明显区分则取最优点；仍有多个合理位置 -> ambiguous 待处理
//      原文（含模糊匹配）找不到 -> deleted 待处理。绝不静默挂到错误段落。

const CONTEXT_LEN = 20;   // 记录/比较的上下文长度（字符）
const SNIPPET_LEN = 16;   // 返回给界面的候选上下文片段长度
const MAX_CANDIDATES = 10;

// 单例自动定位阈值
const BEST_MIN = 0.4;       // 最优位置至少达到的上下文相似度
const GAP = 0.12;           // 最优须明显优于次优
// 模糊匹配质量阈值（低于该值不接受为唯一定位）
const FUZZY_MIN = 0.85;

function sliceAround(text, start, end, len) {
  return {
    pre: text.slice(Math.max(0, start - len), start),
    post: text.slice(end, end + len),
  };
}

// 多重集合 bigram Dice 系数；过短字符串退化为等值比较；两侧皆空视为相同（边界情形）
function dice(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;
  const count = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    count.set(g, (count.get(g) || 0) + 1);
  }
  let inter = 0;
  const used = new Map();
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const have = count.get(g) || 0;
    const u = used.get(g) || 0;
    if (u < have) { inter++; used.set(g, u + 1); }
  }
  return (2 * inter) / (a.length + b.length - 2);
}

// 精确匹配：返回所有出现区间
function findExact(text, quote) {
  const out = [];
  if (!quote) return out;
  let idx = text.indexOf(quote);
  while (idx !== -1) {
    out.push({ start: idx, end: idx + quote.length, fuzzy: false });
    idx = text.indexOf(quote, idx + 1);
  }
  return out;
}

// 忽略空白的模糊匹配：在“去空白文本”上匹配，再映射回原坐标
function findFuzzy(text, quote) {
  const strip = (s) => {
    let stripped = '';
    const map = []; // stripped 中第 i 个字符 -> 原文索引
    for (let i = 0; i < s.length; i++) {
      if (s[i].trim()) { stripped += s[i]; map.push(i); }
    }
    return { stripped, map };
  };

  const t = strip(text);
  const q = strip(quote);
  if (!q.stripped) return { hits: [], quality: 0 };

  const out = [];
  let idx = t.stripped.indexOf(q.stripped);
  while (idx !== -1) {
    const startOrig = t.map[idx];
    const endOrig = t.map[idx + q.stripped.length - 1] + 1;
    out.push({ start: startOrig, end: endOrig, fuzzy: true });
    idx = t.stripped.indexOf(q.stripped, idx + 1);
  }
  // 匹配质量：去空白后命中字符占原选区字符的比例
  const quality = quote.length ? q.stripped.length / quote.length : 0;
  return { hits: out, quality };
}

function scoreCandidate(newText, hit, oldPre, oldPost) {
  const ctx = sliceAround(newText, hit.start, hit.end, CONTEXT_LEN);
  const preScore = dice(oldPre, ctx.pre);
  const postScore = dice(oldPost, ctx.post);
  // 内部文本质量：精确命中为 1，模糊命中按字符覆盖折算
  const inner = hit.fuzzy ? 0 : 1;
  const total = 0.42 * preScore + 0.42 * postScore + 0.16 * inner;
  return {
    start: hit.start,
    end: hit.end,
    fuzzy: !!hit.fuzzy,
    score: Number(total.toFixed(4)),
    preScore: Number(preScore.toFixed(4)),
    postScore: Number(postScore.toFixed(4)),
    snippetPre: newText.slice(Math.max(0, hit.start - SNIPPET_LEN), hit.start),
    snippetPost: newText.slice(hit.end, hit.end + SNIPPET_LEN),
  };
}

// 迁移单条批注
function locateAnnotation(annotation, oldText, newText) {
  const { start, end, quote } = annotation;
  const oldCtx = sliceAround(oldText, start, end, CONTEXT_LEN);

  let hits = findExact(newText, quote);
  let fuzzyQuality = 1;
  if (hits.length === 0) {
    const f = findFuzzy(newText, quote);
    hits = f.hits;
    fuzzyQuality = f.quality;
  }

  if (hits.length === 0) {
    return {
      status: 'pending',
      reason: 'deleted',
      candidates: [],
      matchedAt: Date.now(),
    };
  }

  let candidates = hits.map((h) => scoreCandidate(newText, h, oldCtx.pre, oldCtx.post));
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);

  // 唯一命中
  if (candidates.length === 1) {
    const c = candidates[0];
    if (c.fuzzy && fuzzyQuality < FUZZY_MIN) {
      return { status: 'pending', reason: 'ambiguous', candidates: cap(candidates), matchedAt: Date.now() };
    }
    return {
      status: 'located',
      start: c.start,
      end: c.end,
      matchType: c.fuzzy ? 'fuzzy' : 'exact',
      score: c.score,
      candidates: cap(candidates),
      matchedAt: Date.now(),
    };
  }

  // 多处命中：必须比较上下文
  const [best, second] = candidates;
  if (!best.fuzzy && best.score >= BEST_MIN && best.score - second.score >= GAP) {
    return {
      status: 'located',
      start: best.start,
      end: best.end,
      matchType: 'exact',
      score: best.score,
      candidates: cap(candidates),
      matchedAt: Date.now(),
    };
  }
  if (best.fuzzy && fuzzyQuality >= FUZZY_MIN && best.score >= BEST_MIN && best.score - second.score >= GAP) {
    return {
      status: 'located',
      start: best.start,
      end: best.end,
      matchType: 'fuzzy',
      score: best.score,
      candidates: cap(candidates),
      matchedAt: Date.now(),
    };
  }
  return { status: 'pending', reason: 'ambiguous', candidates: cap(candidates), matchedAt: Date.now() };
}

function cap(candidates) {
  return candidates.slice(0, MAX_CANDIDATES);
}

// 迁移全部批注（已有 manual 人工确认结果默认保留，可强制重算）
function migrateAll(annotations, oldText, newText, options = {}) {
  return annotations.map((a) => {
    if (!options.force && a.result && a.result.status === 'manual') {
      return a;
    }
    return { ...a, result: locateAnnotation(a, oldText, newText) };
  });
}

module.exports = { locateAnnotation, migrateAll, dice, findExact, findFuzzy };
