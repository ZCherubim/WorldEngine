/**
 * LLM 调用（参考 st-end-component-generator 的成熟写法）
 *
 * 通道（运行设置里选）：
 *   tavern = 跟随酒馆主连接（默认）
 *            ① 酒馆连接管理器 ConnectionManagerRequestService.sendRequest(profileId, messages, ...)
 *               —— 直接用你在酒馆「连接管理器」里保存/选中的那个连接（含预设），可指定 profileId
 *            ② getContext().generateRaw —— 用酒馆当前选中的 API 连接
 *            ③ getContext().ChatCompletionService.processRequest —— 酒馆内置 chat completions 服务
 *            ④ HTTP /api/backends/chat-completions/generate —— 最后兜底
 *   auto   = 插件里填了独立 API 就用，没填 / 调用失败 → 自动跟随酒馆主连接
 *   direct = 只用插件里填的独立 API
 */
import { getSettings, saveSettings } from '../config.js';
import { getContext, getRequestHeaders, getGenerationApi } from '../core/st.js';

/* ---------------- 通用工具 ---------------- */

const textOf = (v) => String(v ?? '').trim();
// 显式设 0 也要生效，不能被 || 默认值吞掉
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function stripKnownEndpoint(url) {
    return textOf(url)
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/models$/i, '');
}

/**
 * 纯域名自动补 /v1（v2.3.6）。
 *
 * 用户填 `https://api.deepseek.com` 时，如果不补这段会拼成
 * `https://api.deepseek.com/chat/completions` → 404（几乎所有 OpenAI 兼容服务都要求 /v1）。
 * 规则刻意保守：**只有"域名后面完全没有路径"时才补**，已带路径的地址原样保留，
 * 免得破坏 `/v2/coding` 这类自定义路由。
 */
