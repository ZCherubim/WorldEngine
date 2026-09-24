/**
 * 世界状态存取：数据挂在聊天元数据 chat_metadata.worldEngine 上
 * 换聊天存档 → 自动切换成该聊天自己的世界
 */
import { getChatMetadata, persistChat, toast } from './st.js';
import { emptyState, CATEGORY_LABEL } from './protocol.js';

export const META_KEY = 'worldEngine';

/** 就地补齐缺失字段，保证始终返回同一个对象引用（否则"拿到句柄再改"会丢） */
function normalizeInPlace(s) {
    if (!s || typeof s !== 'object') return emptyState();
    if (s.version == null) s.version = 2;
    if (s.phase == null) s.phase = 'empty';
    if (s.worldTime == null) s.worldTime = '';
    if (!s.nodes || typeof s.nodes !== 'object') s.nodes = {};
    if (!Array.isArray(s.order)) s.order = Object.keys(s.nodes).filter((k) => !k.includes('>'));
    if (!Array.isArray(s.hidden)) s.hidden = [];
    if (!Array.isArray(s.archived)) s.archived = [];
    if (!Array.isArray(s.built)) s.built = [];
    if (!Array.isArray(s.lastCovered)) s.lastCovered = [];
    if (!Array.isArray(s.pending)) s.pending = [];
    if (!Array.isArray(s.drafts)) s.drafts = [];
    if (!Array.isArray(s.worklogs)) s.worklogs = [];
    if (typeof s.memoryText !== 'string') s.memoryText = '';
    if (typeof s.memoryRaw !== 'string') s.memoryRaw = '';
    if (typeof s.memoryAt !== 'string') s.memoryAt = '';
    if (!Array.isArray(s.events)) s.events = [];
    if (!Array.isArray(s.commitments)) s.commitments = [];   // v2.4.0 承诺（旧存档补空数组，不炸）
    if (!Array.isArray(s.logs)) s.logs = [];
    if (!Array.isArray(s.snapshots)) s.snapshots = [];
    if (!Array.isArray(s.timeline)) s.timeline = [];
    if (typeof s.seq !== 'number') s.seq = 0;
    // 世界分钟计数器（单调递增，跨天不重置）：null = 还没建立（此时不做有效期豁免）
    if (typeof s.worldMinutes !== 'number') s.worldMinutes = null;
    // 老数据没有 persona 字段的，补上空对象
    Object.values(s.nodes).forEach((n) => {
        if (!n.persona || typeof n.persona !== 'object') n.persona = {};
        // 状态有效期：undefined → null（null = 没给时间段，每轮照常更新）
        if (n.untilMin === undefined) n.untilMin = null;
        // v2.3.18：攻防档已删除，老存档里的 attack 节点整体迁入「交互」。
        // 必须在这里迁 —— 否则旧档的攻防角色会变成没有档位的孤儿，
        // 既不出现在任何分区里，也进不了世界书抓取名单和注入名单。
        if (n.category === 'attack') n.category = 'interaction';
        if (!CATEGORY_LABEL[n.category]) n.category = 'unseen';
    });
    // 幽灵名单自愈（v2.3.11）：编辑页删人后，built / lastCovered 里会残留这些人的名字，
    // 建档页就会一直显示"已整理 24 个"。这里按实际节点把已不存在的名字剔掉 ——
    // 老存档不用重新保存一次，下次打开面板就自动对齐。
    if (s.built.length || s.lastCovered.length) {
        const alive = new Set(Object.values(s.nodes).map((n) => n.name));
        if (s.built.some((n) => !alive.has(n))) s.built = s.built.filter((n) => alive.has(n));
        if (s.lastCovered.some((n) => !alive.has(n))) s.lastCovered = s.lastCovered.filter((n) => alive.has(n));
    }
    return s;
}

export function getState() {
    const meta = getChatMetadata();
    if (!meta) return normalizeInPlace(null);
    if (!meta[META_KEY]) meta[META_KEY] = emptyState();
    return normalizeInPlace(meta[META_KEY]);
}

export function setState(next) {
    const meta = getChatMetadata();
    if (!meta) { toast('无法写入聊天元数据：未获取到 chat_metadata', 'error'); return false; }
    meta[META_KEY] = next;
    persistChat();
    return true;
}

/** 就地修改后保存（推荐用法：改 getState() 返回的对象，再 commit()） */
export function commit(state) {
    const meta = getChatMetadata();
    if (!meta) return false;
    meta[META_KEY] = state;
    state.updatedAt = new Date().toLocaleString('zh-CN');
    persistChat();
    return true;
}

