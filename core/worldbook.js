/**
 * 世界书（lorebook）条目化读取
 *
 * 关键设计：
 *  - 不再把整个世界书拍平成一坨文本截断，而是解析成结构化条目，按需取用
 *  - 自动分类：人物速览 / 角色条目 / NSFW 条目 / 其他
 *  - 用户可在面板里勾选"本次要带入的条目"，未勾选的不进提示词
 *  - 无硬性字数上限（可在设置里设软上限，0=不限）
 */
import { getContext, getRequestHeaders } from './st.js';
import { getSettings } from '../config.js';

/* ---------------- 关键词 ---------------- */

const OVERVIEW_RE = /(人物速览|人物总览|人物表|人物名单|人物介绍|人物设定|人物档案|全员|群像|角色表|角色速览|角色总览|角色名单|角色介绍|角色设定|角色档案|人物关系|关系总览|关系图|人物概览|总览|速览|名单|roster|cast|characters|character\s*list|overview)/i;
const NSFW_RE = /(nsfw|r-?18|18\+|18\s*禁|限制级|成人向|成人|里向|荤|色情|情色|性爱|私密|smut|lewd|explicit|adult|spicy)/i;

/** 关系 / 身份类词，用来从条目标题里剔除，避免被当成角色名 */
const NON_NAME_WORDS = new Set([
    '速览', '总览', '人物', '角色', '名单', '设定', '介绍', '档案', '概览', '关系', '条目', '世界', '背景', '世界观',
    '学生', '会长', '学生会长', '老师', '教师', '医生', '护士', '警察', '律师', '总裁', '秘书', '经理', '教授', '校长',
    '母亲', '父亲', '妈妈', '妈妈', '爸爸', '父母', '姐姐', '妹妹', '哥哥', '弟弟', '兄弟', '姐妹', '爷爷', '奶奶',
    '外公', '外婆', '叔叔', '阿姨', '姑姑', '舅舅', '男友', '女友', '男朋友', '女朋友', '未婚夫', '未婚妻',
    '老公', '老婆', '丈夫', '妻子', '情人', '暧昧', '闺蜜', '好朋友', '朋友', '同事', '同学', '邻居', '上司', '下属',
    'nsfw', 'sfw', 'r18', '隐藏', '秘密', '加密', '备份', '占位', '待补', '主', '次',
]);

function isNoiseWord(w) {
    const s = String(w || '').trim().toLowerCase();
    if (!s) return true;
    if (NON_NAME_WORDS.has(s)) return true;
    if (OVERVIEW_RE.test(s) || NSFW_RE.test(s)) return true;
    return false;
}

/** 从条目标题里猜角色名，例如「苏晴（学生会长）- SFW」→ ['苏晴'] */
export function extractNamesFromTitle(title) {
    const cleaned = String(title || '')
        .replace(/[【】\[\]（）(){}<>《》「」『』"']/g, ' ')
        .replace(/[·・\-—_|/\\,，、;；:：+~]/g, ' ');
    const out = [];
    cleaned.split(/\s+/).forEach((raw) => {
        const w = raw.trim();
        if (!w) return;
        if (w.length < 2 || w.length > 8) return;
        if (!/^[\u4e00-\u9fa5A-Za-z]+$/.test(w)) return;
        if (isNoiseWord(w)) return;
        if (!out.includes(w)) out.push(w);
    });
    return out;
}

/* ---------------- 读取与解析 ---------------- */

function entriesToArray(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.entries)) return data.entries;
    if (data.entries && typeof data.entries === 'object') return Object.values(data.entries);
    if (typeof data === 'object' && (data.key || data.content)) return [data];
    return [];
}

function normalizeEntry(en, index) {
    if (!en) return null;
    const keys = [].concat(en.key || [], en.keysecondary || []).filter(Boolean).map((k) => String(k).trim()).filter(Boolean);
    const title = String(en.comment || en.name || keys[0] || `条目${index + 1}`).trim();
    const content = String(en.content ?? '').trim();
    if (!title && !content) return null;
    const uid = String(en.uid ?? en.id ?? `${index}::${title}`);
    return { uid, title, keys, content, length: content.length };
}