function ensureBasePath(base) {
    if (!base) return base;
    if (/^https?:\/\/[^/?#]+$/i.test(base)) return `${base}/v1`;
    return base;
}

/**
 * 备用地址：在 /v1 的有无之间互换。
 * 只在首个地址明确返回 404/405 时试一次（详见 testEndpoint 的用法）。
 */
export function alternateV1Url(base) {
    const b = textOf(base).replace(/\/+$/, '');
    if (!b) return '';
    return /\/v1$/i.test(b) ? b.replace(/\/v1$/i, '') : `${b}/v1`;
}

export function normalizeChatCompletionsUrl(url) {
    const base = ensureBasePath(stripKnownEndpoint(url));
    return base ? `${base}/chat/completions` : '';
}

export function normalizeModelsUrl(url) {
    const base = ensureBasePath(stripKnownEndpoint(url));
    return base ? `${base}/models` : '';
}

/** 请求体统一声明"不用工具"：
 *  酒馆助手的预设脚本会 monkey-patch fetch，拦住所有 /api/backends/…/generate
 *  塞进合成工具、把返回劫持成工具调用（实测拖慢数倍）。这类拦截器普遍认
 *  「调用方自带 tool_choice 就放行」。对上游无影响：ST 服务端只在 tools 为非空
 *  数组时才转发这个字段，我们从不发 tools。 */
const NO_TOOLS = { tool_choice: 'none' };

function pickContent(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    return data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.content
        ?? data?.result?.choices?.[0]?.message?.content
        ?? data?.text
        ?? data?.response
        ?? '';
}

/** 从各种返回结构里挖真正的错误原因（酒馆常返回 {error:true, message:"..."}） */
function extractError(data, status) {
    if (data) {
        if (typeof data === 'string' && data.trim()) return data.trim();
        if (data.message) return typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
        if (data.error) {
            if (typeof data.error === 'string' && data.error) return data.error;
            if (typeof data.error === 'object') {
                if (data.error.message) return String(data.error.message);
                if (data.error.type) return String(data.error.type);
                const s = JSON.stringify(data.error);
                if (s && s !== '{}' && s !== 'true' && s !== 'false') return s;
            }
        }
        if (data.detail) return String(data.detail);
        if (data.msg) return String(data.msg);
    }
    return `HTTP ${status}`;
}

function dbg(...args) {
    try {
        if (getSettings().debug) console.log('[WorldEngine]', ...args);
    } catch (e) { /* ignore */ }
}

/** 是否把连接管理器的预设一起套上（默认关 —— 见 config 与 connectionManagerChat 的说明） */
function includePresetOn() {
    try { return !!getSettings().api.includePreset; } catch (e) { return false; }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时（${Math.round(ms / 1000)} 秒）`)), ms);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/** 把 chat messages 拆成 generateRaw 需要的 systemPrompt / prompt */
function splitMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const systemPrompt = list.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    const rest = list.filter((m) => m.role !== 'system');
    let prompt = '';
    if (rest.length === 1) prompt = textOf(rest[0].content);
    else prompt = rest.map((m) => `【${m.role === 'user' ? '指令' : '上一轮回复'}】\n${textOf(m.content)}`).join('\n\n');
    return { systemPrompt, prompt };
}

/* ---------------- 自调用标志 ----------------
 * 插件自己的演化请求（走 generateRaw / 连接管理器）也会触发 CHAT_COMPLETION_PROMPT_READY，
 * 注入器靠这个标志跳过，避免世界状态被塞进演化提示词自己（token 翻倍 + 自我污染）。
 */
let selfGenerating = 0;

export function isSelfGenerating() { return selfGenerating > 0; }

/* ---------------- 酒馆连接管理器（推荐路径） ---------------- */

/** 酒馆连接管理器里保存的预设列表 */
export function listTavernProfiles() {
    const c = getContext();
    const raw = c?.extensionSettings?.connectionManager?.profiles
        || window.extension_settings?.connectionManager?.profiles
        || [];
    const list = Array.isArray(raw)
        ? raw
        : Object.entries(raw || {}).map(([id, p]) => ({ ...(p || {}), id: p?.id || id }));
    return list
        .filter((p) => p && p.id)
        .map((p) => ({ id: String(p.id), name: textOf(p.name) || String(p.id), model: textOf(p.model), api: textOf(p.api) }));
}

/** 当前该用哪个连接：插件里指定了就用它，否则用酒馆当前选中的 */
export function activeProfileId() {
    const s = getSettings();
    if (textOf(s.api.tavernProfile)) return textOf(s.api.tavernProfile);
    const c = getContext();
    const cm = c?.extensionSettings?.connectionManager || window.extension_settings?.connectionManager || {};
    return textOf(cm.selectedProfile || cm.selected || '');
}

function connectionManagerService() {
    const c = getContext();
    return c?.ConnectionManagerRequestService
        || window?.SillyTavern?.ConnectionManagerRequestService
        || window?.ConnectionManagerRequestService
        || null;
}

async function connectionManagerChat(messages, maxTokens, timeoutMs) {
    const service = connectionManagerService();
    const profileId = activeProfileId();
    if (!service || typeof service.sendRequest !== 'function') {
        return { ok: false, err: '没有 ConnectionManagerRequestService（酒馆可能较旧，或没启用连接管理器）' };
    }
    if (!profileId) {
        return { ok: false, err: '酒馆连接管理器里没有选中的连接' };
    }
    dbg('酒馆主连接 → ConnectionManagerRequestService.sendRequest，profile =', profileId);
    const r = await withTimeout(service.sendRequest(profileId, messages, Number(maxTokens) || 4096, {
        extractData: true,
        // 预设默认不套（v2.3.7）：套上会把用户的正文格式要求（"输出 4000 字正文 + XML 标签"之类）
        // 整份灌进演化提示词，既污染判断又白烧 token。连接参数（URL/key/model）不受影响，
        // 那是 profile 自带的。确实需要预设的用户可以在运行设置里打开。
        includePreset: includePresetOn(),
        stream: false,
    }), timeoutMs);
    const text = textOf(r?.result?.choices?.[0]?.message?.content) || textOf(r?.content) || textOf(r);
    if (!text) return { ok: false, err: '连接管理器返回为空' };
    dbg('连接管理器返回 ←', text.slice(0, 200));
    return { ok: true, text };
}

/* ---------------- 酒馆内置 chat completions 服务 ---------------- */

function chatCompletionService() {
    const c = getContext();
    return c?.ChatCompletionService
        || window?.SillyTavern?.ChatCompletionService
        || window?.ChatCompletionService
        || null;
}

function normalizeSource(source) {
    const s = textOf(source).toLowerCase();
    if (!s) return 'custom';
    return s;
}

async function chatCompletionServiceChat(messages, temperature, maxTokens, timeoutMs) {
    const svc = chatCompletionService();
    if (!svc || typeof svc.processRequest !== 'function') {
        return { ok: false, err: '没有 ChatCompletionService' };
    }
    const profileId = activeProfileId();
    const profile = listTavernProfiles().find((p) => p.id === profileId) || {};
    const s = getSettings();
    const url = textOf(profile.url) || textOf(s.api.url);
    const model = textOf(profile.model) || textOf(s.api.model);
    if (!model) return { ok: false, err: '没有可用模型名' };

    const requestData = {
        stream: false,
        messages,
        model,
        chat_completion_source: normalizeSource(profile.api),
        max_tokens: Number(maxTokens) || 4096,
        temperature: numOr(temperature, 0.4),
    };
    if (url) requestData.custom_url = stripKnownEndpoint(url);
    if (textOf(s.api.key)) requestData.custom_include_headers = `Authorization: Bearer ${textOf(s.api.key)}`;

    dbg('酒馆主连接 → ChatCompletionService.processRequest，source =', requestData.chat_completion_source);
    const r = await withTimeout(svc.processRequest(requestData, {}, true), timeoutMs);
    const text = textOf(r?.content) || textOf(pickContent(r?.result || r));
    if (!text) return { ok: false, err: 'ChatCompletionService 返回为空' };
    dbg('ChatCompletionService 返回 ←', text.slice(0, 200));
    return { ok: true, text };
}

/* ---------------- 兜底：generateRaw / HTTP ---------------- */

async function generateRawChat(messages, timeoutMs) {
    const api = getGenerationApi();
    if (!api.generateRaw) return { ok: false, err: '没有 getContext().generateRaw' };
    const { systemPrompt, prompt } = splitMessages(messages);
    dbg('酒馆主连接 → generateRaw');
    const raw = await withTimeout(api.generateRaw({ systemPrompt, prompt, prefill: '' }), timeoutMs);
    const text = textOf(raw);
    if (!text) return { ok: false, err: 'generateRaw 返回为空' };
    dbg('generateRaw 返回 ←', text.slice(0, 200));
    return { ok: true, text };
}

async function httpTavernChat(messages, maxTokens, timeoutMs) {
    // 服务端 /api/backends/chat-completions/generate 要求 chat_completion_source、model 等必填字段，
    // 只发 {messages, stream:false} 会被直接打回（老版本酒馆上这条兜底曾经形同虚设）
    const s = getSettings();
    const profileId = activeProfileId();
    const profile = listTavernProfiles().find((p) => p.id === profileId) || {};
    const model = textOf(profile.model) || textOf(s.api.model);
    if (!model) return { ok: false, err: '没有可用模型名（服务端接口兜底需要模型名）' };
    const url = textOf(profile.url) || textOf(s.api.url);
    const body = {
        messages,
        stream: false,
        model,
        chat_completion_source: normalizeSource(profile.api),
        max_tokens: Number(maxTokens) || 4096,
        ...NO_TOOLS,
    };
    if (url) body.custom_url = stripKnownEndpoint(url);
    if (textOf(s.api.key)) body.custom_include_headers = `Authorization: Bearer ${textOf(s.api.key)}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        const content = textOf(pickContent(data));
        if (content) return { ok: true, text: content };
        return { ok: false, err: extractError(data, res.status) };
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- 通道 2：跟随酒馆主连接（多级兜底） ---------------- */

async function tavernChat(messages, timeoutMs = 180000) {
    const s = getSettings();
    const maxTokens = Number(s.api.maxTokens) || 4096;
    const temperature = numOr(s.api.temperature, 0.4);
    const errs = [];

    const steps = [
        ['连接管理器', () => connectionManagerChat(messages, maxTokens, timeoutMs)],
        ['generateRaw', () => generateRawChat(messages, timeoutMs)],
        ['内置 chat completions 服务', () => chatCompletionServiceChat(messages, temperature, maxTokens, timeoutMs)],
        ['服务端接口', () => httpTavernChat(messages, maxTokens, timeoutMs)],
    ];

    for (const [name, run] of steps) {
        try {
            const r = await run();
            if (r && r.ok && r.text) return r.text;
            errs.push(`${name}：${(r && r.err) || '返回为空'}`);
        } catch (e) {
            errs.push(`${name}：${(e && e.message) ? e.message : e}`);
        }
    }

    throw new Error(`酒馆主连接不可用。${errs.join('；')}。请先确认酒馆自己点「生成」能正常出内容。`);
}

/* ---------------- 通道 1：独立 API（OpenAI 格式） ---------------- */

/** 发一次独立 API 请求（不含自动纠错，供 openaiChat 复用） */
async function openaiChatOnce(endpoint, key, model, messages, temperature, maxTokens, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages,
                temperature: numOr(temperature, 0.4),
                max_tokens: Number(maxTokens) || 4096,
                stream: false,
            }),
            signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        const content = textOf(pickContent(data));
        if (content) return { ok: true, text: content, status: res.status };
        return { ok: false, err: extractError(data, res.status), status: res.status };
    } catch (e) {
        return { ok: false, err: (e && e.message) || String(e), status: 0 };
    } finally {
        clearTimeout(timer);
    }
}

