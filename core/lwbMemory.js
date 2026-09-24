/**
 * 小白X（LittleWhiteBox）剧情总结记忆 → 紧凑文本
 *
 * 小白X 导出的 JSON 结构：
 *   { type: "LittleWhiteBoxStorySummaryMemory", version, exportedAt,
 *     data: { keywords[], events[], characters{main[]}, characterAliases[],
 *             arcs[], facts[] }, counts{} }
 *
 * 直接把 143 条事件塞进提示词会爆 token，这里先解析、归并、压缩成结构化文本。
 * 解析失败也不报错——原样返回给模型自己读。
 */

const TYPE_HINT = 'LittleWhiteBoxStorySummaryMemory';

/** 从任意输入里抠出 JSON 对象 */
function extractJson(input) {
    if (!input) return null;
    if (typeof input === 'object') return input;
    let t = String(input).trim();
    // 去掉 markdown 代码块围栏
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 继续尝试 */ }
    // 抠第一个 { 到最后一个 }
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
        try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
    }
    return null;
}

function asArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') return Object.values(v);
    return [];
}

function s(v) { return v === undefined || v === null ? '' : String(v); }

/**
 * 解析小白X 记忆 JSON
 * @returns {{ok:boolean, raw:object|null, keywords:Array, arcs:Array, facts:Array,
 *            events:Array, characters:Array, counts:object, exportedAt:string, error:string}}
 */
export function parseLwb(input) {
    const raw = extractJson(input);
    const out = {
        ok: false, raw: null, keywords: [], arcs: [], facts: [], events: [],
        characters: [], counts: {}, exportedAt: '', error: '',
    };
    if (!raw) {
        out.error = '没解析出 JSON（可能复制不全或格式不对）';
        return out;
    }
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;

    out.raw = raw;
    out.exportedAt = s(raw.exportedAt || data.exportedAt);
    out.counts = raw.counts || data.counts || {};

    out.keywords = asArray(data.keywords).map((k) => (
        typeof k === 'string' ? { text: k, weight: '' } : { text: s(k.text || k.name), weight: s(k.weight || k.level) }
    )).filter((k) => k.text);

    out.arcs = asArray(data.arcs).map((a) => ({
        name: s(a.name || a.character || a.人物名字),
        trajectory: s(a.trajectory || a.轨迹),
        progress: a.progress === undefined || a.progress === null ? '' : s(a.progress),
        moments: asArray(a.moments).map((m) => (typeof m === 'string' ? m : s(m.text || m.内容))).filter(Boolean),
    })).filter((a) => a.name);

    out.facts = asArray(data.facts).map((f) => ({
        who: s(f['人物名字'] || f.name || f.人物),
        kind: s(f['种类'] || f.type || f.种类),
        desc: s(f['描述'] || f.description || f.内容),
        core: f['核心事实'] === true,
        trend: s(f['趋势'] || f.trend),
    })).filter((f) => f.desc || f.who);

    out.events = asArray(data.events).map((e) => ({
        id: s(e.id),
        title: s(e.title),
        time: s(e.timeLabel || e.time),
        summary: s(e.summary),
        participants: asArray(e.participants).map(s).filter(Boolean),
        role: s(e.memoryRole || e.role),
    })).filter((e) => e.summary || e.title);

    const chars = data.characters && typeof data.characters === 'object' ? data.characters : {};
    out.characters = asArray(chars.main).map((c) => s(typeof c === 'string' ? c : c.name)).filter(Boolean);

    out.ok = !!(out.keywords.length || out.arcs.length || out.facts.length || out.events.length || out.characters.length);
    if (!out.ok) out.error = '解析成功但里面没有内容（keywords/events/arcs/facts 都是空的）';
    return out;
}

/** 大概看一下这份记忆有多大 */
export function lwbStats(parsed) {
    return {
        keywords: parsed.keywords.length,
        arcs: parsed.arcs.length,
        facts: parsed.facts.length,
        events: parsed.events.length,
        characters: parsed.characters.length,
        type: parsed.raw && parsed.raw.type ? s(parsed.raw.type) : '',
        exportedAt: parsed.exportedAt,
        isLwb: !!(parsed.raw && s(parsed.raw.type) === TYPE_HINT),
    };
}