function decorate(entries) {
    return entries.map((e) => {
        const hay = `${e.title} ${e.keys.join(' ')}`;
        const names = extractNamesFromTitle(e.title);
        const isNsfw = NSFW_RE.test(hay);
        const isOverview = OVERVIEW_RE.test(e.title) && !isNsfw;
        return {
            ...e,
            names,
            isNsfw,
            isOverview,
            kind: isOverview ? 'overview' : (names.length ? 'character' : 'other'),
        };
    });
}

function fromMemory(name) {
    const c = getContext();
    const candidates = [];
    try { if (window.world_info) candidates.push(window.world_info); } catch (e) { /* ignore */ }
    try { if (window.worldInfo) candidates.push(window.worldInfo); } catch (e) { /* ignore */ }
    try { if (c && c.worldInfo) candidates.push(c.worldInfo); } catch (e) { /* ignore */ }
    try { if (c && c.world_info) candidates.push(c.world_info); } catch (e) { /* ignore */ }
    for (const cand of candidates) {
        if (!cand) continue;
        if (name && cand[name]) {
            const arr = entriesToArray(cand[name]);
            if (arr.length) return arr;
        }
        if (!name) {
            if (Array.isArray(cand) || cand.entries) {
                const arr = entriesToArray(cand);
                if (arr.length) return arr;
            } else {
                const all = [];
                Object.keys(cand).forEach((k) => all.push(...entriesToArray(cand[k])));
                if (all.length) return all;
            }
        }
    }
    return [];
}

async function fromServer(name) {
    if (!name) return [];
    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!res.ok) return [];
        return entriesToArray(await res.json());
    } catch (e) { return []; }
}

/** 角色卡绑定的世界书名字 */
export function boundWorldName() {
    const c = getContext();
    try {
        const ch = c && Array.isArray(c.characters) ? c.characters[c.characterId] : null;
        if (!ch) return '';
        const d = ch.data || {};
        return (d.extensions && d.extensions.world) || d.world || '';
    } catch (e) { return ''; }
}

let cache = { key: '', entries: null };

/** 读出结构化条目列表 */
export async function loadWorldBook(force = false, preferName = '') {
    const s = getSettings();
    const name = preferName || s.worldbook.name || boundWorldName();
    if (!name) {
        // 没指定书名、角色卡也没绑世界书：宁可不带，也不去猜——
        // 以前会从内存里把"世界书面板当前选中的那本"（甚至全部世界书）当资料读出来，容易张冠李戴
        console.warn('[WorldEngine] 没有可用的世界书名（角色卡未绑定、设置里也留空），本次不带入世界书');
        cache = { key: '__none__', entries: [] };
        return [];
    }
    const key = name;
    if (!force && cache.key === key && cache.entries) return cache.entries;

    let raw = fromMemory(name);
    if (!raw.length) raw = await fromServer(name);
    if (!raw.length) {
        console.warn(`[WorldEngine] 世界书「${name}」没读到条目（名字写错了？），本次不带入世界书`);
    }

    const entries = raw.map(normalizeEntry).filter(Boolean);
    const decorated = decorate(entries);
    cache = { key, entries: decorated };
    return decorated;
}

export function clearWorldBookCache() { cache = { key: '', entries: null }; }

export function getWorldBookName() {
    const s = getSettings();
    return s.worldbook.name || boundWorldName() || '';
}

/* ---------------- 筛选 / 拼装 ---------------- */

/** 是否已经挑过条目（挑过就能表达"一条都不要"） */
export function selectionMade() {
    const s = getSettings();
    const picked = Array.isArray(s.worldbook.selectedUids) ? s.worldbook.selectedUids : [];
    return !!s.worldbook.selectionMade || picked.length > 0;
}

