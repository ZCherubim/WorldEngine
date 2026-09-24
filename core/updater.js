/**
 * 世界演化（第 3 步）：载入近期剧情 → 输出增量 → 应用 → 大事记 → 工作小结 → 落盘
 *
 * 三个要点：
 *   1. 性格锁死：applyParsed 带 lockPersona，模型改不动「性格 / 底色 / 软肋 / 说话 / 行为」
 *   2. 小结回流：每次输出的「## 小结」存进 worklogs，下一轮用 {{recentNotes}} 带回去
 *   3. 外部记忆：小白X 导出的剧情记忆可以随时导入校正角色状态（applyMemory）
 */
import { callLLM } from '../api/llm.js';
import { getSettings } from '../config.js';
import { getNames, getChatArray } from './st.js';
import { loadWorldBook, selectedEntries, entriesForNames, entriesToText } from './worldbook.js';
import { getRecentChat, formatChat, getChatLength } from './chat.js';
import { getState, commit, pushLog, pushWorklog, pushEvent, recentWorklogs } from './state.js';
import { parseLines, applyParsed, serialize, serializeSubset, syncSameName, splitSummary, sceneNames, expiredNames, validNames, statusActive, coreName, parseSceneInfo, syncWorldTime, BOND_TIERS, RIVAL_LEVELS, isRivalNode, resolveNode, staleRivals } from './protocol.js';
import { applyCooldown, enforceCaps, normalizeOrder } from './categories.js';
import { pushSnapshot } from './snapshot.js';
import { diffAndRecord } from './events.js';
import { recordJump, describeJump } from './timeline.js';
import { fillTemplate, getPrompt, cleanOutput } from './template.js';
import { UPDATE_OUTPUT_RULES } from '../prompts/updatePrompt.js';
import { MEMORY_TASK } from '../prompts/organizePrompt.js';
import { fillTask } from '../prompts/stagePrompt.js';
import { parseLwb, compactLwb, compactContext, compactEvents } from './lwbMemory.js';

// lockPersona: 性格锁死；freezeTop: 顶层名单冻结（新角色进待审名单，不自动建档）
const LOCK = { lockPersona: true, freezeTop: true };

/**
 * 演化阶段的锁 + 重复挂载处理。
 *
 * keepDuplicates=true 会让 applyOps **跳过**自动合并 —— 用户在设置里关掉
 * mergeDuplicates 时走这条路（只共享状态，保留多个挂载点）。
 */
function lockFor(settings) {
    const merge = settings && settings.tracking && settings.tracking.mergeDuplicates !== false;
    return merge ? LOCK : { ...LOCK, keepDuplicates: true };
}

function activeNames(state) {
    const set = new Set();
    Object.values(state.nodes).forEach((n) => {
        if (n.archived) return;
        if (n.category === 'interaction') set.add(n.name);
    });
    return Array.from(set);
}

/**
 * 本轮点名要求模型必须输出的角色。
 *
 * 两个来源：
 *   a) 上一轮没被覆盖到的角色（优先子分支）—— 修「折叠起来的角色家庭不更新」
 *   b) **状态已过期的角色**（世界时间越过了他那一行的截止时刻）—— 时间段调度
 *
 * 反过来，**状态仍在有效期内的角色本轮豁免**（不点名）：
 *   推演说他「买菜 8:00-9:00」，世界时间还在 8:40 → 他还在买菜，不用动他；
 *   走到 9:12 → 到期了，这轮必须给新状态。
 * v2.3.21：**「有效」除了没到截止，还要求当前时刻落在时间段内**（见 protocol.statusActive）。
 *   昨晚的「19:38-21:00」被模型白天原样重发时，旧逻辑会判「有效到今晚 21:00」，
 *   家人就把昨晚的活动挂一整天没人管；现在这种行会被点名，逼模型重写成当前时刻的状态。
 * 没给时间段的角色（untilMin=null）走老逻辑，不会被误豁免；
 * 时钟没建立或用户关了「状态有效期」→ 整体退回 v2.3.4 行为。
 *
 * @param {object} state
 * @param {number} limit
 * @param {Set<string>} [scene] 现场角色（正文刚演过的）：从点名清单里排除
 * @param {boolean} [timeSlot] 是否启用状态有效期豁免
 */