/* ---------------- 压缩成紧凑文本 ---------------- */

function factLine(f) {
    const parts = [];
    if (f.kind) parts.push(f.kind);
    if (f.desc) parts.push(f.desc);
    if (f.trend) parts.push(`趋势：${f.trend}`);
    if (f.core) parts.push('（核心）');
    return parts.join('：').replace('：（核心）', '（核心）');
}

/**
 * @param {object} parsed parseLwb 的结果
 * @param {{eventLimit?:number, momentCount?:number, maxChars?:number}} opts
 *        eventLimit：0 或负数 = 全部事件；否则只取最近 N 条
 */
export function compactLwb(parsed, opts = {}) {
    const eventLimit = Number(opts.eventLimit) || 0;
    const momentCount = Number(opts.momentCount) || 3;
    const maxChars = Number(opts.maxChars) || 0;
    if (!parsed || !parsed.ok) return String(parsed && parsed.error ? `（${parsed.error}）` : '');

    const out = [];
    const st = lwbStats(parsed);
    out.push(`《外部剧情记忆》类型：${st.type || '未知'}${st.exportedAt ? `　导出时间：${st.exportedAt}` : ''}`);
    out.push(`（人物 ${st.characters} ｜ 事件 ${st.events} ｜ 轨迹 ${st.arcs} ｜ 事实 ${st.facts} ｜ 关键词 ${st.keywords}）`);

    if (parsed.keywords.length) {
        out.push('');
        out.push('【记忆焦点】');
        parsed.keywords.forEach((k) => out.push(`- ${k.text}${k.weight ? `（${k.weight}）` : ''}`));
    }

    if (parsed.arcs.length) {
        out.push('');
        out.push('【人物走向】');
        parsed.arcs.forEach((a) => {
            const pr = a.progress !== '' ? `　进度：${a.progress}` : '';
            out.push(`- ${a.name}｜${a.trajectory || '—'}${pr}`);
            const ms = momentCount > 0 ? a.moments.slice(-momentCount) : a.moments;
            ms.forEach((m) => out.push(`　· ${m}`));
        });
    }

    if (parsed.facts.length) {
        out.push('');
        out.push('【已确认事实】');
        const byWho = new Map();
        parsed.facts.forEach((f) => {
            const key = f.who || '（未标注）';
            if (!byWho.has(key)) byWho.set(key, []);
            byWho.get(key).push(f);
        });
        byWho.forEach((list, who) => {
            out.push(`- ${who}：`);
            list.forEach((f) => out.push(`　· ${factLine(f)}`));
        });
    }

    if (parsed.events.length) {
        out.push('');
        const list = eventLimit > 0 ? parsed.events.slice(-eventLimit) : parsed.events;
        out.push(`【剧情事件】（共 ${parsed.events.length} 条${eventLimit > 0 && eventLimit < parsed.events.length ? `，此处只带最近 ${list.length} 条` : '，全部带入'}）`);
        list.forEach((e) => {
            const who = e.participants.length ? `〔${e.participants.join('、')}〕` : '';
            const when = e.time ? `${e.time}　` : '';
            const role = e.role ? `［${e.role}］` : '';
            out.push(`- ${when}${e.title ? `${e.title}：` : ''}${who}${e.summary}${role}`);
        });
    }

    let text = out.join('\n');
    if (maxChars > 0 && text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n…（记忆已按软上限截断）`;
    }
    return text;
}

/* ---------------- 分批导入用的切片工具 ---------------- */

/** 只输出 keywords + arcs + facts（不含事件），每批都带上，用来建立人物印象 */
export function compactContext(parsed, opts = {}) {
    const momentCount = Number(opts.momentCount) || 3;
    const out = [];
    const st = lwbStats(parsed);
    out.push(`《外部剧情记忆》${st.exportedAt ? `导出时间：${st.exportedAt}　` : ''}（人物 ${st.characters} ｜ 事件 ${st.events} ｜ 轨迹 ${st.arcs} ｜ 事实 ${st.facts}）`);
    if (parsed.keywords.length) {
        out.push('', '【记忆焦点】');
        parsed.keywords.forEach((k) => out.push(`- ${k.text}${k.weight ? `（${k.weight}）` : ''}`));
    }
    if (parsed.arcs.length) {
        out.push('', '【人物走向】');
        parsed.arcs.forEach((a) => {
            const pr = a.progress !== '' ? `　进度：${a.progress}` : '';
            out.push(`- ${a.name}｜${a.trajectory || '—'}${pr}`);
            const ms = momentCount > 0 ? a.moments.slice(-momentCount) : a.moments;
            ms.forEach((m) => out.push(`　· ${m}`));
        });
    }
    if (parsed.facts.length) {
        out.push('', '【已确认事实】');
        const byWho = new Map();
        parsed.facts.forEach((f) => {
            const key = f.who || '（未标注）';
            if (!byWho.has(key)) byWho.set(key, []);
            byWho.get(key).push(f);
        });
        byWho.forEach((list, who) => {
            out.push(`- ${who}：`);
            list.forEach((f) => out.push(`　· ${factLine(f)}`));
        });
    }
    return out.join('\n');
}

/** 只输出指定的一批事件（分批导入用） */
export function compactEvents(parsed, events, opts = {}) {
    const total = parsed.events.length;
    const list = Array.isArray(events) ? events : [];
    const out = ['', `【剧情事件】（本批 ${list.length} 条${opts.batchIndex != null && opts.batchCount ? `，第 ${opts.batchIndex}/${opts.batchCount} 批` : ''}${total !== list.length ? `，共 ${total} 条` : ''}）`];
    list.forEach((e) => {
        const who = e.participants.length ? `〔${e.participants.join('、')}〕` : '';
        const when = e.time ? `${e.time}　` : '';
        const role = e.role ? `［${e.role}］` : '';
        out.push(`- ${when}${e.title ? `${e.title}：` : ''}${who}${e.summary}${role}`);
    });
    return out.join('\n');
}

/** 一步到位：解析 + 压缩 */
export function lwbToText(input, opts = {}) {
    const parsed = parseLwb(input);
    return { parsed, stats: lwbStats(parsed), text: compactLwb(parsed, opts) };
}

/* ---------------- 给外部 AI 用的压缩指令 ---------------- */

/**
 * 记忆太大时，把这个指令复制给任意一个 AI，让它先把小白X 记忆压成紧凑格式，
 * 再把结果贴回插件的输入框。
 */
export const COMPACT_INSTRUCTION = `请把下面这段"小白X 剧情总结记忆"（JSON）压缩成一份**紧凑的中文剧情记忆**，我要拿它当提示词喂给另一个 AI 用于维护一个角色世界状态。

【严格按这个结构输出，不要输出 JSON，不要输出任何解释】

《外部剧情记忆》
（人物 X ｜ 事件 X ｜ 轨迹 X ｜ 事实 X ｜ 关键词 X）

【记忆焦点】
- 关键词（权重）

【人物走向】
- 角色名｜一句话轨迹｜进度：x%
  · 最近的一个进展
  · 最近的第二个进展

【已确认事实】
- 角色名：
  · 种类：描述
  · 种类：描述

【剧情事件】
- 时间　标题：〔参与人〕摘要［记忆角色］

【要求】
1. **不许丢人物**：facts 里出现过的每个角色名字都要保留。
2. **不许丢事件**：events 里的每一条都要保留（可以压缩文字，但不能删条目），按时间顺序排列。
3. arcs 里每个人的 moments 最多保留最近 3 条，其余压缩掉。
4. 时间、地点、约定（谁答应了谁什么）、物品归属、身份关系这几类信息**必须保留**，这些是维护世界状态最需要的。
5. 尽量精简，但不要为了短而丢失事实。

下面是原始 JSON：

`;
