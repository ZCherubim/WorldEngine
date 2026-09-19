/**
 * 上下文注入：CHAT_COMPLETION_PROMPT_READY 时把世界状态塞进 AI 上下文（AI 看得到但不输出）
 *
 * v2.3.23 防全知改造 —— 分三块注入：
 *   ① 角色动向（公开面）：时间 · 地点 · 在做什么 —— **全员**都注入。
 *      这些在现实里街头可见，AI 靠它才能"看到世界在转"、主动推进剧情。
 *   ② 现场人物内心：心情 / 目标 —— **只给正文正在演的人**（现场名单）。
 *      远处的人心里在想什么，正文 AI 不该知道（原来的全员内心 = 未卜先知）。
 *   ③ 角色性格：五维人设 —— 独立的设定层，不算"此刻的秘密"，可在设置里关掉省 token。
 */
import { getSettings } from '../config.js';
import { getState } from './state.js';
import { isSelfGenerating } from '../api/llm.js';
import { getRecentChat } from './chat.js';
import {
    CATEGORY_LABEL, CATEGORY_ORDER, childrenOf, topNodes, stateLine, hasPersona,
    PERSONA_ORDER, PERSONA_LABEL, parseSceneInfo, sceneNames, coreName,
} from './protocol.js';

export const INJECT_MARK = '<<WorldEngine>>';

/** 最近几层正文的纯文本（和演化引擎的「现场判定」用同一份素材） */
function recentSceneText(settings) {
    try {
        const n = Math.max(1, Number(settings.tracking.sceneDepth) || 2);
        return (getRecentChat(n) || []).map((m) => String(m && m.mes ? m.mes : '')).join('\n');
    } catch (e) {
        return '';
    }
}

/**
 * 现场名单：正文里正在演的人。
 * 优先用场景卡的精确在场名单（<SceneInfo> 在场角色）；没有场景卡才退回名字匹配 ——
 * 名字匹配会把"被台词提一句的人"也算进来（"让周磊去拿火腿肠"），
 * 对注入来说那些人其实不在现场，不该拿到内心字段。
 */
function sceneSetOf(state, settings) {
    const out = new Set();
    const text = settings.tracking.sceneGuard === false ? '' : recentSceneText(settings);
    if (!text) return out;
    const info = parseSceneInfo(text);
    if (info && info.names.length) {
        info.names.forEach((nm) => {
            const hit = Object.values(state.nodes).find(
                (n) => !n.archived && (n.name === nm || coreName(n.name) === nm),
            );
            if (hit) out.add(hit.name);
        });
        return out;
    }
    return sceneNames(state, { text, floors: Number(settings.tracking.sceneDepth) || 2 });
}

export function buildInjectionText() {
    const settings = getSettings();
    const state = getState();
    if (!state || Object.keys(state.nodes || {}).length === 0) return '';

    const depth = Math.max(1, Number(settings.tracking.injectionDepth) || 2);
    const skipMap = (settings.inject.skipWritten && settings.writeToChat.enabled)
        ? settings.writeToChat.categories
        : null;
    const personaOn = settings.inject.persona !== false;
    const scene = sceneSetOf(state, settings);

    const move = [];    // ① 公开动向（全员）
    const inner = [];   // ② 现场内心（只有正在演的人）
    const persona = []; // ③ 人设性格（设定层）

    function walk(node, level) {
        const ind = level > 0 ? '　'.repeat(level) + '· ' : '';
        move.push(`${ind}${node.name}：${stateLine(node) || '（暂无状态）'}`);
        if (scene.has(node.name) && (node.mood || node.goal)) {
            const bits = [node.mood && `心情：${node.mood}`, node.goal && `目标：${node.goal}`]
                .filter(Boolean).join('，');
            inner.push(`${ind}${node.name}：${bits}`);
        }
        if (personaOn && hasPersona(node)) {
            const bits = PERSONA_ORDER
                .map((k) => (node.persona[k] ? `${PERSONA_LABEL[k]}：${node.persona[k]}` : ''))
                .filter(Boolean).join('，');
            persona.push(`${ind}${node.name}：${bits}`);
        }
        if (level + 1 >= depth) return;
        for (const c of childrenOf(state, node.id)) {
            if (state.hidden.includes(c.name)) continue;
            walk(c, level + 1);
        }
    }

    for (const cat of CATEGORY_ORDER) {
        if (skipMap && skipMap[cat]) continue;
        const tops = topNodes(state).filter((n) => n.category === cat && !n.archived && !state.hidden.includes(n.name));
        if (!tops.length) continue;
        move.push(`【${CATEGORY_LABEL[cat]}】`);
        for (const t of tops) walk(t, 0);
    }

    if (!move.length && !inner.length && !persona.length) return '';

    const blocks = [];
    if (state.worldTime) blocks.push(`当前世界时间：${state.worldTime}`);
    if (move.length) blocks.push(`【角色动向】（公开可见：谁在哪、在做什么）\n${move.join('\n')}`);
    if (inner.length) blocks.push(`【现场人物内心】（只有正文正在演的人）\n${inner.join('\n')}`);
    if (personaOn && persona.length) blocks.push(`【角色性格】（人设设定，不是此刻的动态）\n${persona.join('\n')}`);
    blocks.push('（以上是世界背景，仅供你把握剧情；不要直接输出或复述，也不要让角色说出他本不该知道的事）');
    return `【世界状态】\n${blocks.join('\n\n')}`;
}

/**
 * 注入到生成请求里
 * @param {object} data CHAT_COMPLETION_PROMPT_READY 事件数据
 */
/** 找到可以塞 system 消息的那个数组，兼容不同酒馆版本的事件数据结构 */
function targetArray(data) {
    const arr = data && Array.isArray(data.chat) ? data.chat
        : (data && Array.isArray(data.prompts) ? data.prompts
            : (data && Array.isArray(data.messages) ? data.messages : null));
    if (!arr || !arr.length) return null;
    if (!arr.every((x) => x && typeof x === 'object')) return null;
    return arr;
}

export function injectIntoPrompt(data) {
    const settings = getSettings();
    if (!settings.enabled || !settings.inject.enabled) return false;
    // 插件自己的演化调用（generateRaw / 连接管理器）也会触发本事件：
    // 演化提示词里本来就带全量状态，再注入一次等于 token 翻倍，必须跳过
    if (isSelfGenerating()) return false;
    const text = buildInjectionText();
    if (!text) return false;

    const arr = targetArray(data);
    if (!arr) {
        console.warn('[WorldEngine] 这次生成请求的 prompt 结构不是对象数组，跳过注入');
        return false;
    }

    // 清理上一次注入，避免同一轮里重复堆叠
    for (let i = arr.length - 1; i >= 0; i--) {
        const c = arr[i] && typeof arr[i].content === 'string' ? arr[i].content : '';
        if (c.includes(INJECT_MARK)) arr.splice(i, 1);
    }

    const block = `${INJECT_MARK}\n${text}\n${INJECT_MARK}`;
    const pos = settings.inject.position === 'afterSystem'
        ? Math.min(1, arr.length)
        : Math.max(0, arr.length - 1);
    arr.splice(pos, 0, { role: 'system', content: block });
    return true;
}