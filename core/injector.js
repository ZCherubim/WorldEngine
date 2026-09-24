/**
 * 上下文注入：CHAT_COMPLETION_PROMPT_READY 时把世界状态塞进 AI 上下文（AI 看得到但不输出）
 *
 * v2.4.0 攻防生态 —— 注入升级为三档强度（settings.inject.mode）：
 *   passive  被动背景：只给动向 / 现场内心 / 性格（v2.3 行为）
 *   active   主动钩子（默认）：+ 心线承诺块 + 点名衔接块 + 剧情钩子（"可以走进剧情"）
 *   director 强导演：钩子升级为强指令（"接下来的正文应让这些事件发生"）
 *
 * v2.3.28 竞态修复 + 可观测 —— 按自调用签名（SELF_TAG）识别插件自己的请求：
 * 演化运行中用户的正文注入不再被全局忙标志误杀；注入结果（✓字数 / ✕原因）面板实时可见。
 *
 * v2.3.23 防全知改造 —— 基础三块：
 *   ① 角色动向（公开面）：时间 · 地点 · 在做什么 —— **全员**都注入。
 *   ② 现场人物内心：心情 / 目标 / 近况 —— **只给正文正在演的人**（现场名单）。
 *   ③ 角色性格：五维人设 —— 独立的设定层，不算"此刻的秘密"，可在设置里关掉省 token。
 * v2.4.0 心线 / 承诺同样只给「现场 + 被点名」的人 —— 远处的人心里对谁什么档位是秘密。
 */
import { getSettings } from '../config.js';
import { getState } from './state.js';
import { SELF_TAG } from '../api/llm.js';
import { getRecentChat, getChatLength } from './chat.js';
import { getNames } from './st.js';
import {
    CATEGORY_LABEL, CATEGORY_ORDER, childrenOf, topNodes, stateLine, hasPersona,
    PERSONA_ORDER, PERSONA_LABEL, parseSceneInfo, sceneNames, coreName,
    BOND_TIERS, staleRivals,
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

/** 用户最新一条发言的正文（点名注入的素材） */
function latestUserText() {
    try {
        const msgs = getRecentChat(8) || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i] && msgs[i].is_user) return String(msgs[i].mes || '');
        }
    } catch (e) { /* ignore */ }
    return '';
}

/**
 * 用户最新消息里点名到的角色（修"世界引擎里她在约会、正文里她在家改作业"的割裂）：
 * 被提到的人必须从她当前的世界状态出发演下一幕。
 * 名字短于 2 字不匹配（防"叶""陈"这类单字误中）。
 */
function mentionedNodes(state, text, userName) {
    if (!text) return [];
    const out = [];
    Object.values(state.nodes).forEach((n) => {
        if (!n || n.archived || state.hidden.includes(n.name)) return;
        const nm = String(n.name || '');
        const core = coreName(nm);
        if (nm.length < 2 && (!core || core.length < 2)) return;
        if (userName && (nm === userName || core === userName)) return;
        if ((nm.length >= 2 && text.includes(nm)) || (core && core.length >= 2 && text.includes(core))) {
            if (!out.some((x) => x.name === n.name)) out.push(n);
        }
    });
    return out;
}

/** 按名字取未归档节点 */
function nodeByName(state, name) {
    return Object.values(state.nodes).find((n) => !n.archived && n.name === name) || null;
}

/** 心线 + 生效承诺（只给「现场 + 点名」的人 —— 防全知） */
function bondCommitText(state, nodes, userName) {
    const lines = [];
    const seen = new Set();
    nodes.forEach((n) => {
        if (!n || !n.bonds) return;
        Object.entries(n.bonds).forEach(([k, b]) => {
            if (!b || !Number.isFinite(b.tier)) return;
            const tgt = k === '{{user}}' ? (userName || '{{user}}') : k;
            const line = `${n.name} 对 ${tgt}：${BOND_TIERS[b.tier]}${b.note ? `（${b.note}）` : ''}`;
            if (!seen.has(line)) { seen.add(line); lines.push(line); }
        });
    });
    (state.commitments || []).forEach((c) => {
        if (!c || c.status !== 'active') return;
        if (!nodes.some((n) => n && (n.name === c.who || coreName(n.name) === coreName(c.who)))) return;
        const line = `${c.who} 的承诺：「${c.text}」`;
        if (!seen.has(line)) { seen.add(line); lines.push(line); }
    });
    return lines.join('\n');
}

