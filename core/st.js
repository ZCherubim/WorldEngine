/**
 * 酒馆环境适配层
 * 统一封装：上下文获取、事件源、聊天元数据、存档、轻提示
 * 所有 API 都做多路径兜底，避免不同酒馆版本变量名不一致导致插件整体失效
 */

export function getContext() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch (e) { /* ignore */ }
    try {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
    } catch (e) { /* ignore */ }
    return null;
}

export function getEventSource() {
    const c = getContext();
    return (c && c.eventSource) || window.eventSource || null;
}

export function getEventTypes() {
    const c = getContext();
    return (c && c.event_types) || window.event_types || {};
}

/** 当前聊天的元数据对象：官方字段名是 chatMetadata，老版本是 chat_metadata */
export function getChatMetadata() {
    const c = getContext();
    if (c && c.chatMetadata && typeof c.chatMetadata === 'object') return c.chatMetadata;
    if (c && c.chat_metadata && typeof c.chat_metadata === 'object') return c.chat_metadata;
    if (window.chatMetadata && typeof window.chatMetadata === 'object') return window.chatMetadata;
    if (window.chat_metadata && typeof window.chat_metadata === 'object') return window.chat_metadata;
    return null;
}

export function getChatArray() {
    const c = getContext();
    if (c && Array.isArray(c.chat)) return c.chat;
    if (Array.isArray(window.chat)) return window.chat;
    return [];
}

/** 触发存档（保存聊天元数据用这个；官方推荐 saveMetadata，兼容旧版本） */
export async function persistChat() {
    const c = getContext();
    try { if (c && typeof c.saveMetadata === 'function') { await c.saveMetadata(); return true; } } catch (e) { /* ignore */ }
    try { if (c && typeof c.saveMetadataDebounced === 'function') { c.saveMetadataDebounced(); return true; } } catch (e) { /* ignore */ }
    try { if (c && typeof c.saveChat === 'function') { await c.saveChat(); return true; } } catch (e) { /* ignore */ }
    try { if (typeof window.saveChat === 'function') { await window.saveChat(); return true; } } catch (e) { /* ignore */ }
    return false;
}

/**
 * 保存**消息正文**（mes.mes 被改过之后必须用这个）。
 * saveMetadata 只存 chat_metadata，存不了楼层正文——用它保存正文写入等于没存，
 * 刷新/重开聊天后动态块就没了。这里必须走 saveChat 整场写盘。
 */
export async function persistMessages() {
    const c = getContext();
    try { if (c && typeof c.saveChat === 'function') { await c.saveChat(); return true; } } catch (e) { /* ignore */ }
    try { if (typeof window.saveChat === 'function') { await window.saveChat(); return true; } } catch (e) { /* ignore */ }
    return persistChat();
}

/** 官方推荐的编程式生成接口是否存在 */
export function getGenerationApi() {
    const c = getContext() || {};
    return {
        generateRaw: typeof c.generateRaw === 'function' ? c.generateRaw.bind(c) : null,
        generateQuietPrompt: typeof c.generateQuietPrompt === 'function' ? c.generateQuietPrompt.bind(c) : null,
    };
}

export function toast(msg, type = 'info') {
    try {
        if (window.toastr && typeof window.toastr[type] === 'function') { window.toastr[type](msg); return; }
        if (window.toastr && typeof window.toastr.info === 'function') { window.toastr.info(msg); return; }
    } catch (e) { /* ignore */ }
    if (type === 'error') console.error('[WorldEngine]', msg);
    else console.log('[WorldEngine]', msg);
}

export function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

/** 等待酒馆就绪：APP_READY 事件 + 轮询兜底 */
export function waitAppReady(timeout = 10000) {
    return new Promise((resolve) => {
        let finished = false;
        const done = () => { if (!finished) { finished = true; resolve(); } };
        try {
            const es = getEventSource();
            const types = getEventTypes();
            if (es && types && types.APP_READY) es.once(types.APP_READY, done);
        } catch (e) { /* ignore */ }
        const t0 = Date.now();
        const timer = setInterval(() => {
            const ready = !!getContext() && document.readyState !== 'loading';
            if (ready && Date.now() - t0 > 1200) { clearInterval(timer); done(); }
            if (Date.now() - t0 > timeout) { clearInterval(timer); done(); }
        }, 250);
    });
}

/** 当前用户 / 角色名（用于占位符与主角过滤） */
export function getNames() {
    const c = getContext();
    let user = (c && c.name1) || window.name1 || '';
    let char = (c && c.name2) || window.name2 || '';
    try {
        const ch = c && Array.isArray(c.characters) ? c.characters[c.characterId] : null;
        if (ch && !char) char = ch.name || ch.data && ch.data.name || '';
    } catch (e) { /* ignore */ }
    return { user: user || '用户', char: char || '' };
}

export function getRequestHeaders() {
    const c = getContext();
    if (c && typeof c.getRequestHeaders === 'function') {
        try { return c.getRequestHeaders(); } catch (e) { /* ignore */ }
    }
    return { 'Content-Type': 'application/json' };
}