function mustCoverNames(state, limit = 60, scene = null, timeSlot = true) {
    const covered = new Set(state.lastCovered || []);
    const clockOn = timeSlot && state.worldMinutes != null;
    const missing = Object.values(state.nodes).filter((n) => {
        if (n.archived) return false;
        if (state.hidden.includes(n.name)) return false;
        // 现场角色不点名：现场的事正文已经写完了，不需要世界引擎再补一层
        if (scene && scene.has(n.name)) return false;
        if (clockOn && n.untilMin != null) {
            if (statusActive(state, n)) return false;  // 仍在有效期且覆盖当前时刻 → 豁免
            return true;                                // 已到期 / 时间段不在当前时刻（昨天的残留行）→ 必须点名重写
        }
        return !covered.has(n.name);
    });
    missing.sort((a, b) => (b.level || 0) - (a.level || 0) || (a.seq || 0) - (b.seq || 0));
    const out = [];
    for (const n of missing) {
        // 必须给**完整挂载路径**（"珞珈 > 父亲朱城"），不能只给短名（"父亲朱城"）：
        // 补漏轮只喂点名清单 + 这些人的现有状态，模型看到短名不知道他是谁的爸爸，
        // 就会凭空给他编一个顶层宿主（实测幻觉出朱雯 / 陈瑶 / 苏晴 / 柳诗诗 / 李娜 一整批陌生人），
        // 顶层不在树里的进待审名单、能对上顶层名（孙翌童 / 珞珈）的就把家人张冠李戴挂上去。
        let cur = n;
        const chain = [cur.name];
        let guard = 0;
        while (cur.parent && guard++ < 20) {
            cur = state.nodes[cur.parent];
            if (!cur) break;
            chain.unshift(cur.name);
        }
        const full = chain.join(' > ');
        if (!out.includes(full)) out.push(full);
        if (out.length >= limit) break;
    }
    return out;
}

/** 本轮仍在有效期内的角色（提示词里用来"别动他们"）；现场角色不重复提醒 */
function validList(state, scene, timeSlot = true) {
    if (!timeSlot || state.worldMinutes == null) return [];
    return validNames(state).filter((v) => !(scene && scene.has(v.name)));
}

/**
 * 对手档案维护（v2.4.0）：
 *   a) 本轮出过手的对手（状态行被更新 / 新增）→ 刷新「上次出手」楼层 / 时间 / 行动摘要；
 *   b) 宿主女人对他的心线**下跌**（from > to）→ 低手段失手，手段自动升一级。
 * 主轮和补漏轮各跑一次 —— escFloor === floor 守卫保证同一轮绝不升两级。
 */
function maintainRivals(state, res, floor) {
    const touched = new Set([...(res.added || []), ...(res.updated || [])]);
    Object.values(state.nodes || {}).forEach((n) => {
        if (!isRivalNode(n) || !touched.has(n.name)) return;
        if (!n.rival) n.rival = { level: 0, lastFloor: 0, lastMin: null, lastResult: '' };
        n.rival.lastFloor = floor;
        if (state.worldMinutes != null) n.rival.lastMin = state.worldMinutes;
        if (n.summary) n.rival.lastResult = String(n.summary).slice(0, 60);
    });
    (res.bonds || []).forEach((b) => {
        if (!b || !b.target || b.from == null || b.to == null || b.to >= b.from) return;
        const tn = resolveNode(state, b.target);
        if (!tn || !isRivalNode(tn)) return;
        const woman = tn.parent ? state.nodes[tn.parent] : null;
        if (!woman || woman.name !== b.who) return;    // 只看「宿主女人 → 对手」方向的线
        if (!tn.rival) tn.rival = { level: 0, lastFloor: 0, lastMin: null, lastResult: '' };
        if (tn.rival.escFloor === floor) return;       // 本轮已调过（主轮 + 补漏轮双跑守卫）
        tn.rival.level = Math.min(RIVAL_LEVELS.length - 1, (tn.rival.level || 0) + 1);
        tn.rival.escFloor = floor;
        pushEvent(state, {
            type: '手段',
            name: tn.name,
            text: `${tn.name}的低手段失手（${woman.name}对他的心线 ${BOND_TIERS[b.from]}→${BOND_TIERS[b.to]}），手段升级为「${RIVAL_LEVELS[tn.rival.level]}」`,
        });
    });
}

/** 心线 / 承诺变动 → 大事记（主轮和补漏轮共用） */
function recordBondCommitEvents(state, res, userName) {
    (res.bonds || []).forEach((b) => {
        if (!b) return;
        const tgt = b.target === '{{user}}' ? (userName || '{{user}}') : b.target;
        pushEvent(state, {
            type: '心线',
            name: b.who,
            text: `${b.who} 对 ${tgt} 的心线：${b.from != null && b.from >= 0 ? BOND_TIERS[b.from] : '陌生'} → ${BOND_TIERS[b.to]}${b.note ? `（${b.note}）` : ''}`,
        });
    });
    (res.commits || []).forEach((c) => {
        if (!c) return;
        const label = c.op === '+' ? '立下承诺' : c.op === '~' ? '违背承诺' : '解除承诺';
        pushEvent(state, {
            type: '承诺',
            name: c.who,
            text: `${label}「${c.text}」${c.punish ? `，${c.punish}` : ''}`,
        });
    });
}