/** 前瞻性事件词：状态摘要 / 近况里带这些词的，就是"即将撞线"的钩子 */
const HOOK_RE = /即将|马上|正要|准备|打算|约定|约了|答应|威胁|逼近|发现|撞见|摊牌|查岗|追问|最后通牒|等.{0,8}回复|犹豫|动摇/;

/**
 * 剧情钩子（v2.4.0）：世界引擎推演出的"即将撞线"事件。
 *   ① 停滞的攻防线（对手该出手了）；
 *   ② 状态摘要 / 近况里带前瞻词的角色。
 */
function hookEntries(state, settings, scene) {
    const out = [];
    try {
        const floor = getChatLength();
        const gap = Math.max(1, Number(settings.tracking.rivalGap) || 3);
        staleRivals(state, floor, gap, 360, scene).slice(0, 2).forEach((g) => {
            const when = g.minSince != null ? `约 ${Math.max(1, Math.round(g.minSince / 60))} 小时` : `${g.floorsSince} 层`;
            out.push(`${g.woman} 的关系线「${g.rival.name}」已 ${when}没有动作，他随时可能发起新一轮攻势（电话 / 消息 / 上门 / 送礼）`);
        });
    } catch (e) { /* ignore */ }
    Object.values(state.nodes).forEach((n) => {
        if (out.length >= 3) return;
        if (!n || n.archived || state.hidden.includes(n.name)) return;
        const txt = `${n.summary || ''}${n.mindset || ''}`;
        if (txt && HOOK_RE.test(txt)) {
            out.push(`${n.name}：${n.summary || ''}${n.mindset ? `（近况：${n.mindset}）` : ''}`);
        }
    });
    return out.slice(0, 3);
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
    const mode = settings.inject.mode === 'passive' || settings.inject.mode === 'director'
        ? settings.inject.mode : 'active';
    const { user } = getNames();

    const move = [];    // ① 公开动向（全员）
    const inner = [];   // ② 现场内心（只有正在演的人）
    const persona = []; // ③ 人设性格（设定层）

    function walk(node, level) {
        const ind = level > 0 ? '　'.repeat(level) + '· ' : '';
        move.push(`${ind}${node.name}：${stateLine(node) || '（暂无状态）'}`);
        if (scene.has(node.name) && (node.mood || node.goal || node.mindset)) {
            const bits = [node.mood && `心情：${node.mood}`, node.goal && `目标：${node.goal}`, node.mindset && `近况：${node.mindset}`]
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

    // ---- v2.4.0 主动层（passive 档全部跳过，回到 v2.3 行为） ----
    if (mode !== 'passive') {
        // 被点名角色：用户最新消息里提到的人 —— 状态必须衔接，不许凭空分裂
        const mentioned = mentionedNodes(state, latestUserText(), user).slice(0, 3);
        if (mentioned.length) {
            const lines = mentioned.map((n) => {
                const st = stateLine(n) || '（暂无状态）';
                return `· ${n.name}：${st}${n.mindset ? `（近况：${n.mindset}）` : ''}\n  → 她的下一幕必须从这个状态出发（可以自然推进，但不许凭空换地点、换活动）`;
            });
            blocks.push(`【点名角色 —— 状态衔接】（用户刚提到的人）\n${lines.join('\n')}`);
        }
        // 心线与承诺：只给现场 + 点名的人（防全知 —— 远处的心是秘密）
        const focus = [...scene].map((nm) => nodeByName(state, nm)).filter(Boolean);
        mentioned.forEach((m) => { if (!focus.some((x) => x.name === m.name)) focus.push(m); });
        const bc = bondCommitText(state, focus, user);
        if (bc) {
            blocks.push(`【心线与承诺】（正在演的人的内心倾向 —— 决定她对攻势 / 示好的真实反应）\n${bc}`);
        }
        // 剧情钩子：世界即将撞线的事件
        const hooks = hookEntries(state, settings, scene);
        if (hooks.length) {
            blocks.push(mode === 'director'
                ? `【剧情导演 —— 强指令】\n接下来的正文应让下列事件自然发生（作为正在进行的剧情穿插，不是复述）：\n${hooks.map((h) => `· ${h}`).join('\n')}`
                : `【剧情走向】（世界引擎的推演 —— 正文可以自然走进这些剧情，不必回避）\n${hooks.map((h) => `· ${h}`).join('\n')}`);
        }
    }

    if (personaOn && persona.length) blocks.push(`【角色性格】（人设设定，不是此刻的动态）\n${persona.join('\n')}`);
    blocks.push('（以上是世界背景，仅供你把握剧情；不要直接输出或复述，也不要让角色说出他本不该知道的事。「心线」「承诺」「世界引擎」是幕后机制词，任何角色口中都不要出现 —— 全部表现为自然的情感、犹豫与行为）');
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

/* ---------------- 注入可观测（v2.3.28） ----------------
 * 每次主对话组装提示词都记录结果；面板「运行设置 → 上下文注入」实时显示，
 * "到底注入了吗"从此不用抓包猜。
 */
let lastInject = null; // { ok, chars, reason, at }

export function getLastInject() { return lastInject; }

export function injectStatusText(rec) {
    const r = rec || lastInject;
    if (!r) return '本次会话还没有注入记录（发一条消息后更新）';
    return r.ok
        ? `上轮注入 ✓ ${r.chars} 字（${r.at}）`
        : `上轮注入 ✕ ${r.reason}（${r.at}）`;
}

function recordInject(ok, chars, reason) {
    lastInject = {
        ok: !!ok,
        chars: chars || 0,
        reason: reason || '',
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    // 面板开着就顺手刷新状态行；没开也无所谓，下次渲染会读 lastInject
    try {
        const el = document.getElementById('we-inject-status');
        if (el) el.textContent = injectStatusText(lastInject);
    } catch (e) { /* 忽略 */ }
}

/** 这次 prompt-ready 是不是插件自己的请求：查 llm.js 打在请求尾部的自调用签名 */
function isSelfPrompt(arr) {
    const joined = arr.map((x) => String((x && x.content) || '')).join('\n');
    return joined.includes(SELF_TAG);
}

export function injectIntoPrompt(data) {
    const settings = getSettings();
    if (!settings.enabled || !settings.inject.enabled) {
        recordInject(false, 0, '跳过：总开关或注入开关没开');
        return false;
    }

    const arr = targetArray(data);
    if (!arr) {
        console.warn('[WorldEngine] 这次生成请求的 prompt 结构不是对象数组，跳过注入');
        recordInject(false, 0, '跳过：提示词结构不是对象数组');
        return false;
    }

    // 插件自己的演化/整理请求（generateRaw / 连接管理器）也会触发本事件：
    // 演化提示词里本来就带全量状态，再注入一次等于 token 翻倍，必须跳过。
    // v2.3.28：旧版在这里看全局忙标志（isSelfGenerating）一票否决 —— 但忙标志分不清
    // 「这次请求就是演化自己」和「演化恰好在跑、来的是用户的正文请求」，后者被误杀，
    // 赶在演化完成前发的消息全部裸奔（世界状态根本没进上下文）。
    // 现在按自调用签名（SELF_TAG，llm.js 打在插件请求尾部的零宽字符）识别：
    // 是我们自己的请求才跳过；演化运行中，正文注入照常进行。
    if (isSelfPrompt(arr)) {
        // 不记录：演化自己的请求不该刷掉"上轮正文注入"的结果
        return false;
    }

    const text = buildInjectionText();
    if (!text) {
        recordInject(false, 0, '跳过：世界状态为空');
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
    recordInject(true, text.length, '');
    return true;
}