async function openaiChat(url, key, model, messages, temperature, maxTokens, timeoutMs = 120000) {
    const base = ensureBasePath(stripKnownEndpoint(url));
    const endpoint = base ? `${base}/chat/completions` : '';
    dbg('独立 API 请求 →', endpoint, '| model =', model);

    const first = await openaiChatOnce(endpoint, key, model, messages, temperature, maxTokens, timeoutMs);
    if (first.ok) {
        dbg('独立 API 返回 ←', first.text.slice(0, 200));
        return first.text;
    }

    // 404/405 多半是 /v1 多了一层或少了一层 → 自动试另一种形式；
    // 成功就把纠正后的地址写回设置，下次不用再猜。
    if (first.status === 404 || first.status === 405) {
        const altBase = alternateV1Url(base);
        if (altBase && altBase !== base) {
            const altEndpoint = `${altBase}/chat/completions`;
            dbg('独立 API 首个地址返回', first.status, '→ 自动试备用地址', altEndpoint);
            const second = await openaiChatOnce(altEndpoint, key, model, messages, temperature, maxTokens, timeoutMs);
            if (second.ok) {
                try { getSettings().api.url = altBase; saveSettings(); } catch (e) { /* ignore */ }
                dbg('已自动改用并写回设置：', altBase);
                return second.text;
            }
        }
    }
    throw new Error(first.err || `HTTP ${first.status}`);
}