/**
 * 近况回落（v2.4.0）：重大事件留下的心理动向（node.mindset），
 * 超过 12 层没被强化、或世界时间走过 12 小时 → 自动淡忘。
 */
function decayMindsets(state, floor = 0) {
    Object.values(state.nodes || {}).forEach((n) => {
        if (!n.mindset) return;
        const gapF = floor - (n.mindsetFloor || 0);
        const gapM = state.worldMinutes != null && n.mindsetMin != null
            ? state.worldMinutes - n.mindsetMin : 0;
        if (gapF > 12 || gapM > 720) {
            delete n.mindset;
            delete n.mindsetFloor;
            delete n.mindsetMin;
        }
    });
}

/**
 * 输入装配开关（"我到底给模型喂了啥"）—— 每一项都能在面板「输入装配」里单独关掉。
 * 关掉后该路输入在提示词里变成 OFF_TEXT，不占 token；{{占位符}} 本身还在，
 * 所以自定义提示词不会因为关开关而报错或变成空串导致的语义断裂。
 */
const OFF_TEXT = '（这一路输入已在「输入装配」里关掉，你不需要它）';

function feedOf(settings) {
    return (settings && settings.feed) || {};
}

/** 某一路输入是否启用（未配置时按启用处理，兼容旧存档） */
export function feedOn(settings, key) {
    const f = feedOf(settings);
    return f[key] !== false;
}

async function buildWorldInfo(state, settings, names) {
    if (!settings.worldbook.enabled) return '（未启用）';
    // 「输入装配」里世界书关掉时，连读都不读（省掉一次 IO + 匹配开销）
    if (!feedOn(settings, 'worldinfo')) return OFF_TEXT;
    try {
        const entries = await loadWorldBook(false, settings.worldbook.name);
        const usable = selectedEntries(entries);
        const list = settings.worldbook.updateActive ? names : Object.values(state.nodes).map((n) => n.name);
        const hit = entriesForNames(usable, list, { includeNsfw: !!settings.worldbook.includeNsfw });
        if (!hit.length) return '（本次没有命中的世界书条目）';
        return entriesToText(hit, settings.worldbook.maxChars);
    } catch (e) {
        return '（世界书读取失败）';
    }
}

/**
 * 「现场」的判定素材：只取**最近 N 层**（sceneDepth，默认 2）。
 * 现场是很短的一段——正文刚结束的那个画面。用 updateDepth（默认 3）太宽，
 * 会把十几分钟前已经离开的角色也算成在现场。
 */
function sceneTextOf(settings) {
    try {
        const n = Math.max(1, Number(settings.tracking.sceneDepth) || 2);
        const chat = getChatArray();
        const msgs = chat.slice(Math.max(0, chat.length - n));
        return msgs.map((m) => String(m && m.mes ? m.mes : '')).join('\n');
    } catch (e) {
        return '';
    }
}

/**
 * 现场出场即交互（v2.3.13）：正文里露面的人，类别翻成交互。
 * 以前现场名单只做"排除"（不推演她们），没人翻类别 —— 实测死锁：
 * 张子薇在正文里演了一整层，模型正确地没写她的行，她的类别却永远停在【未出场】。
 *
 * v2.3.20：同时登记「剧情出场楼层」appearFloor —— 这是排序的主键。
 * 为什么不能用 floor：floor 是"世界引擎最后更新的楼层"，现场登记的人也在更新，
 * 背景天天被推演的人 floor 也一样高 —— 用它排序，"谁最近在戏里"永远排不赢"谁先被录入世界"。
 * appearFloor 只在"正文里露过面"时 bump，才是用户要的"剧情出现顺序"。
 */
function markSceneInteraction(state, scene, floor) {
    if (!scene || !scene.size) return [];
    const flipped = [];
    Object.values(state.nodes || {}).forEach((n) => {
        if (!scene.has(n.name)) return;
        // 在正文里出场过 → 登记出场楼层（排序主键）
        if (floor != null) n.appearFloor = floor;
        if (n.category !== 'interaction') {
            n.category = 'interaction';
            if (!flipped.includes(n.name)) flipped.push(n.name);
        }
    });
    return flipped;
}

