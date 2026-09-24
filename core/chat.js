/**
 * 聊天读写：取最近楼层、格式化给模型、把世界动态写进最新楼层正文
 */
import { getChatArray, getNames, persistMessages, getEventSource, getEventTypes, toast } from './st.js';

export const BLOCK_START = '<!--WorldEngine:Start-->';
export const BLOCK_END = '<!--WorldEngine:End-->';

// 正文落盘串行队列：saveChat 是异步整场写盘，连着两次写正文如果并发触发，
// 后一次可能读到旧聊天数组把前一次的改动冲掉。所有正文保存都排进这条链。
let saveQueue = Promise.resolve();
function enqueueMessageSave() {
    saveQueue = saveQueue
        .then(() => persistMessages())
        .catch((e) => console.warn('[WorldEngine] 正文落盘失败', e));
    return saveQueue;
}

export function getRecentChat(n) {
    const chat = getChatArray();
    if (!chat.length) return [];
    const count = n > 0 ? Math.min(n, chat.length) : chat.length;
    return chat.slice(chat.length - count);
}

export function getChatLength() {
    return getChatArray().length;
}

export function formatChat(messages, startIndex) {
    const base = typeof startIndex === 'number' ? startIndex : 0;
    return messages.map((m, i) => {
        const who = m.name || (m.is_user ? '用户' : '角色');
        const mes = typeof m.mes === 'string' ? m.mes : String(m.mes || '');
        return `[第${base + i + 1}层] ${who}：${mes}`;
    }).join('\n\n');
}

/** 最新一条 AI（非用户）回复 */
export function getLatestAiFloor() {
    const chat = getChatArray();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) return { index: i, message: chat[i] };
    }
    return chat.length ? { index: chat.length - 1, message: chat[chat.length - 1] } : null;
}

/**
 * 挑出最值得写进正文的几个角色动态（不再全量拼接，防止正文被世界报表淹没）
 * 挑选优先级：本轮有变化 > 交互 > 冷却 > 未出场，同级取最近更新的
 * @param {object} state
 * @param {object} categories 类别开关 {interaction, cooldown, unseen}
 * @param {{topN?:number, changed?:string[]}} [opts] topN 默认 3；changed 是本轮变动的角色名
 */
export function buildWorldDynamicsLine(state, categories, opts = {}) {
    const topN = Math.max(1, Number(opts.topN) || 3);
    const changed = Array.isArray(opts.changed) ? opts.changed : [];
    const CAT_W = { interaction: 0, cooldown: 1, unseen: 2 };
    const cands = [];
    Object.values(state.nodes).forEach((n) => {
        if (state.hidden.includes(n.name)) return;
        if (n.archived) return;
        if (!categories[n.category]) return;
        const txt = [n.time, n.location, n.summary].filter(Boolean).join(' ').trim();
        if (!txt) return;
        cands.push({ n, txt, w: (changed.includes(n.name) ? -100 : 0) + (CAT_W[n.category] ?? 9) * 10 - Math.min((n.seq || 0) / 1e6, 9) });
    });
    if (!cands.length) return '';
    cands.sort((a, b) => a.w - b.w);
    const picked = cands.slice(0, topN).map((c) => `${c.n.name}：${c.txt}`);
    return `【世界动态】\n${picked.join('\n')}`;
}

/** 把世界动态追加（或替换）到最新楼层正文末尾 */
export function writeDynamicsToLatestFloor(line) {
    if (!line) return { ok: false, msg: '没有可写入的内容' };
    const target = getLatestAiFloor();
    if (!target) return { ok: false, msg: '没有找到可写入的楼层' };
    const mes = target.message;
    let text = String(mes.mes || '');
    const s = text.indexOf(BLOCK_START);
    const e = text.indexOf(BLOCK_END);
    const block = `\n\n${BLOCK_START}\n${line}\n${BLOCK_END}`;
    if (s !== -1 && e !== -1 && e > s) {
        text = text.slice(0, s) + block + text.slice(e + BLOCK_END.length);
    } else {
        text = text + block;
    }
    mes.mes = text;

    // 写的是消息正文（mes.mes），saveMetadata 存不了它，必须走 saveChat 整场落盘（排队串行）
    enqueueMessageSave();
    // 尝试重渲染该楼层
    try {
        const es = getEventSource();
        const types = getEventTypes();
        if (es && types.MESSAGE_UPDATED) es.emit(types.MESSAGE_UPDATED, target.index);
        else if (es && types.MESSAGE_EDITED) es.emit(types.MESSAGE_EDITED, target.index);
    } catch (err) { /* ignore */ }
    return { ok: true, msg: `已写入第 ${target.index + 1} 层` };
}

export function removeDynamicsFromLatestFloor() {
    const target = getLatestAiFloor();
    if (!target) return false;
    let text = String(target.message.mes || '');
    const s = text.indexOf(BLOCK_START);
    const e = text.indexOf(BLOCK_END);
    if (s === -1 || e === -1) return false;
    text = text.slice(0, s) + text.slice(e + BLOCK_END.length);
    target.message.mes = text.replace(/\n{3,}$/, '\n');
    enqueueMessageSave();
    try {
        const es = getEventSource();
        const types = getEventTypes();
        if (es && types.MESSAGE_UPDATED) es.emit(types.MESSAGE_UPDATED, target.index);
    } catch (err) { /* ignore */ }
    return true;
}

export function currentUserName() {
    return getNames().user;
}