/** 从各种返回结构里提取模型名，去重并排序 */
function pickModelNames(data) {
    const list = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
            : Array.isArray(data) ? data : [];
    return [...new Set(list
        .map((it) => textOf(typeof it === 'string' ? it : it?.id || it?.name || it?.model))
        .filter(Boolean))].sort();
}

/**
 * 拉取模型列表（填完地址后点「拉取模型」用）。
 *
 * 优先走**酒馆服务端代理**（/api/backends/chat-completions/status）：请求由 ST
 * 服务端转发，没有浏览器 CORS 问题，密钥也不经过页面。只需 url + key，
 * 不需要先填 model。
 * 代理不可用（老版本酒馆 / 该端点被改）时退回浏览器直连，保证功能不丢。
 */
export async function fetchModelList(url, key) {
    const base = ensureBasePath(stripKnownEndpoint(url));
    if (!base) throw new Error('请先填写 API 地址');

    try {
        const res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: base,
                proxy_password: textOf(key),
                ...NO_TOOLS,
            }),
        });
        if (res.ok) {
            const data = await res.json().catch(() => null);
            const names = pickModelNames(data);
            if (names.length) return names;
        } else {
            dbg('代理拉模型返回 HTTP', res.status, '→ 改用直连');
        }
    } catch (e) {
        dbg('代理拉模型失败 → 改用直连：', e && e.message);
    }

    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/models`, { method: 'GET', headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    return pickModelNames(data);
}

/* ---------------- 对外接口 ---------------- */

export function apiReady() {
    const s = getSettings();
    return !!(s.api && s.api.url && s.api.model);
}

export function usingTavern() {
    const s = getSettings();
    const mode = (s.api && s.api.mode) || 'tavern';
    return mode === 'tavern' || (mode !== 'direct' && !apiReady());
}

/** 主入口 */
export async function callLLM(messages, opts = {}) {
    const s = getSettings();
    const mode = (s.api && s.api.mode) || 'tavern';
    selfGenerating++;
    try {
        return await callLLMInner(messages, opts, s, mode);
    } finally {
        selfGenerating--;
    }
}

async function callLLMInner(messages, opts, s, mode) {
    if (mode === 'tavern') {
        return await tavernChat(messages, opts.timeoutMs);
    }

    let lastErr = null;
    if (apiReady()) {
        try {
            return await openaiChat(s.api.url, s.api.key, s.api.model, messages, s.api.temperature, s.api.maxTokens, opts.timeoutMs);
        } catch (e) {
            lastErr = e;
            if (mode === 'direct') throw new Error(`独立 API 调用失败：${e.message}`);
            if (!s.allowFallback) {
                throw new Error(`独立 API 调用失败：${e.message}。想失败时自动跟随酒馆主连接，请勾选「允许回退」或把通道改成「跟随酒馆主连接」。`);
            }
            dbg('独立 API 失败，改用酒馆主连接：', e.message);
        }
    }

    try {
        return await tavernChat(messages, opts.timeoutMs);
    } catch (e) {
        const prefix = lastErr ? `独立 API 失败（${lastErr.message}），` : '';
        throw new Error(`${prefix}${e.message}`);
    }
}

/** 当前生效通道名，面板显示用 */
export function currentChannel() {
    const s = getSettings();
    const mode = (s.api && s.api.mode) || 'tavern';
    const pid = activeProfileId();
    const profile = listTavernProfiles().find((p) => p.id === pid);
    const via = connectionManagerService() ? '连接管理器' : (getGenerationApi().generateRaw ? 'generateRaw' : '服务端接口');
    if (mode === 'tavern') {
        return profile
            ? `跟随酒馆连接：${profile.name}${profile.model ? ' · ' + profile.model : ''}（${via}）`
            : `跟随酒馆主连接（${via}）`;
    }
    if (apiReady()) return `独立 API · ${s.api.model}`;
    if (mode === 'direct') return '未配置（通道=仅独立 API，但没填地址/模型）';
    return '未配置 → 自动跟随酒馆主连接';
}

/** 自检用：当前有哪些可用的生成接口 */
export function tavernApiInfo() {
    const out = [];
    if (connectionManagerService()) out.push('ConnectionManagerRequestService（连接管理器）');
    if (getGenerationApi().generateRaw) out.push('getContext().generateRaw');
    if (chatCompletionService()) out.push('ChatCompletionService');
    out.push('HTTP /api/backends/chat-completions/generate');
    return out.join('、');
}

export function hasConnectionManagerService() { return !!connectionManagerService(); }
export function hasChatCompletionService() { return !!chatCompletionService(); }