/** 组装更新时的公共变量 */
function buildVars(state, settings, chatText, worldinfo, jump, mustText, scene = null, validText = '') {
    const { user, char } = getNames();
    const on = (k) => feedOn(settings, k);

    const notes = on('notes') ? recentWorklogs(state, settings.tracking.noteCount || 3) : [];
    const recentNotes = !on('notes')
        ? OFF_TEXT
        : (notes.length
            ? notes.map((w, i) => `${i + 1}. ${w.summary}`).join('\n')
            : '（这是第一次更新，之前没做过什么）');

    const memory = !on('memory')
        ? OFF_TEXT
        : (state.memoryText ? state.memoryText : '（没导入外部记忆）');

    const sceneText = !on('scene')
        ? OFF_TEXT
        : (scene && scene.size
            ? [...scene].join('、')
            : '（这次正文里没有需要特别回避的角色）');

    // 状态仍在有效期内的人：不用输出他们的行（跟 mustCover 同一路开关）
    const validText2 = !on('mustCover')
        ? OFF_TEXT
        : (validText || '（没有仍在有效期内的角色）');

    return {
        chat: on('chat') ? chatText : OFF_TEXT,
        state: on('state') ? serialize(state) : OFF_TEXT,
        worldinfo: on('worldinfo') ? worldinfo : OFF_TEXT,
        user: on('names') ? user : '（主角）',
        char: on('names') ? char : '（女主）',
        jump: on('jump') ? jump : OFF_TEXT,
        mustCover: on('mustCover') ? mustText : OFF_TEXT,
        valid: validText2,
        memory,
        recentNotes,
        scene: sceneText,
    };
}

/**
 * 补全轮的变量（v2.3.7 瘦身版）。
 *
 * 补全要干的事只有一件：把上一轮漏掉的人补上。
 * 那些正文、世界书、整棵世界树**上一轮已经看过了**，再喂一遍纯属重复烧 token ——
 * 而这正是"一次演化发两次请求、耗时翻倍"的另一半原因。
 *
 * 所以这里只给：点名清单 + 这些人的现有状态（serializeSubset）+ 上次小结。
 * 输入体积从 ~20K 降到 ~3K。
 */
function buildFillVars(state, settings, names, jump, scene) {
    const { user, char } = getNames();
    const on = (k) => feedOn(settings, k);
    const notes = on('notes') ? recentWorklogs(state, settings.tracking.noteCount || 3) : [];
    const recentNotes = !on('notes')
        ? OFF_TEXT
        : (notes.length
            ? notes.map((w, i) => `${i + 1}. ${w.summary}`).join('\n')
            : '（这是第一次更新）');

    return {
        chat: '（补全轮：正文上一轮已经看过，不需要重复判断剧情，按下面的点名清单输出即可）',
        state: on('state') ? serializeSubset(state, names) : OFF_TEXT,
        // mustCover **不跟着输入装配开关走**：补漏轮的全部任务就是"把点名的人补上"，
        // 这一路一旦被关掉，模型只剩 fillTask 一份名单、连 state 都是空的，只能靠编
        // （v2.3.25 事故的放大器）。真要停自动补漏，请关「自动补漏」总开关。
        mustCover: names.length ? names.join('、') : '（本轮没有需要补漏的人）',
        worldinfo: '（补全轮不需要世界书：这些角色的设定已经固化在他们的状态里）',
        user: on('names') ? user : '（主角）',
        char: on('names') ? char : '（女主）',
        jump: on('jump') ? jump : OFF_TEXT,
        valid: on('mustCover') ? '（补全轮只处理点名清单里的人，不用考虑状态有效期）' : OFF_TEXT,
        memory: '（补全轮不需要外部记忆：角色的既定事实已经固化在状态里）',
        recentNotes,
        scene: on('scene')
            ? (scene && scene.size ? `${[...scene].join('、')}（这些人补一行「现场记录」，照正文登记）` : '（无）')
            : OFF_TEXT,
    };
}

/**
 * 第 3 步：载入近期剧情，推演世界
 * @param {{manual?:boolean, reason?:string, taskExtra?:string}} opts
 */
