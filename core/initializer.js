/**
 * 世界建档：三步
 *
 *   第 1 步 buildRoster()       —— 只读「人物速览」，把卡里有什么人认出来 + 定主基调性格
 *                                  平铺一行一人，不建关系树，不写任何状态
 *   第 2 步 organizeBatch()     —— 用户挑 2~3 个角色 → 只带她们各自的世界书条目 → 整理
 *                                  （补性格 / 建关系 / 写工作小结）→ 存成草稿，可重复多批
 *         finalizeOrganize()   —— 全部批次整理完 → 汇总审一遍找矛盾 → 定稿 → 清空草稿
 *   第 3 步 updateWorld()       —— 见 core/updater.js：载入近期剧情，更新角色状态
 *
 *   一键 initializeWorld()      —— 上面两步自动连跑（第 3 步需要剧情，不自动跑）
 */
import { callLLM } from '../api/llm.js';
import { getSettings } from '../config.js';
import { getNames } from './st.js';
import {
    loadWorldBook, selectedEntries, selectionMade, overviewText, entriesForNames, entriesToText,
    getCharacterCardText, clearWorldBookCache, getWorldBookName, allEntryNames,
} from './worldbook.js';
import { getRecentChat, formatChat, getChatLength } from './chat.js';
import {
    getState, commit, pushLog, clearState, pushEvent, pushWorklog, addDraft, clearDrafts,
} from './state.js';
import {
    parseLines, applyParsed, serializeSubset, topNodes, topNames, serialize, syncSameName, splitSummary,
} from './protocol.js';
import { fallbackInit, enforceCaps, normalizeOrder } from './categories.js';
import { pushSnapshot } from './snapshot.js';
import { recordJump } from './timeline.js';
import { fillTemplate, getPrompt, cleanOutput, fenceData } from './template.js';
import { FINALIZE_ORGANIZE_TASK, PERSONA_ONLY_TASK } from '../prompts/organizePrompt.js';

/** 需要时才存快照（回退已经默认关闭） */
function maybeSnapshot(state, floor, settings) {
    if (!settings.tracking.snapshots) return;
    pushSnapshot(state, floor, 10);
}

/**
 * 建档阶段的锁：
 *
 *   freezeTop: true  —— **名单在第 1 步就定死了**。用户的原话是
 *     "第一条目决定这个能录入多少角色，第二条目来调整世界树"。
 *     所以第 2 步整理只应该给已有的人连线、补性格，绝不能往里加新角色。
 *     任何认不出的新顶层名一律进待审名单，由用户决定要不要建档。
 *
 *   lockPersona: false —— 第 2 步的主要产出**就是**性格（第 1 步只有速览，定不了性格），
 *     所以这一步必须允许写性格，不能锁。
 *
 *   createSub: false —— 连带把"资料里挖出来的新人"也挡掉：
 *     模型在第 2 步很容易从世界书条目里挖出一堆没戏份的亲戚。
 *     只允许在**已有角色**下面挂新的子分支（那是有意义的家人/关系人）。
 */
const INIT_LOCK = { lockPersona: false, freezeTop: true, freezeNewSub: true };

/** 建档阶段也要尊重用户对"重复挂载"的偏好；anchors = 本批锚点（保护她们不被搬家吃掉） */
function initLockFor(settings, anchors) {
    const merge = settings && settings.tracking && settings.tracking.mergeDuplicates !== false;
    const base = merge ? INIT_LOCK : { ...INIT_LOCK, keepDuplicates: true };
    return anchors && anchors.length ? { ...base, batchAnchors: anchors } : base;
}

/**
 * 「只补性格」模式的解析兜底（v2.3.15）：
 * 模型如果省掉了【】标记（写成"名字 ｜ 性格：…"），整行会因为"不像路径"被解析门槛丢掉。
 * 这里给它补一个【补性格】标记 —— 该标记不代表类别，应用时会被 personaOnly 模式忽略。
 */