export function clearState() {
    const meta = getChatMetadata();
    if (!meta) return;
    meta[META_KEY] = emptyState();
    persistChat();
}

const LOG_MAX = 20;
const LOG_TEXT_MAX = 14000;
const WORKLOG_MAX = 50;

function clip(v) {
    const t = String(v == null ? '' : v);
    return t.length > LOG_TEXT_MAX ? `${t.slice(0, LOG_TEXT_MAX)}\n…（日志过长已截断）` : t;
}

export function pushLog(state, entry) {
    state.logs = state.logs || [];
    const e = Object.assign({ at: new Date().toLocaleString('zh-CN') }, entry);
    if (e.prompt) e.prompt = clip(e.prompt);
    if (e.response) e.response = clip(e.response);
    // 完整版（不截断）只给**最新一条**留着，供「导出完整提示词」用。
    // 不能让 20 条日志各存一份完整 prompt（一次演化两万字，state 会直接爆掉）。
    (state.logs || []).forEach((x) => { delete x.promptFull; delete x.responseFull; });
    state.logs.unshift(e);
    if (state.logs.length > LOG_MAX) state.logs.length = LOG_MAX;
}

/**
 * 工作小结：记录"这一轮我干了什么"
 * @param {object} state
 * @param {string} kind roster | organize | organize-final | update-auto | update-manual | update-fill | memory | system
 * @param {string} summary 一句话小结
 * @param {object} [extra] { chars, note }
 */
export function pushWorklog(state, kind, summary, extra = {}) {
    state.worklogs = state.worklogs || [];
    const text = String(summary || '').trim();
    if (!text) return null;
    state.seq = (state.seq || 0) + 1;
    const item = {
        n: state.worklogs.length ? (state.worklogs[0].n || 0) + 1 : 1,
        seq: state.seq,
        at: new Date().toLocaleString('zh-CN'),
        kind,
        summary: text,
        note: extra.note || '',
    };
    state.worklogs.unshift(item);
    if (state.worklogs.length > WORKLOG_MAX) state.worklogs.length = WORKLOG_MAX;
    return item;
}

/** 最近 N 条工作小结（喂给模型用） */
export function recentWorklogs(state, n = 3) {
    return (state.worklogs || []).slice(0, Math.max(0, Number(n) || 0));
}

/* ---------------- 整理草稿（第 2 步） ---------------- */

export function addDraft(state, batch, notes, raw) {
    state.drafts = state.drafts || [];
    const item = {
        id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        at: new Date().toLocaleString('zh-CN'),
        batch: Array.isArray(batch) ? batch.slice() : [],
        notes: String(notes || '').trim(),
        raw: String(raw || '').trim(),
    };
    state.drafts.push(item);
    return item;
}

export function updateDraft(state, id, patch = {}) {
    state.drafts = state.drafts || [];
    const d = state.drafts.find((x) => x.id === id);
    if (!d) return null;
    if (patch.notes !== undefined) d.notes = String(patch.notes);
    if (patch.raw !== undefined) d.raw = String(patch.raw);
    return d;
}

export function removeDraft(state, id) {
    state.drafts = state.drafts || [];
    const i = state.drafts.findIndex((x) => x.id === id);
    if (i === -1) return false;
    state.drafts.splice(i, 1);
    return true;
}

export function clearDrafts(state) {
    state.drafts = [];
}

export function pushEvent(state, entry) {
    state.events = state.events || [];
    state.events.unshift(Object.assign({ at: new Date().toLocaleString('zh-CN') }, entry));
    if (state.events.length > 30) state.events.length = 30;
}

export function hasWorld() {
    const s = getState();
    return Object.keys(s.nodes || {}).length > 0;
}

export function toggleHidden(state, name) {
    state.hidden = state.hidden || [];
    const i = state.hidden.indexOf(name);
    if (i === -1) state.hidden.push(name);
    else state.hidden.splice(i, 1);
    // 子分支随父一起隐藏/显示
    Object.values(state.nodes).forEach((n) => {
        if (n.parent === name) {
            const j = state.hidden.indexOf(n.name);
            if (i === -1 && j === -1) state.hidden.push(n.name);
            if (i !== -1 && j !== -1) state.hidden.splice(j, 1);
        }
    });
    return state.hidden.includes(name);
}