export async function updateWorld(opts = {}) {
    const settings = getSettings();
    const state = getState();
    if (!state || Object.keys(state.nodes || {}).length === 0) {
        throw new Error('尚未建立世界状态，请先建档（或点「一键建立」）');
    }

    const floor = getChatLength();
    const beforeText = serialize(state);
    const oldTime = state.worldTime;

    // 正文关掉时不去取（updateDepth 默认 3 层，读取+格式化本身有成本）
    const msgs = feedOn(settings, 'chat') ? getRecentChat(settings.tracking.updateDepth) : [];
    const chatText = msgs.length
        ? (formatChat(msgs, Math.max(0, floor - msgs.length)) || '（暂无聊天内容）')
        : '（暂无聊天内容）';

    const worldinfo = await buildWorldInfo(state, settings, activeNames(state));

    const jump = oldTime
        ? describeJump(oldTime, '（以最新剧情时间为准）')
        : '（尚无上次世界时间，请以最新剧情时间为准）';

    // 现场名单（v2.3.16）：优先用正文场景卡里的**精确在场名单**（<SceneInfo> 在场角色）；
    // 场景卡里的时间同时作为世界时间的权威基准。
    // 没有场景卡的卡才退回"名字匹配"——那个会把"被台词提一句的人"（"让周磊去小卖部拿火腿肠"）误判成在场。
    // 关掉现场保护时传空集合 → 行为退回 v2.3.1（所有人都会被推演）
    const timeSlotOn = settings.tracking.timeSlot !== false;
    const sceneRaw = settings.tracking.sceneGuard === false ? '' : sceneTextOf(settings);
    const sceneInfo = sceneRaw ? parseSceneInfo(sceneRaw) : null;
    let scene = new Set();
    if (sceneRaw) {
        if (sceneInfo && sceneInfo.names.length) {
            sceneInfo.names.forEach((nm) => {
                const hit = Object.values(state.nodes).find(
                    (n) => !n.archived && (n.name === nm || coreName(n.name) === nm),
                );
                if (hit && !scene.has(hit.name)) scene.add(hit.name);
            });
        } else {
            scene = sceneNames(state, { text: sceneRaw, floors: Number(settings.tracking.sceneDepth) || 2 });
        }
    }
    const sceneFlips = markSceneInteraction(state, scene, floor);
    const must = mustCoverNames(state, 60, scene, timeSlotOn);
    // 攻防指令（v2.4.0）：停滞的关系线硬点名 —— 必须由对手发起具体行动，不是建议。
    // 旧 pushCandidates 只挑「冷却档顶层 + 排除现场」导致金主从不出手（"攻防玩不起来"的主因）；
    // 现在按关系线本身算停滞：交互 / 现场角色身上的线一样点名 —— 电话和消息可以打进现场。
    const gapFloors = Math.max(1, Number(settings.tracking.rivalGap) || 3);
    const rivalGaps = [];
    const seenWomen = new Set();
    staleRivals(state, floor, gapFloors, 360, scene).forEach((g) => {
        if (rivalGaps.length >= 2) return;          // 每轮最多 2 条线，防止一窝蜂
        if (seenWomen.has(g.woman)) return;         // 每个女人最多一条，防止围攻一个人
        seenWomen.add(g.woman);
        rivalGaps.push(g);
    });
    const rivalText = rivalGaps.length
        ? `【攻防指令 —— 必须执行，不是建议】\n${rivalGaps.map((g) => {
            const r = g.rival.rival || {};
            const lv = Math.max(0, Math.min(RIVAL_LEVELS.length - 1, r.level || 0));
            const gapTxt = g.minSince != null ? `约 ${Math.max(1, Math.round(g.minSince / 60))} 小时` : `${g.floorsSince} 层`;
            const last = r.lastResult ? `；上次出手：${r.lastResult}` : '';
            return `· ${g.woman} 的关系线「${g.rival.name}」距上次出手已 ${gapTxt}。本轮必须由他发起一次具体行动（不是日常问候），写成他的状态行。当前手段等级 ${lv + 1}/6（${RIVAL_LEVELS[lv]}）${last}。她对这次行动的回应按铁律 13【心线与承诺】处理；心线有变就输出 @心线 行。`;
        }).join('\n')}`
        : '';
    const mustText = must.length
        ? must.join('、') + (rivalText ? `\n${rivalText}` : '')
        : (rivalText || '（上一轮所有角色都覆盖过了）');
    // 世界时间以正文为准（v2.3.16）：场景卡时间就是权威刻度
    const jumpText = (sceneInfo && sceneInfo.time)
        ? `正文当前时间：${sceneInfo.time}（权威基准 —— 世界时间必须推进到这一刻，所有新状态的时间段都从这一刻开始排）\n${jump}`
        : jump;
    const validText = validList(state, scene, timeSlotOn)
        .map((v) => `${v.name}（到 ${v.until}）`).join('、');

    const vars = buildVars(state, settings, chatText, worldinfo, jumpText, mustText, scene, validText);
    const systemPrompt = `${fillTemplate(getPrompt('update'), vars)}\n${UPDATE_OUTPUT_RULES}${opts.taskExtra ? `\n\n${opts.taskExtra}` : ''}`;
    const userPrompt = '请推演世界，只输出发生变化的行（+、~、-），最后用「## 小结」写一句这一轮你做了什么。';

    // 记下各路输入的真实长度，供面板「输入装配」显示 —— 让"我到底喂了什么"可见。
    // 注意：关掉某一路时记为 0，而不是 OFF_TEXT 的长度 —— 面板上"关掉的省了多少"
    // 才是用户想看的数字（OFF_TEXT 那句说明只有几十字，记进去会显得"关了没省"）。
    // 只有 worldinfo 例外：它走 buildWorldInfo 的短路返回 OFF_TEXT，
    // 面板估算会读到这个几十字的小值 —— 影响可忽略（相对通常几千字的条目）。
    state._feedStats = {
        prompt: systemPrompt.length,
        chat: chatText.length,
        state: feedOn(settings, 'state') ? serialize(state).length : 0,
        worldinfo: worldinfo.length,
        memory: feedOn(settings, 'memory') ? String(vars.memory || '').length : 0,
        scene: feedOn(settings, 'scene') ? String(vars.scene || '').length : 0,
        mustCover: feedOn(settings, 'mustCover') ? String(vars.mustCover || '').length : 0,
        notes: feedOn(settings, 'notes') ? String(vars.recentNotes || '').length : 0,
        at: new Date().toLocaleString('zh-CN'),
    };

    const t0 = Date.now();
    const raw = await callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]);
    const ms = Date.now() - t0;
    const text = cleanOutput(raw);

    const sp = splitSummary(text);
    const parsed = parseLines(sp.body);
    // 被丢弃的"疑似非协议行"（正文句子、分隔线、Markdown 混进输出）：记一笔，别静默
    if (parsed.dropped && parsed.dropped.length) {
        console.warn('[WorldEngine] 已忽略疑似非协议行：', parsed.dropped.slice(0, 5));
        pushLog(state, {
            type: 'parse-dropped',
            prompt: '（以下行不像协议行，已忽略，不会改动世界树）',
            response: parsed.dropped.slice(0, 20).join('\n'),
            ok: true,
        });
    }
    const ops = parsed.ops.filter((o) => o.path[0] !== vars.user);

    if (parsed.worldTime && oldTime && parsed.worldTime !== oldTime) {
        recordJump(state, oldTime, parsed.worldTime);
    }
    const res = applyParsed(state, { worldTime: parsed.worldTime, hide: parsed.hide, ops, bonds: parsed.bonds, commits: parsed.commits, rivals: parsed.rivals }, floor, lockFor(settings));
    // 攻防生态（v2.4.0）：对手出手记录刷新 + 失手升级 + 心线/承诺大事记
    maintainRivals(state, res, floor);
    recordBondCommitEvents(state, res, vars.user);
    syncSameName(state, settings.tracking.mergeSameName !== false);

    // 世界时间以正文为准（v2.3.16）：场景卡时间是权威刻度，模型没写 @time / 写慢了时向前校正
    if (sceneInfo && sceneInfo.time) syncWorldTime(state, sceneInfo.time);

    // 现场角色兜底登记（v2.3.16）：模型没写「现场记录」行时，至少把时间 / 地点登记上，
    // 保证"正文里刚出场的人"在世界里也有状态（不然她们看起来像被系统遗忘了）
    if (sceneInfo && scene.size) {
        const coveredNow = new Set([...(res.updated || []), ...(res.added || [])]);
        scene.forEach((name) => {
            if (coveredNow.has(name)) return;
            const n = Object.values(state.nodes).find((x) => x.name === name && !x.archived);
            if (!n) return;
            if (sceneInfo.hm) n.time = sceneInfo.hm;
            if (sceneInfo.location) n.location = sceneInfo.location;
            n.untilMin = null;    // 现场登记不设有效期：下一轮自然重新评估
            n.floor = floor;
            n.appearFloor = floor;   // 在正文里出场过 → 登记出场楼层（排序主键）
        });
    }

    // 首次补齐性格（v2.3.12）：父母/家人等分支角色的性格从空到有的那一刻，
    // 记进大事记让用户看得见——之后这些维度就永久锁死了
    if ((res.personaFilled || []).length) {
        pushEvent(state, {
            type: '补性格',
            name: '系统',
            text: `首次补齐 ${res.personaFilled.length} 个角色的性格：${res.personaFilled.join('、')}`,
        });
    }
    // 正文出场（v2.3.13）：现场角色自动翻交互
    if (sceneFlips.length) {
        pushEvent(state, {
            type: '出场',
            name: '系统',
            text: `正文出场，转为交互：${sceneFlips.join('、')}`,
        });
    }

    const covered = [...new Set([...(res.added || []), ...(res.updated || []), ...(res.archived || [])])];
    state.lastCovered = covered;

    let fillRaw = '';
    if (settings.tracking.autoFill) {
        const stillMissing = mustCoverNames(state, Number(settings.tracking.fillLimit) || 30, scene, timeSlotOn);
        // 门槛（v2.3.7）：只漏一两个人不值得再发一次请求 —— 补一轮的收益抵不上多花的那段时间。
        // 默认漏 3 人以上才补；可以在运行设置里调。
        const fillMin = Math.max(1, Number(settings.tracking.fillMinMissing) || 3);
        if (stillMissing.length >= fillMin && covered.length) {
            try {
                // 补全轮瘦身（v2.3.7）：只喂"点名清单 + 这些人的现有状态 + 上次小结"，
                // 不再重复喂正文 / 世界书 / 整棵树 —— 输入体积大幅下降，耗时跟着降。
                const fillVars = buildFillVars(state, settings, stillMissing, jump, scene);
                const fillPrompt = `${fillTemplate(getPrompt('update'), fillVars)}\n${fillTask(stillMissing)}\n${UPDATE_OUTPUT_RULES}`;
                fillRaw = cleanOutput(await callLLM([
                    { role: 'system', content: fillPrompt },
                    { role: 'user', content: '只补全上面点名的角色，只输出这些行。' },
                ]));
                const p2 = splitSummary(fillRaw);
                const parsed2 = parseLines(p2.body);
                const ops2 = parsed2.ops.filter((o) => o.path[0] !== vars.user);
                const res2 = applyParsed(state, { worldTime: '', hide: parsed2.hide || [], ops: ops2, bonds: parsed2.bonds, commits: parsed2.commits, rivals: parsed2.rivals }, floor, LOCK);
                // 补漏轮也可能带出心线 / 对手行动 —— 同样维护（escFloor 守卫防一轮双跳）
                maintainRivals(state, res2, floor);
                recordBondCommitEvents(state, res2, vars.user);
                state.lastCovered = [...new Set([...covered, ...(res2.added || []), ...(res2.updated || [])])];
                pushLog(state, { type: 'update-fill', prompt: fillPrompt, response: fillRaw, ok: true });
            } catch (e) {
                pushLog(state, { type: 'update-fill', prompt: '(补全失败)', response: '', ok: false, error: e.message });
            }
        }
    }

    diffAndRecord(state, beforeText, opts.reason || (opts.manual ? '手动更新' : 'AI 回复后自动演化'));
    applyCooldown(state, settings, floor);
    enforceCaps(state, settings);
    normalizeOrder(state);
    decayMindsets(state, floor);   // 近况回落（v2.4.0）

    // 工作小结：这一轮我干了什么
    const autoSummary = covered.length
        ? `本轮更新了 ${covered.length} 个角色（${covered.slice(0, 8).join('、')}${covered.length > 8 ? '…' : ''}）。`
        : '本轮世界无变化。';
    pushWorklog(state, opts.manual ? 'update-manual' : 'update-auto', sp.summary || autoSummary);

    if (settings.tracking.snapshots) pushSnapshot(state, floor, 10);
    pushLog(state, {
        type: opts.manual ? 'update-manual' : 'update-auto',
        prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        // 完整版：日志页的 prompt 会被截断到 14000 字（一次演化常两万字），
        // 这一份不截断，供「导出完整提示词」按钮用（pushLog 只保留最新一条完整版）。
        promptFull: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        response: text,
        responseFull: text,
        ms,
        ok: true,
    });
    commit(state);

    return { state, res, raw: text, fillRaw, prompt: systemPrompt, floor, ms, summary: sp.summary || autoSummary };
}