function normalizePersonaBody(body) {
    return String(body || '').split(/\r?\n/).map((ln) => {
        const t = ln.trim();
        if (!t || t.startsWith('@') || t.startsWith('#') || /[【\[]/.test(t)) return ln;
        if (!/[｜|]/.test(t)) return ln;
        const head = t.split(/[｜|]/)[0].trim();
        if (!head || head.length > 16 || /[，。！？；：、]/.test(head)) return ln;
        return `${head} 【补性格】 ${t.replace(head, '').trim()}`;
    }).join('\n');
}

/** 调一次模型：提示词 + 可选任务块 */
async function callStage(kind, vars, taskExtra, label) {
    const base = getPrompt(kind);
    const full = taskExtra ? `${base}\n\n${taskExtra}` : base;
    const text = fillTemplate(full, vars);
    const messages = [{ role: 'user', content: text }];
    const t0 = Date.now();
    const raw = await callLLM(messages);
    return { label, prompt: text, raw: cleanOutput(raw), ms: Date.now() - t0 };
}

/* ---------------- 世界书上下文 ---------------- */

/**
 * 收集世界书上下文
 * @param {string[]} names 只取这些角色的详细条目（空 = 不取详细条目）
 * @param {{includeNsfw?:boolean, dropOverview?:boolean, onlyEntries?:boolean}} opts
 *        onlyEntries=true 时 worldinfo 里**只有条目正文**（第 2 步整理要的效果）
 */
export async function gatherWorldInfo(names = [], opts = {}) {
    const s = getSettings();
    const card = getCharacterCardText();
    if (!s.worldbook.enabled) {
        return { worldinfo: card || '（世界书已关闭）', stats: null };
    }
    clearWorldBookCache();
    const entries = await loadWorldBook(true, s.worldbook.name);
    const usable = selectedEntries(entries);

    if (selectionMade() && !usable.length) {
        return {
            worldinfo: opts.onlyEntries
                ? '（你在条目页一条都没勾，本次没有世界书内容可用）'
                : [card, '（你选择了不使用任何世界书条目，请只依据聊天内容与角色卡来判断）'].filter(Boolean).join('\n\n'),
            stats: { total: entries.length, usable: 0, overview: 0, detail: 0, chars: 0, name: getWorldBookName(), allNames: [] },
        };
    }

    const ov = opts.dropOverview ? '' : overviewText(usable);
    let detailEntries = [];
    if (names.length) {
        if (Array.isArray(opts.entryUids)) {
            // 用户在「整理」这一步手动挑过条目：严格按清单来（空数组 = 这批一条都不带）
            const set = new Set(opts.entryUids);
            detailEntries = usable.filter((e) => set.has(e.uid));
        } else {
            detailEntries = entriesForNames(usable, names, { includeNsfw: !!opts.includeNsfw });
            // 名字对不上条目时（标题写法不一致），退化成"全部可用条目"，免得整批没有素材
            if (!detailEntries.length) {
                detailEntries = usable.filter((e) => opts.includeNsfw || !e.isNsfw);
            }
        }
    }
    const detail = entriesToText(detailEntries, s.worldbook.maxChars);

    let worldinfo;
    if (opts.onlyEntries) {
        worldinfo = detail || '（没找到这几个角色的专门条目，请结合速览与角色卡整理）';
    } else {
        worldinfo = [card, ov && `【人物速览】\n${ov}`, detail && `【角色详细设定】\n${detail}`]
            .filter(Boolean).join('\n\n') || '（没读到世界书，请只依据聊天内容）';
    }

    return {
        worldinfo,
        stats: {
            total: entries.length,
            usable: usable.length,
            overview: usable.filter((e) => e.isOverview).length,
            detail: detailEntries.length,
            chars: worldinfo.length,
            name: getWorldBookName(),
            allNames: allEntryNames(usable),
        },
    };
}

/* ---------------- 第 1 步：认人 + 定性格 ---------------- */

export async function buildRoster(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const settings = getSettings();
    const state = getState();
    const floor = getChatLength();

    onProgress('读取人物速览');
    const { worldinfo, stats } = await gatherWorldInfo([], {});
    const { user, char } = getNames();
    const msgs = getRecentChat(settings.tracking.initDepth);
    const chatText = formatChat(msgs, Math.max(0, floor - msgs.length)) || '（暂无聊天内容）';

    const vars = { chat: fenceData(chatText), state: '（空，正在建档）', worldinfo: fenceData(worldinfo), user, char };
    onProgress('识别人物 + 定性格');
    const r = await callStage('roster', vars, '', 'init-roster');
    if (!r.raw) throw new Error('模型没有返回角色表，请检查 API 与日志');

    const { body, summary } = splitSummary(r.raw);
    const parsed = parseLines(body);
    const ops = parsed.ops.filter((o) => o.path[0] !== user);

    // 第 1 步是唯一"可以往名单里加人"的环节 —— 这里不设 freezeTop
    applyParsed(state, { worldTime: parsed.worldTime || state.worldTime, hide: parsed.hide, ops }, floor);
    syncSameName(state, settings.tracking.mergeSameName !== false);

    // 第 1 步只是"认人 + 定性格"：代码强制清掉状态字段，全部归到【未出场】
    // （已整理过的角色不动，避免重跑第 1 步把已有内容洗掉）
    const builtNames = new Set(state.built || []);
    let forced = 0;
    Object.values(state.nodes).forEach((n) => {
        if (builtNames.has(n.name)) return;
        if (n.time || n.location || n.mood || n.goal) forced++;
        n.time = '';
        n.location = '';
        n.mood = '';
        n.goal = '';
        n.category = 'unseen';
        n.floor = 0;
    });

    state.phase = 'roster';
    if (!Array.isArray(state.built)) state.built = [];
    const tops = topNodes(state);

    pushEvent(state, {
        type: '建档',
        name: '系统',
        text: `第 1 步完成：卡里共识别出 ${tops.length} 个角色（${Object.keys(state.nodes).length} 个节点），全部标为未出场${forced ? `（已清掉 ${forced} 个状态字段）` : ''}。性格与关系网留到第 2 步整理。`,
    });
    pushWorklog(state, 'roster',
        summary || `第 1 步：认人。列了一张花名册，共 ${tops.length} 个主角色（总共 ${Object.keys(state.nodes).length} 个节点），全部标未出场——还没建关系、没写状态、没定性格。`);
    pushLog(state, { type: 'init-roster', prompt: r.prompt, response: r.raw, ms: r.ms, ok: true });
    // 被解析层丢弃的行要可见：模型若仍输出「男朋友」「老板娘」这种纯代号行，
    // 这里能让用户在日志里看到（v2.3.9），而不是静默少人
    if (parsed.dropped && parsed.dropped.length) {
        pushLog(state, {
            type: 'parse-dropped',
            prompt: '第 1 步有以下行未被采用（多为纯关系/职业代号或格式不像花名册行）。资料里没给名字的真人，应要求模型先起正式名字再建档。',
            response: parsed.dropped.slice(0, 30).join('\n'),
            ok: true,
        });
    }
    maybeSnapshot(state, floor, settings);
    commit(state);
    return { state, raw: r.raw, stats };
}

/* ---------------- 第 2 步：分批整理 ---------------- */

/**
 * 整理一批角色：只带她们各自的世界书条目，产出「性格补全 + 关系网 + 工作小结」，
 * 结果存成草稿（不直接当最终结果）。
 */
export async function organizeBatch(names, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const settings = getSettings();
    const state = getState();
    const list = (names || []).filter(Boolean);
    if (!list.length) throw new Error('请先勾选要整理的角色');

    const floor = getChatLength();
    const oldTime = state.worldTime;
    const includeNsfw = opts.includeNsfw !== undefined ? !!opts.includeNsfw : !!settings.worldbook.includeNsfw;
    const personaOnly = !!opts.personaOnly;   // 只补性格模式（v2.3.15）：只填空位性格，其余一律不碰

    onProgress(`取 ${list.join('、')} 的世界书条目`);
    const { worldinfo, stats } = await gatherWorldInfo(list, {
        includeNsfw,
        onlyEntries: true,
        dropOverview: true,
        // 用户在「整理」这一步手动挑过条目时，严格按他的清单来；没挑过就按名字自动匹配
        entryUids: Array.isArray(opts.entryUids) ? opts.entryUids : undefined,
    });

    const { user, char } = getNames();
    const notes = (state.drafts || []).map((d) => `【已整理：${(d.batch || []).join('、')}】\n${d.notes || '（没写小结）'}`).join('\n\n')
        || '（这是第一批，之前没有整理过任何人）';
    // v2.3.13：把花名册全员附在后面 —— 只给本批的子集时，模型看不见名单里的其他人，
    // 会给已存在的人起新名字（实测：继母刘芳已在册，模型又造了个"继母李芳"）。
    const roster = topNames(state);
    const rosterHint = roster.length
        ? `\n\n【花名册全员（第 1 步定死的名单，一个都不能多、一个都不能少）】\n${roster.join('、')}\n——挂关系时只能从这份名单里连人：名单里已有的人（不管她现在挂在哪）必须用原名挂行；只有名单外的全新真实人物才需要起名。`
        : '';
    const subset = (serializeSubset(state, list) || '（这几个角色还没有骨架）') + rosterHint;

    const vars = { worldinfo: fenceData(worldinfo), batch: list.join('、'), notes, state: subset, user, char };
    onProgress(`整理 ${list.length} 个角色`);
    const r = await callStage('organize', vars, personaOnly ? PERSONA_ONLY_TASK : '', 'init-organize');
    if (!r.raw) throw new Error('模型没有返回内容，请检查 API 与日志');

    const { body, summary } = splitSummary(r.raw);
    const parsed = parseLines(personaOnly ? normalizePersonaBody(body) : body);
    const ops = parsed.ops.filter((o) => o.path[0] !== user);
    if (!personaOnly && parsed.worldTime && oldTime && parsed.worldTime !== oldTime) recordJump(state, oldTime, parsed.worldTime);
    // 第 2 步整理：名单已由第 1 步定死 → freezeTop 挡新顶层、freezeNewSub 挡乱挖亲戚
    // batchAnchors = 本批锚点：倒挂保护只保护她们，其余花名册顶层允许被搬家成树枝
    // personaOnly = 只补性格：只填性格空位，类别/状态/关系/挂载/世界时间一律不动（v2.3.15）
    const lockOpts = initLockFor(settings, list);
    if (personaOnly) lockOpts.personaOnly = true;
    const r2 = applyParsed(state, { worldTime: personaOnly ? '' : (parsed.worldTime || state.worldTime), hide: personaOnly ? [] : parsed.hide, ops }, floor, lockOpts);
    if (!personaOnly) syncSameName(state, settings.tracking.mergeSameName !== false);

    state.built = Array.isArray(state.built) ? state.built : [];
    list.forEach((n) => {
        const node = Object.values(state.nodes).find((x) => !x.parent && x.name === n)
            || Object.values(state.nodes).find((x) => x.name === n);
        if (node && !state.built.includes(n)) state.built.push(n);
    });

    // 草稿：这一批整理了什么（下一批会把它带进去比对冲突）
    const draft = addDraft(state, list, summary || `整理了 ${list.join('、')}（模型没写小结）`, body);

    state.phase = state.phase === 'running' ? 'running' : 'organizing';
    normalizeOrder(state);
    if (!personaOnly) enforceCaps(state, settings);   // 只补性格不做类别预算调整
    const blocked = (r2.pending || []).slice();
    pushEvent(state, {
        type: '整理',
        name: list.join('、'),
        text: `第 2 步：整理 ${list.join('、')}${personaOnly ? '（只补性格）' : ''}（累计 ${state.built.length}/${topNodes(state).length}）`
            + ((r2.reparented || []).length ? ` ｜ ${(r2.reparented).length} 人挂进关系网（${r2.reparented.slice(0, 5).join('、')}）` : '')
            + (blocked.length ? ` ｜ 拦下 ${blocked.length} 个名单外的新角色（等你在「世界状态」页裁决）` : ''),
    });
    pushWorklog(state, 'organize',
        (summary || `第 2 步：整理了 ${list.join('、')} 的性格与关系。`)
        + (blocked.length ? `（名单外的新角色 ${blocked.slice(0, 6).join('、')} 未建档，已转待审）` : ''));
    pushLog(state, { type: 'init-organize', prompt: r.prompt, response: r.raw, ms: r.ms, ok: true });
    maybeSnapshot(state, floor, settings);
    commit(state);
    return { state, raw: r.raw, stats, draft, pending: blocked };
}

/** 编辑 / 删除草稿后重新落盘（面板用） */
export function touchState() {
    const state = getState();
    commit(state);
    return state;
}

/* ---------------- 第 2 步收尾：汇总定稿 ---------------- */

export async function finalizeOrganize(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const settings = getSettings();
    const state = getState();
    const floor = getChatLength();
    const drafts = state.drafts || [];

    let summary = '';
    let raw = '';
    if (drafts.length) {
        onProgress('汇总所有整理草稿，检查冲突');
        try {
            const { worldinfo } = await gatherWorldInfo([], { includeNsfw: !!settings.worldbook.includeNsfw });
            const { user, char } = getNames();
            const vars = {
                state: serialize(state),
                worldinfo: fenceData(worldinfo),
                drafts: drafts.map((d, i) => `【第 ${i + 1} 批：${(d.batch || []).join('、')}】\n${d.raw || d.notes || ''}`).join('\n\n'),
                batch: '（收尾阶段，不再单独整理某一批）',
                notes: '（见下方草稿）',
                user, char,
            };
            const r = await callStage('organize', vars, FINALIZE_ORGANIZE_TASK, 'organize-final');
            raw = r.raw;
            if (raw) {
                const sp = splitSummary(raw);
                summary = sp.summary;
                const parsed = parseLines(sp.body);
                const ops = parsed.ops.filter((o) => o.path[0] !== user);
                // 收尾同样冻结名单：只许删人 / 合并人 / 补性格，不许加人
                applyParsed(state, { worldTime: parsed.worldTime || state.worldTime, hide: parsed.hide, ops }, floor, initLockFor(settings));
                syncSameName(state, settings.tracking.mergeSameName !== false);
                pushLog(state, { type: 'organize-final', prompt: r.prompt, response: raw, ms: r.ms, ok: true });
            }
        } catch (e) {
            pushLog(state, { type: 'organize-final', prompt: '（汇总调用失败）', response: '', ok: false, error: e.message });
            pushEvent(state, { type: '失败', name: '系统', text: `整理收尾失败：${e.message}。草稿已保留，可重试。` });
            commit(state);
            throw e;   // 失败就抛出去，不往下走"清草稿 + phase=running"
        }
    } else {
        onProgress('没有草稿，直接收尾');
    }

    clearDrafts(state);   // 定稿后删掉全部草稿
    fallbackInit(state, '', settings);
    enforceCaps(state, settings);
    normalizeOrder(state);
    state.phase = 'running';

    const counts = { interaction: 0, cooldown: 0, unseen: 0 };
    Object.values(state.nodes).forEach((n) => { if (!n.parent) counts[n.category] = (counts[n.category] || 0) + 1; });
    const withPersona = Object.values(state.nodes).filter((n) => n.persona && Object.keys(n.persona).length).length;

    pushEvent(state, {
        type: '建立',
        name: '系统',
        text: `初始化完成，世界开始运行：${Object.keys(state.nodes).length} 个角色（${withPersona} 个有主基调性格），三档 交互 ${counts.interaction} / 冷却 ${counts.cooldown} / 未出场 ${counts.unseen}`,
    });
    pushWorklog(state, 'organize-final',
        summary || `整理收尾：汇总了 ${drafts.length} 批草稿，定稿共 ${Object.keys(state.nodes).length} 个角色。初始化完成，之后可以载入剧情开始更新状态了。`);
    maybeSnapshot(state, floor, settings);
    commit(state);
    return { state, raw, summary, draftCount: drafts.length };
}

/* ---------------- 一键：自动连跑（不含第 3 步） ---------------- */

export async function initializeWorld(opts = {}) {
    const { rebuild = false, onProgress = () => {} } = opts;
    const settings = getSettings();
    if (rebuild) {
        const old = getState();
        const keepHidden = (old.hidden || []).slice();
        clearState();
        const fresh = getState();
        fresh.hidden = keepHidden;
        commit(fresh);
    }
    await buildRoster({ onProgress });
    const state = getState();
    const names = topNodes(state).map((n) => n.name);
    const size = Math.max(1, Number(settings.tracking.batchSize) || 3);
    const batches = Math.ceil(names.length / size);
    for (let i = 0; i < names.length; i += size) {
        const batch = names.slice(i, i + size);
        onProgress(`整理 ${Math.floor(i / size) + 1}/${batches}：${batch.join('、')}`);
        try {
            await organizeBatch(batch, { onProgress });
        } catch (e) {
            console.error('[WorldEngine] 批次整理失败', batch, e);
        }
    }
    await finalizeOrganize({ onProgress });
    return getState();
}

/* ---------------- 自检 ---------------- */

export async function probeWorldBook() {
    clearWorldBookCache();
    const entries = await loadWorldBook(true);
    const usable = selectedEntries(entries);
    return {
        name: getWorldBookName(),
        total: entries.length,
        usable: usable.length,
        chars: usable.reduce((a, e) => a + e.length, 0),
        overview: usable.filter((e) => e.isOverview).map((e) => e.title),
        names: allEntryNames(usable),
        preview: entriesToText(usable.slice(0, 3), 800),
    };
}