/**
 * 用户勾选的条目。
 * 没挑过 → 全部可用；挑过 → 严格按勾选来（可以是空数组 = 一条都不用）
 */
export function selectedEntries(entries) {
    if (!selectionMade()) return entries;
    const picked = getSettings().worldbook.selectedUids || [];
    const set = new Set(picked);
    return entries.filter((e) => set.has(e.uid));
}

/** 当前实际会带入的条目 */
export function usedEntries(entries) {
    return selectedEntries(entries);
}

export function overviewEntries(entries) {
    return entries.filter((e) => e.isOverview);
}

/** 「人物速览」文本；没有速览条目时退化为"所有条目标题清单"，保证不漏人 */
export function overviewText(entries) {
    const ov = overviewEntries(entries);
    if (ov.length) return ov.map((e) => `### ${e.title}\n${e.content}`).join('\n\n');
    const titles = entries
        .filter((e) => !e.isNsfw)
        .map((e) => (e.names.length ? `- ${e.names.join('、')}（条目：${e.title}）` : `- ${e.title}`));
    return titles.length ? `（世界书里没有专门的「人物速览」条目，以下是全部条目标题清单，请据此识别角色）\n${titles.join('\n')}` : '';
}

/** 取这些角色的条目（可按需排除 NSFW） */
export function entriesForNames(entries, names, { includeNsfw = false, excludeOverview = false } = {}) {
    const list = (names || []).filter(Boolean);
    if (!list.length) return [];
    return entries.filter((e) => {
        if (excludeOverview && e.isOverview) return false;
        if (!includeNsfw && e.isNsfw) return false;
        return list.some((n) => e.names.includes(n) || e.title.includes(n) || e.keys.some((k) => k.includes(n)));
    });
}

export function entriesToText(list, maxChars = 0) {
    if (!list || !list.length) return '';
    let text = list.map((e) => {
        const head = e.isNsfw ? `${e.title}（NSFW）` : e.title;
        return `### ${head}\n${e.content}`;
    }).join('\n\n');
    const limit = Number(maxChars) || 0;
    if (limit > 0 && text.length > limit) text = `${text.slice(0, limit)}\n...(已按设置截断，可在运行设置里调大或设为 0)`;
    return text;
}

/** 所有条目里出现过的角色名（去重排序） */
export function allEntryNames(entries) {
    const set = new Set();
    entries.forEach((e) => e.names.forEach((n) => set.add(n)));
    return [...set];
}

/** 兼容旧接口：整个世界书文本 */
export async function getWorldBookText(preferName = '') {
    const s = getSettings();
    const entries = await loadWorldBook(false, preferName);
    const picked = selectedEntries(entries);
    return entriesToText(picked, s.worldbook.maxChars);
}

/** 兼容旧接口：按名字取文本 */
export function filterByNames(text, names) {
    if (!text) return '';
    const list = (names || []).filter(Boolean);
    if (!list.length) return '';
    const blocks = text.split(/\n(?=### )/);
    const hit = blocks.filter((b) => list.some((n) => b.includes(n)));
    return hit.length ? hit.join('\n\n') : '';
}

/* ---------------- 角色卡 ---------------- */

export function getCharacterCardText() {
    const c = getContext();
    try {
        const ch = c && Array.isArray(c.characters) ? c.characters[c.characterId] : null;
        if (!ch) return '';
        const d = ch.data || {};
        const parts = [];
        if (d.name) parts.push(`角色名：${d.name}`);
        if (d.description) parts.push(`描述：${d.description}`);
        if (d.personality) parts.push(`性格：${d.personality}`);
        if (d.scenario) parts.push(`场景：${d.scenario}`);
        if (d.first_mes) parts.push(`开场白：${d.first_mes}`);
        if (d.mes_example) parts.push(`示例对话：${d.mes_example}`);
        return parts.join('\n');
    } catch (e) { return ''; }
}