/* ---------------- 导入外部剧情记忆（小白X） ---------------- */

/**
 * 把外部剧情记忆整理进角色状态。
 * 小白X 记忆事件多时自动**分批**导入（每批 N 条，N=settings.memory.batchEvents），
 * 每批单独调一次 AI、增量应用，避免一次性塞爆 token 也更细致。
 * @param {string} memoryText 压缩后的记忆文本（或原始 JSON）
 * @param {{raw?:string, onProgress?:(s:string)=>void}} opts
 */
export async function applyMemory(memoryText, opts = {}) {
    const settings = getSettings();
    const state = getState();
    const text = String(memoryText || '').trim();
    if (!text) throw new Error('记忆内容是空的');
    if (!Object.keys(state.nodes || {}).length) {
        throw new Error('还没有世界状态。请先做完第 1、2 步建档，再导入记忆。');
    }
    const onProgress = opts.onProgress || (() => {});

    const parsed = parseLwb(text);
    const batchEvents = Math.max(0, Number(settings.memory.batchEvents) || 0);
    const useBatch = parsed.ok && batchEvents > 0 && parsed.events.length > batchEvents;

    // 存档用的"完整记忆文本"（之后每轮更新都会带）
    const fullText = parsed.ok
        ? compactLwb(parsed, { eventLimit: Number(settings.memory.eventLimit) || 0, momentCount: Number(settings.memory.momentCount) || 3, maxChars: Number(settings.memory.maxChars) || 0 })
        : text;

    const beforeText = serialize(state);
    const floor = getChatLength();
    let covered = [];
    let lastSummary = '';

    if (!useBatch) {
        onProgress('导入记忆…');
        const r = await memoryCallOnce(state, settings, text, '');
        covered = r.covered; lastSummary = r.summary;
    } else {
        const ctxText = compactContext(parsed, { momentCount: Number(settings.memory.momentCount) || 3 });
        const events = parsed.events;
        const batches = [];
        for (let i = 0; i < events.length; i += batchEvents) batches.push(events.slice(i, i + batchEvents));
        for (let i = 0; i < batches.length; i++) {
            onProgress(`导入记忆 ${i + 1}/${batches.length} 批（每批 ${batchEvents} 条事件）…`);
            const batchText = `${ctxText}\n${compactEvents(parsed, batches[i], { batchIndex: i + 1, batchCount: batches.length })}`;
            const r = await memoryCallOnce(state, settings, batchText, `（第 ${i + 1}/${batches.length} 批，只处理本批事件涉及的角色，其他角色不要动）`);
            covered.push(...r.covered);
            lastSummary = r.summary;
        }
    }

    const uniqCovered = [...new Set(covered)];
    state.memoryText = fullText;
    if (opts.raw !== undefined) state.memoryRaw = String(opts.raw || '');
    state.memoryAt = new Date().toLocaleString('zh-CN');
    state.lastCovered = uniqCovered;

    diffAndRecord(state, beforeText, '导入外部剧情记忆');
    applyCooldown(state, settings, floor);
    enforceCaps(state, settings);
    normalizeOrder(state);

    const autoSummary = uniqCovered.length
        ? `导入外部剧情记忆${useBatch ? `（分 ${Math.ceil(parsed.events.length / batchEvents)} 批）` : ''}，校正了 ${uniqCovered.length} 个角色（${uniqCovered.slice(0, 8).join('、')}${uniqCovered.length > 8 ? '…' : ''}）。`
        : '导入外部剧情记忆，但模型没有输出需要修正的角色。';
    pushWorklog(state, 'memory', lastSummary || autoSummary);
    pushEvent(state, { type: '记忆', name: '系统', text: `导入外部剧情记忆：校正 ${uniqCovered.length} 个角色${useBatch ? '（分批）' : ''}` });
    if (settings.tracking.snapshots) pushSnapshot(state, floor, 10);
    commit(state);

    return { state, covered: uniqCovered, summary: lastSummary || autoSummary, batched: useBatch };
}

/** 单次记忆调用：组装提示词 → 调模型 → 增量应用 */
async function memoryCallOnce(state, settings, memoryText, batchLabel) {
    const floor = getChatLength();
    const oldTime = state.worldTime;
    const msgs = getRecentChat(settings.tracking.updateDepth);
    const chatText = formatChat(msgs, Math.max(0, floor - msgs.length)) || '（暂无聊天内容）';
    const worldinfo = await buildWorldInfo(state, settings, activeNames(state));
    const jump = oldTime
        ? describeJump(oldTime, '（以记忆里的时间点为准）')
        : '（尚无上次世界时间，请以记忆里的时间点为准）';
    const scene = settings.tracking.sceneGuard === false
        ? new Set()
        : sceneNames(state, { text: sceneTextOf(settings) });
    const sceneFlips = markSceneInteraction(state, scene, floor);
    // 记忆校正不受「状态有效期」限制：这是按既定事实整体覆盖，不是常规轮次推演
    const must = mustCoverNames(state, 60, scene, false);
    const mustText = must.length ? must.join('、') : '（上一轮所有角色都覆盖过了）';

    const vars = buildVars(state, settings, chatText, worldinfo, jump, mustText, scene,
        '（本次是按外部剧情记忆整体校正，不受状态有效期限制）');
    const systemPrompt = `${fillTemplate(getPrompt('update'), vars)}\n${MEMORY_TASK}\n${UPDATE_OUTPUT_RULES}`;
    const userPrompt = `请依据上面的外部剧情记忆${batchLabel}，输出需要校正的角色行（+、~、-），最后用「## 小结」写一句这一轮你做了什么。`;

    const t0 = Date.now();
    const raw = await callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]);
    const ms = Date.now() - t0;
    const out = cleanOutput(raw);

    const sp = splitSummary(out);
    const parsed = parseLines(sp.body);
    const ops = parsed.ops.filter((o) => o.path[0] !== vars.user);
    if (parsed.worldTime && oldTime && parsed.worldTime !== oldTime) recordJump(state, oldTime, parsed.worldTime);
    const res = applyParsed(state, { worldTime: parsed.worldTime, hide: parsed.hide, ops }, floor, lockFor(settings));
    syncSameName(state, settings.tracking.mergeSameName !== false);

    // 首次补齐性格（v2.3.12）：父母/家人等分支角色的性格从空到有的那一刻，
    // 记进大事记让用户看得见——之后这些维度就永久锁死了
    if ((res.personaFilled || []).length) {
        pushEvent(state, {
            type: '补性格',
            name: '系统',
            text: `首次补齐 ${res.personaFilled.length} 个角色的性格：${res.personaFilled.join('、')}`,
        });
    }
    // 正文出场（v2.3.13）：现场角色自动翻交互
    if (sceneFlips.length) {
        pushEvent(state, {
            type: '出场',
            name: '系统',
            text: `正文出场，转为交互：${sceneFlips.join('、')}`,
        });
    }
    pushLog(state, { type: 'memory-import', prompt: systemPrompt + (batchLabel ? `\n${batchLabel}` : ''), response: out, ms, ok: true });

    const covered = [...new Set([...(res.added || []), ...(res.updated || []), ...(res.archived || [])])];
    return { covered, summary: sp.summary };
}
