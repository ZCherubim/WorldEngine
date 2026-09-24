/**
 * 世界状态协议（行文本）
 *
 *   @time 星期四 18:00
 *   @hide 苏晴、王雪
 *   苏晴 【交互】 14:00-16:00 咖啡厅 小李约她喝咖啡，因未婚夫长期缺席而动摇 / 心情：开心被关注 / 目标：寻找陪伴
 *   苏晴 > 李浩 【冷却】 19:00-23:00 公司加班，三天未联系苏晴 / 心情：疲惫
 *   苏晴 > 母亲 【冷却】 在家，催促苏晴和未婚夫见面
 *
 * 增量操作符（更新时使用，可省略，默认 ~）：
 *   + 新增   ~ 更新   - 归档
 *
 * v2.4.0 攻防生态（@ 行，序列化原样往返）：
 *   @心线 苏晴→{{user}} 好感→心动（依据：{{user}}陪她聊到凌晨）   心线七档：反感/戒备/陌生/好感/心动/倾心/挚爱
 *   @承诺 +苏晴 「不再私下见金主」生效 ／ ~苏晴 已违背「…」 ／ -苏晴 已解除「…」
 *   @对手 金主赵海 手段2/6 · 上次出手第43层：约饭被婉拒          （系统维护，模型不输出）
 */
import { getNames } from './st.js';

export const CATEGORY_ALIAS = {
    // v2.3.18：攻防档已删除。这里**保留**「攻防 / 进攻 / 攻略」等别名并映射到 interaction，
    // 否则模型按旧习惯写出「【攻防】」的行会被当成无法识别的类别整行丢掉 —— 那是丢数据。
    // 删档是删"档位"，不是删"这个词的解析"，两件事必须分开。
    '攻防': 'interaction', '进攻': 'interaction', '攻略': 'interaction', 'attack': 'interaction',
    'ad': 'interaction', 'attack_defense': 'interaction',
    '交互': 'interaction', 'interaction': 'interaction', 'interact': 'interaction',
    '冷却': 'cooldown', 'cooldown': 'cooldown', 'cold': 'cooldown',
    '未出场': 'unseen', '未登场': 'unseen', 'unseen': 'unseen',
};
export const CATEGORY_LABEL = { interaction: '交互', cooldown: '冷却', unseen: '未出场' };
export const CATEGORY_ORDER = ['interaction', 'cooldown', 'unseen'];

export function normalizeCategory(raw) {
    if (!raw) return '';
    const k = String(raw).trim().toLowerCase();
    if (CATEGORY_ALIAS[k]) return CATEGORY_ALIAS[k];
    for (const key of Object.keys(CATEGORY_ALIAS)) {
        if (k.includes(key)) return CATEGORY_ALIAS[key];
    }
    return '';
}

export function emptyState() {
    return {
        version: 2,
        phase: 'empty', // empty | roster | organizing | characters | running
        worldTime: '',
        timeline: [],   // 最近 10 次时间跳跃
        nodes: {},      // id -> node
        order: [],      // 顶层（女主）顺序
        hidden: [],     // 被隐藏的名字
        archived: [],   // 已归档的名字
        built: [],      // 已完成整理的角色名（第 2 步逐批整理）
        lastCovered: [], // 上一轮更新里出现过的角色名（用于补全漏掉的）
        pending: [],    // 待审提案：演化阶段模型提到的新顶层角色，等用户批准建档
        drafts: [],     // 第 2 步的整理草稿 [{id, batch, notes, raw, at}]
        worklogs: [],   // 工作小结（"这一轮我干了什么"），最近 50 条
        memoryText: '', // 外部剧情记忆（小白X）压缩后的文本
        memoryRaw: '',  // 外部剧情记忆原始 JSON
        memoryAt: '',   // 导入时间
        events: [],     // 大事记，最近 30 条
        commitments: [], // v2.4.0 承诺：[{id, who, text, status: active|broken|released, since, at}]
        logs: [],       // 调试日志，最近 10 条
        snapshots: [],  // 快照（默认不再生成）
        seq: 0,
        updatedAt: '',
    };
}

export function makeId(path) { return path.join('>'); }

// 时间：支持 "14:00-16:00" 这种区间，也支持单独一个 "19:30"
const TIME_RE = /^(\d{1,2}:\d{2}(?:\s*[~\-—－至到]\s*\d{1,2}:\d{2})?)/;
const FIELD_RE = /^(时间|时间段|位置|地点|活动|状态|心情|目标|近况)[：:]\s*([\s\S]*)$/;
const LOCATION_RE = /^(?:在)?([\u4e00-\u9fa5A-Za-z0-9]{1,8}(?:咖啡厅|咖啡店|公司|学校|教室|办公室|家中|家|公寓|宿舍|餐厅|食堂|图书馆|商场|超市|酒店|酒吧|公园|医院|车站|车上|车内|会议室|路上|街上|卧室|客厅|厨房|工作室|店铺|店里|会所|健身房|影院|电影院|机场|宿舍楼|教学楼|实验室|工厂|银行))/;

/* ---------------- 性格（主基调）：永远不变的内核 ---------------- */

/** 中文键 → 内部键 */
const PERSONA_KEY_MAP = {
    '性格': 'tags', '标签': 'tags', '性格标签': 'tags', '主基调': 'tags', '性格主基调': 'tags',
    '底色': 'base', '人物底色': 'base', '背景': 'base', '出身': 'base',
    '软肋': 'weak', '弱点': 'weak', '最怕': 'weak',
    '说话': 'speech', '说话方式': 'speech', '口癖': 'speech', '语气': 'speech',
    '行为': 'behavior', '行为方式': 'behavior', '习惯': 'behavior',
    // v2.3.27：手动建档带来的可选维度（老节点没有这些键，显示和锁定逻辑都自动跳过）
    '性别': 'gender', '容貌': 'looks', '长相': 'looks', '外貌': 'looks',
    '备注': 'notes', '其他': 'notes',
};
const PERSONA_KEYS_RE = Object.keys(PERSONA_KEY_MAP).sort((a, b) => b.length - a.length).join('|');
const PERSONA_RE = new RegExp(`^(${PERSONA_KEYS_RE})[：:]\\s*([\\s\\S]*)$`);

/** 内部键 → 中文标签（顺序固定） */
export const PERSONA_LABEL = { tags: '性格', base: '底色', weak: '软肋', speech: '说话', behavior: '行为', gender: '性别', looks: '容貌', notes: '备注' };
export const PERSONA_ORDER = ['tags', 'base', 'weak', 'speech', 'behavior', 'gender', 'looks', 'notes'];

/** 把一行文字里的性格段剥出来 */
function takePersona(seg, persona) {
    const m = seg.match(PERSONA_RE);
    if (!m) return false;
    const key = PERSONA_KEY_MAP[m[1]];
    const val = m[2].trim();
    if (!key || !val) return true;
    if (key === 'tags' && /[；;]/.test(val)) {
        // 兼容"性格：标签；底色；软肋；说话；行为"这种一行五格写法
        const parts = val.split(/[；;]/).map((s) => s.trim());
        PERSONA_ORDER.forEach((k, i) => { if (parts[i]) persona[k] = parts[i]; });
        return true;
    }
    persona[key] = val;
    return true;
}

export function hasPersona(node) {
    const p = node && node.persona;
    if (!p) return false;
    return PERSONA_ORDER.some((k) => p[k]);
}

/** 性格段文本（固定顺序，用 ｜ 连接） */
export function personaLine(node) {
    const p = (node && node.persona) || {};
    const parts = [];
    PERSONA_ORDER.forEach((k) => { if (p[k]) parts.push(`${PERSONA_LABEL[k]}：${p[k]}`); });
    return parts.join(' ｜ ');
}

/* ---------------- 攻防生态（v2.4.0）：心线 / 承诺 / 对手档案 ----------------
 * 用户的玩法核心是「攻防」：对手（金主 / 追求者 / 未婚夫）要真实出手攻略，
 * {{user}} 也要真实防守。裁判是两样新东西：
 *   · 心线（node.bonds）：她对每个重要对象的倾心档位，七档制；
 *   · 承诺（state.commitments）：正文里说出口的保证，违背有代价。
 * {{user}} 永不进世界树 —— 心线是她的属性，key 用 '{{user}}' 字面量；
 * 模型看到的是 fillTemplate 替换后的真名，bondKey() 负责把真名归一回 '{{user}}'。
 */

/** 心线七档：反感 < 戒备 < 陌生 < 好感 < 心动 < 倾心 < 挚爱（负面档必须有 —— 被讨厌也是剧情） */
export const BOND_TIERS = ['反感', '戒备', '陌生', '好感', '心动', '倾心', '挚爱'];

export function bondTierIndex(name) { return BOND_TIERS.indexOf(String(name || '').trim()); }

/** 对手手段等级（升级阶梯）：低手段失手 → 系统自动升一级 */
export const RIVAL_LEVELS = ['红包转账', '约饭陪伴', '送礼讨好', '施压查岗', '摊牌谈判', '强硬手段'];

/** 对手识别：挂在女主下面的关系线主动方（子分支 + 关系词） */
export const RIVAL_RE = /追求者|追求|金主|未婚夫|未婚妻|男友|情人|暧昧|暗恋|炮友|前男友|丈夫|老公/;

export function isRivalNode(n) {
    return !!(n && n.parent && RIVAL_RE.test(String(n.name || '')));
}

export function rivalNodes(state) {
    return Object.values(state.nodes || {}).filter(
        (n) => !n.archived && isRivalNode(n) && !(state.hidden || []).includes(n.name),
    );
}

/**
 * 停滞的攻防线：距上次出手超过 N 层（或超过 N 世界分钟）的对手。
 * v2.4.0 重写 —— 旧 pushCandidates 只挑「冷却档的顶层女主」且排除现场，
 * 结果金主从不出手（这是"攻防玩不起来"的主因之一）；现在按**关系线本身**算停滞，
 * 交互 / 现场角色身上的关系线一样会被点名（电话和消息可以打进现场）。
 */
export function staleRivals(state, floor = 0, gapFloors = 3, gapMin = 360, scene = null) {
    const out = [];
    rivalNodes(state).forEach((n) => {
        if (scene && scene.has(n.name)) return;   // 他本人正在正文里演：已经在出手了
        const woman = state.nodes[n.parent];
        if (!woman || woman.archived) return;
        const r = n.rival || {};
        const lastFloor = r.lastFloor || n.floor || 0;
        const floorsSince = Math.max(0, (floor || 0) - lastFloor);
        let minSince = null;
        if (state.worldMinutes != null && r.lastMin != null) minSince = state.worldMinutes - r.lastMin;
        if (floorsSince < gapFloors && (minSince == null || minSince < gapMin)) return;
        out.push({ woman: woman.name, rival: n, floorsSince, minSince });
    });
    out.sort((a, b) => ((b.floorsSince || 0) - (a.floorsSince || 0)) || ((b.minSince || 0) - (a.minSince || 0)));
    return out;
}

/** 名字归一：路径取末段 + 清洗 + 用户真名 → '{{user}}' 字面量 */
function bondKey(raw, userName) {
    let s = String(raw || '').trim();
    if (s.includes('>')) s = s.split('>').pop().trim();
    s = cleanName(s);
    if (!s) return '';
    if (s === '{{user}}' || s === '{{User}}' || (userName && s === userName)) return '{{user}}';
    return s;
}

/** @心线 行 → { who, target, from, to, note }；认不出档位返回 null */
function parseBondLine(val) {
    const m = String(val || '').match(
        /^([^→]+?)→(\S+?)\s+([^（\s]+?)(?:\s*[→\-—－至到]\s*([^（\s]+?))?\s*(?:（依据[：:]?([^）]*)）)?\s*$/,
    );
    if (!m) return null;
    const to = bondTierIndex(m[4] || m[3]);
    if (to === -1) return null;
    return {
        who: m[1],
        target: m[2],
        from: m[4] ? bondTierIndex(m[3]) : null,
        to,
        note: String(m[5] || '').trim(),
    };
}

/** @承诺 行 → { op, who, text }；没有「内容」无法定位承诺，返回 null */
function parseCommitLine(val) {
    const m = String(val || '').match(/^([+~\-])\s*(\S+?)\s+(?:已违背|已解除)?\s*(?:「([^」]*)」)?/);
    if (!m || !m[3]) return null;
    return { op: m[1], who: m[2], text: m[3].trim() };
}

/** @对手 行 → { who, level, lastFloor, lastResult }（序列化往返用，模型一般不输出） */
function parseRivalLine(val) {
    const m = String(val || '').match(/^(\S+?)[\s·]+手段(\d)\/6(?:[\s·]+上次出手第(\d+)层[：:]?(.*))?$/);
    if (!m) return null;
    return {
        who: m[1],
        level: Math.max(0, Math.min(5, Number(m[2]) || 0)),
        lastFloor: Number(m[3]) || 0,
        lastResult: String(m[4] || '').trim(),
    };
}

/**
 * 应用 @心线 行。规则：
 *   · 每条线每轮最多变一档（升档要依据，降档也要依据 —— 防讨好漂移，也防一步登天）；
 *   · 认不出的角色直接丢弃（不静默建节点，那是 freezeTop 的职责）；
 *   · 返回发生变化的清单，调用方拿去写大事记。
 */
export function applyBondOps(state, bonds, floor = 0) {
    const changes = [];
    let userName = '';
    try { userName = (getNames() || {}).user || ''; } catch (e) { /* context 未就绪时容忍 */ }
    (bonds || []).forEach((b) => {
        if (!b || !b.who) return;
        const who = bondKey(b.who, userName);
        if (!who || who === '{{user}}') return;              // {{user}} 不进世界树
        const node = resolveNode(state, who);
        if (!node) return;
        const target = bondKey(b.target, userName);
        if (!target) return;
        if (!node.bonds || typeof node.bonds !== 'object') node.bonds = {};
        const cur = node.bonds[target];
        let to = b.to;
        if (cur && Number.isFinite(cur.tier)) {
            to = Math.max(cur.tier - 1, Math.min(cur.tier + 1, b.to));   // 每轮最多一档
        }
        if (cur && cur.tier === to) {
            if (b.note) cur.note = b.note;                    // 档位没变但有新依据 → 只更新依据
            return;
        }
        node.bonds[target] = {
            tier: to,
            note: b.note || (cur && cur.note) || '',
            floor,
            at: new Date().toLocaleString('zh-CN'),
        };
        changes.push({ who: node.name, target, from: cur ? cur.tier : null, to, note: b.note || '' });
    });
    return changes;
}

function commitId() { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** 按 who + 「内容」找承诺（模糊互含，取最近一条；没给内容时只认仅有一条生效承诺的无歧义情况） */
function findCommit(state, who, text) {
    const list = (state.commitments || []).filter(
        (c) => c.who === who || coreName(c.who) === coreName(who),
    );
    if (text) {
        let hit = list.filter((c) => c.status === 'active' && (c.text.includes(text) || text.includes(c.text)));
        if (!hit.length) hit = list.filter((c) => c.text.includes(text) || text.includes(c.text));
        if (hit.length) return hit[hit.length - 1];
    }
    const act = list.filter((c) => c.status === 'active');
    return act.length === 1 ? act[0] : null;
}

/**
 * 应用 @承诺 行。
 *   + 生效 ／ ~ 已违背（自动触发心线惩罚：对 {{user}} 降一档）／ - 已解除
 * @param {{floor?:number, reset?:boolean}} opts reset=true 时先清空（编辑页整体替换用）
 */
export function applyCommitOps(state, commits, opts = {}) {
    const changes = [];
    if (!Array.isArray(state.commitments)) state.commitments = [];
    if (opts.reset) state.commitments = [];
    let userName = '';
    try { userName = (getNames() || {}).user || ''; } catch (e) { /* ignore */ }
    (commits || []).forEach((c) => {
        if (!c || !c.who || !c.text) return;
        const who = bondKey(c.who, userName);
        if (!who || who === '{{user}}') return;
        if (c.op === '+') {
            const dup = state.commitments.find((x) => x.who === who && x.text === c.text && x.status === 'active');
            if (dup) return;
            state.commitments.unshift({
                id: commitId(), who, text: c.text, status: 'active',
                since: opts.floor || 0, at: new Date().toLocaleString('zh-CN'),
            });
            changes.push({ op: '+', who, text: c.text });
            return;
        }
        const hit = findCommit(state, who, c.text);
        if (!hit) return;
        if (c.op === '~') {
            if (hit.status === 'broken') return;
            hit.status = 'broken';
            hit.at = new Date().toLocaleString('zh-CN');
            let punish = '';
            // 心线惩罚：违背承诺 → 对 {{user}} 降一档（有记录才罚，不凭空造线）
            const node = resolveNode(state, hit.who);
            const ub = node && node.bonds && node.bonds['{{user}}'];
            if (node && ub && Number.isFinite(ub.tier) && ub.tier > 0) {
                ub.tier -= 1;
                ub.note = `违背承诺「${hit.text.slice(0, 24)}」`;
                ub.floor = opts.floor || 0;
                punish = `对{{user}}心线降至「${BOND_TIERS[ub.tier]}」`;
            }
            changes.push({ op: '~', who: hit.who, text: hit.text, punish });
        } else if (c.op === '-') {
            if (hit.status === 'released') return;
            hit.status = 'released';
            hit.at = new Date().toLocaleString('zh-CN');
            changes.push({ op: '-', who: hit.who, text: hit.text });
        }
    });
    return changes;
}

/** 应用 @对手 行（编辑页往返用；演化轮里系统自己维护，不依赖模型输出） */
export function applyRivalOps(state, rivals) {
    (rivals || []).forEach((r) => {
        if (!r || !r.who) return;
        const node = resolveNode(state, r.who);
        if (!node || !node.parent) return;   // 对手一定是挂在女主下面的子分支
        node.rival = {
            level: r.level || 0,
            lastFloor: r.lastFloor || 0,
            lastMin: node.rival && Number.isFinite(node.rival.lastMin) ? node.rival.lastMin : null,
            lastResult: r.lastResult || '',
        };
    });
}

export function parseFields(text) {
    const fields = { time: '', location: '', summary: '', mood: '', goal: '', mindset: '' };
    const persona = {};
    const restParts = [];
    String(text || '').split(/\s*[\/｜|]\s*/).map((s) => s.trim()).filter(Boolean).forEach((seg) => {
        if (takePersona(seg, persona)) return;          // 性格段（位置不限）
        const m = seg.match(FIELD_RE);
        if (!m) { restParts.push(seg); return; }
        const key = m[1];
        const val = m[2].trim();
        if (key === '时间' || key === '时间段') fields.time = val;
        else if (key === '位置' || key === '地点') fields.location = val;
        else if (key === '心情' || key === '状态') fields.mood = val;
        else if (key === '目标') fields.goal = val;
        else if (key === '近况') fields.mindset = val;
        else restParts.push(val);
    });
    // 时间和地点可能出现在任意一段（性格段在前、身份描述在后时也要能认出来）
    const kept = [];
    restParts.forEach((seg) => {
        let t = seg;
        const tm = t.match(TIME_RE);
        if (tm && !fields.time) { fields.time = tm[1]; t = t.slice(tm[0].length).trim(); }
        if (!fields.location) {
            const lm = t.match(LOCATION_RE);
            if (lm) { fields.location = lm[1]; t = t.slice(lm[0].length).trim(); }
        }
        if (t) kept.push(t);
    });
    let rest = kept.join(' ').trim();
    if (!fields.time) {
        const tm = rest.match(TIME_RE);
        if (tm) { fields.time = tm[1]; rest = rest.slice(tm[0].length).trim(); }
    }
    if (!fields.location) {
        const lm = rest.match(LOCATION_RE);
        if (lm) { fields.location = lm[1]; rest = rest.slice(lm[0].length).trim(); }
    }
    fields.summary = rest;
    if (Object.keys(persona).length) fields.persona = persona;
    return fields;
}

/* ---------------- 工作小结（"这一轮我干了什么"） ---------------- */

/**
 * 把模型输出拆成 { body, summary }
 * body = 协议行；summary = ## 小结 / 【小结】 / 小结： 后面的内容
 */
export function splitSummary(text) {
    const t = String(text || '');
    let m = t.match(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:工作小结|本轮小结|小结|总结)[ \t]*[:：]?[ \t]*\n([\s\S]*)$/);
    if (m && m.index !== undefined) {
        return { body: t.slice(0, m.index).trim(), summary: String(m[1] || '').trim() };
    }
    // 行内写法：小结：xxx
    m = t.match(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:工作小结|本轮小结|小结|总结)[ \t]*[:：][ \t]*([^\n][\s\S]*)$/);
    if (m && m.index !== undefined) {
        return { body: t.slice(0, m.index).trim(), summary: String(m[1] || '').trim() };
    }
    return { body: t.trim(), summary: '' };
}

/**
 * 解析任意协议文本 → { worldTime, hide, ops }
 * ops: [{ op:'+'|'~'|'-', path:[...], category, fields, text }]
 */
export function parseLines(text) {
    const out = { worldTime: '', hide: [], ops: [], dropped: [], bonds: [], commits: [], rivals: [] };
    const lines = String(text || '').split(/\r?\n/);
    for (let rawLine of lines) {
        let line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#') || line.startsWith('//')) continue;

        if (line.startsWith('@')) {
            const body = line.slice(1).trim();
            const sp = body.indexOf(' ');
            const key = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
            const val = (sp === -1 ? '' : body.slice(sp + 1)).trim();
            if (key === 'time' || key === '时间') out.worldTime = val;
            else if (key === 'hide' || key === '隐藏') {
                out.hide = val.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
            }
            // v2.4.0 攻防生态：心线 / 承诺 / 对手档案（解析失败进 dropped，不静默）
            else if (key === '心线' || key === 'bonds') {
                const b = parseBondLine(val);
                if (b) out.bonds.push(b); else out.dropped.push(rawLine.trim());
            }
            else if (key === '承诺' || key === 'commit' || key === 'promise') {
                const c = parseCommitLine(val);
                if (c) out.commits.push(c); else out.dropped.push(rawLine.trim());
            }
            else if (key === '对手' || key === 'rival') {
                const r = parseRivalLine(val);
                if (r) out.rivals.push(r); else out.dropped.push(rawLine.trim());
            }
            continue;
        }

        // 操作符：+ 新增 / ~ 更新 / - 归档
        // "-" 归档门槛（防误伤）：模型偶尔把 Markdown 列表甩进来（"- 苏晴"、"- 苏晴 在咖啡厅"）。
        // 只有"- 名字"这种**整行就是一个短名字**（带空格、无句子标点、无时间）时才认归档；
        // 带类别【】的列表行按更新处理；带正文的列表行路径对不上、自然落空。
        // 操作符后空格可省（模型偶尔输出 "~苏晴" 而不是 "~ 苏晴"），但归档必须有空格——
        // "-苏晴" 不认归档，避免和 Markdown 连写列表混淆。
        let op = '~';
        const mop = line.match(/^([+~\-=])(\s*)([\s\S]*)$/);
        if (mop) {
            const sym = mop[1];
            const hadSpace = mop[2].length > 0;
            const restLine = mop[3].trim();
            if (sym === '=') { out.dropped.push(rawLine.trim()); continue; }
            if (sym === '-') {
                const looksLikeBareName = hadSpace && restLine
                    && restLine.length <= 12
                    && !/[【\[，。！？；：、]/.test(restLine)
                    && !TIME_RE.test(restLine);
                if (looksLikeBareName) { op = '-'; line = restLine; }
                else { line = restLine; } // Markdown 列表里的行，按更新处理
            } else if (sym === '+') {
                // 【新增门槛】v2.3.7：预设/正文混进输出时，一句 "+ 我今天去了公园"
                // 会被当成"新增一个叫这个名字的角色" —— 要么凭空长垃圾节点，
                // 要么被 freezeTop 塞进待审名单污染提案区。
                // 协议要求新增行必须带【类别】，所以「带【】/ 带时间 / 是短名字 / 带关系路径」
                // 四者有其一方才认；其余整行丢弃（记入 dropped，不静默）。
                const hasCat = /[【\[]/.test(restLine);
                const hasTime = /\d{1,2}:\d{2}/.test(restLine);
                const nameSeg = restLine.split(/[【\[]/)[0].trim();
                const shortName = !!nameSeg && nameSeg.length <= 6 && !/[，。！？；：、…]/.test(nameSeg);
                const pathLike = nameSeg.includes('>') || nameSeg.includes('＞');
                if (hasCat || hasTime || shortName || pathLike) { op = '+'; line = restLine; }
                else { out.dropped.push(rawLine.trim()); continue; }
            } else {
                op = sym; line = restLine;
            }
        } else {
            line = line.replace(/^\s*[*]\s+/, '');
        }

        // 路径
        let pathPart = line;
        let category = '';
        let rest = '';
        // 类别：【交互】 或 [交互]（【攻防】等旧写法也会被别名表接住，见 CATEGORY_ALIAS）
        let m = line.match(/[【\[]([^】\]]{1,12})[】\]]/);
        if (m && m.index !== undefined) {
            pathPart = line.slice(0, m.index).trim();
            const cat = normalizeCategory(m[1]);
            rest = line.slice(m.index + m[0].length).trim();
            if (cat) category = cat;
            else rest = line.slice(m.index).trim(); // 不是类别，当作正文
        }
        const path = pathPart.split(/\s*>\s*|＞/).map(cleanName).filter(Boolean);
        if (!path.length) continue;
        // 通用门槛（v2.3.7）：路径每一段都必须"像个名字"。
        // 分隔线（===== 正文开始 =====）、正文句子、Markdown 列表混进输出时挡在这里，
        // 否则它们会被当成路径去 ensureNode()，凭空长出垃圾节点。
        // v2.3.17：句子标点（，。！？；、…）也算"不像名字"——
        // 实测「- 我今天去了公园散步，看见了很多花」这种正文行以前能过长度闸（16 字以内），
        // 变成一条路径 op，最后污染待审名单。人名段里不会出现句读。
        if (path.some((seg) => seg.length > 16 || /[=|#*_~`{}，。！？；、…]/.test(seg))) {
            out.dropped.push(rawLine.trim());
            continue;
        }
        // 纯关系/职业代号门槛（v2.3.9）：整段就是"男朋友""继母""老板娘"这种词的行一律不收。
        // 资料里真实存在但没给名字的人，模型必须先起正式名字（见三个提示词的起名规则）。
        // 这种节点剥前缀后核心名为空，会让 sameNameGroups / 自动合并 / 迁移整链静默失效。
        if (path.some((seg) => RELATION_WORDS.includes(seg))) {
            out.dropped.push(rawLine.trim());
            continue;
        }
        const fields = parseFields(rest);
        out.ops.push({ op, path, category, fields, text: rest });
    }
    return out;
}

export function ensureNode(state, path, category) {
    for (let i = 0; i < path.length; i++) {
        const id = makeId(path.slice(0, i + 1));
        if (!state.nodes[id]) {
            state.nodes[id] = {
                id,
                name: path[i],
                parent: i === 0 ? null : makeId(path.slice(0, i)),
                level: i,
                category: i === path.length - 1 ? (category || 'unseen') : (category || 'cooldown'),
                time: '', location: '', summary: '', mood: '', goal: '',
                persona: {},   // 主基调性格：性格/底色/软肋/说话/行为（锁定，更新不许改）
                bonds: {},     // v2.4.0 心线：{ 对象名: { tier, note, floor, at } }，key 可为 '{{user}}' 字面量
                floor: 0, archived: false, seq: (state.seq = (state.seq || 0) + 1),
            };
            if (i === 0) state.order.push(id);
        }
    }
    return state.nodes[makeId(path)];
}

/** 把 oldId 下的子分支整体搬到 newId 下（避免迁移后子分支变孤儿） */
function remapChildren(state, oldId, newId, depth = 0) {
    if (depth > 6) return;
    const kids = Object.values(state.nodes).filter((n) => n.parent === oldId);
    for (const c of kids) {
        const newChildId = `${newId}>${c.name}`;
        remapChildren(state, c.id, newChildId, depth + 1);
        delete state.nodes[c.id];
        c.id = newChildId;
        c.parent = newId;
        state.nodes[newChildId] = c;
    }
}

/** 只序列化指定的顶层角色及其子分支（分批建档用） */
export function serializeSubset(state, topNames) {
    const names = (topNames || []).filter(Boolean);
    const lines = [];
    if (state.worldTime) lines.push(`@time ${state.worldTime}`);
    // 名单可能是：完整路径（"珞珈 > 父亲朱城"，mustCoverNames 的标准输出）、
    // 顶层名（"珞珈"）或短名（"父亲朱城"，旧存档/自定义调用方）。
    // 旧实现只拿 names.includes(t.name) 匹配**顶层名**，子分支永远匹配不上 ——
    // 补漏轮的【当前世界状态】只剩一行 @time，模型没有任何角色参考，
    // 对着短名清单只能瞎编（v2.3.25 实测事故：幻觉出一整批陌生人 + 家人张冠李戴）。
    const wantedTops = new Set();
    names.forEach((nm) => {
        const segs = String(nm).split('>').map((s) => s.trim()).filter(Boolean);
        if (!segs.length) return;
        // 完整路径 → 顶层宿主；顶层名 / 短名 → 拿它本身匹配顶层
        wantedTops.add(segs[0]);
        wantedTops.add(segs[segs.length - 1]);
    });
    topNodes(state).forEach((t) => {
        if (wantedTops.has(t.name)) walk(state, t, lines, 99);
    });
    // 兜底：一个都没匹配上（名单全是子分支短名且顶层叫别的）时，
    // 宁给全量状态多烧点 token，也不能把模型蒙在鼓里让它编。
    if (lines.length <= 1 && Object.keys(state.nodes || {}).length) {
        return serialize(state);
    }
    return lines.join('\n');
}

/** 顶层角色名列表 */
export function topNames(state) {
    return topNodes(state).map((n) => n.name);
}

/**
 * 关系词分族表 —— **两张表唯一的词源**。
 *
 * 加词只加这里，自动同步两处：
 *   · RELATION_PREFIX_RE（剥前缀）：由全表生成，长词自动优先
 *   · relationFamily()（同族判定）：只用前 6 个「亲疏族」
 * 以前这两张是各写各的硬编码白名单，改一个忘一个，就会出现
 * 「迁移判定悄悄歪掉但没人发现」——v2.3.7 合并成一份数据源，从结构上消除这个隐患。
 *
 * 为什么补词这么要紧：coreName() 剥不掉前缀 → sameNameGroups() 分不到同一组 →
 * syncSameName / mergeDuplicateMounts / dedupeInvertedOrphans 三个防污染函数**全部静默空转**，
 * 症状是同一人出现双份节点、状态不一致、大事记同时记「攻略 管家赵叔」和「攻略 赵叔」。
 *
 * 最后一族（身份 / 职务）只为剥前缀而存在，不参与亲疏判定 ——
 * 否则「管家赵叔」和「儿子赵叔」会被判成两个人（其实很可能是同一个赵叔）。
 */
const RELATION_FAMILY = [
    // 0 恋人 / 暧昧 / 秘密关系
    ['老公', '丈夫', '老婆', '妻子', '未婚夫', '未婚妻', '男朋友', '女朋友', '男友', '女友',
        '情人', '炮友', '暧昧', '暧昧对象', '对象', '恋人', '伴侣', '追求者', '暗恋',
        '秘密男友', '秘密女友', '秘密情人', '秘密', '前男友', '前女友', '前夫', '前妻', '前任',
        '前未婚夫', '前未婚妻', '现任'],
    // 1 直系亲属
    ['父亲', '母亲', '爸爸', '妈妈', '父母', '亲妈', '亲爸', '亲生母亲', '亲生父亲', '继父', '继母',
        '养父', '养母', '教父', '教母', '儿子', '女儿', '大儿子', '小儿子', '大女儿', '小女儿',
        '养子', '养女', '继子', '继女', '私生子', '私生女'],
    // 2 兄弟姐妹 / 平辈
    ['哥哥', '姐姐', '弟弟', '妹妹', '兄弟', '姐妹', '表哥', '表姐', '表弟', '表妹',
        '堂哥', '堂姐', '堂弟', '堂妹', '好兄弟', '好姐妹', '发小', '青梅竹马'],
    // 3 长辈
    ['爷爷', '奶奶', '外公', '外婆', '叔叔', '叔', '阿姨', '舅舅', '姑姑', '婶婶', '伯父', '伯母',
        '干爹', '干妈'],
    // 4 姻亲 / 晚辈
    ['岳父', '岳母', '公公', '婆婆', '大嫂', '嫂子', '弟媳', '姐夫', '妹夫', '女婿', '儿媳',
        '前女婿', '前儿媳', '侄子', '侄女', '外甥', '外甥女', '孙子', '孙女', '干儿子', '干女儿'],
    // 5 朋友 / 职场 / 社交
    ['闺蜜', '好朋友', '朋友', '同事', '同学', '邻居', '上司', '下属', '学长', '学姐', '学弟', '学妹',
        '导师', '老师', '学生', '徒弟', '师父', '师傅', '老板', '客户', '班长', '会长'],
    // 6 身份 / 职务（只为剥前缀，不代表亲疏）
    ['管家', '佣人', '保姆', '司机', '秘书', '助理', '保镖', '护卫', '随从', '仆人', '侍女', '侍从',
        '雇主', '女主人', '男主人', '主人', '房东', '租客', '债主', '恩人', '仇人', '对手',
        '主治医生', '医生', '护士', '律师', '经纪人', '店长', '经理', '董事', '社长', '校长', '院长',
        // v2.3.9：正文里常以职业代号出现的"无名人士"，补进词表便于剥前缀；
        // 同时作为"纯代号节点"硬挡清单（见 parseLines），逼模型给正式人名
        '老板娘', '包工头', '店员', '服务员', '前台', '保安', '摊主'],
];

/** 亲疏族：只有这 6 族参与「同族判定」；身份/职务族不参与（见上） */
const RELATION_FAMILY_KIN = RELATION_FAMILY.slice(0, 6);

/** 全部关系词（去重） */
const RELATION_WORDS = [...new Set([].concat(...RELATION_FAMILY))];

/** 剥前缀正则：长词优先，避免「亲生母亲」被「母亲」先咬掉（排序在生成时做掉）。
 *  v2.3.17：补「前」字前瞻 —— 「前男主人」「前雇主」「前老板娘」这类
 *  「前 + 已知关系词」的复合前缀以前剥不掉（词表里没有这些完整复合词），
 *  coreName 返回原串 → 同一人两份节点。现在允许「前」单独被剥，
 *  但仅当它后面还跟着已知关系词（前瞻不消耗字符）——
 *  这样以「前」开头的真名（如「前进」）不会被误剥。 */
const RELATION_WORDS_DESC = RELATION_WORDS.slice().sort((a, b) => b.length - a.length).join('|');
const RELATION_PREFIX_RE = new RegExp(`^(?:${RELATION_WORDS_DESC}|前(?=(?:${RELATION_WORDS_DESC})))+`);

/** 取"这个人叫什么"（去掉关系前缀），用于判断两处挂载是不是同一个人 */
export function coreName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const stripped = raw.replace(RELATION_PREFIX_RE, '').trim();
    return stripped || raw;
}

/** 走到顶层祖先的 id（自己就是顶层时返回自己） */
export function rootTopId(state, id) {
    let cur = state.nodes[id];
    let guard = 0;
    while (cur && cur.parent && guard++ < 20) cur = state.nodes[cur.parent];
    return cur ? cur.id : id;
}

/** 关系词家族：用来判断两处挂载说的是不是同一层关系 */
function relationFamily(name) {
    const n = String(name || '');
    for (let i = 0; i < RELATION_FAMILY_KIN.length; i++) {
        if (RELATION_FAMILY_KIN[i].some((k) => n.includes(k))) return i;
    }
    return -1;   // 不带关系词（含只有身份/职务词的情况）
}

/**
 * 两处挂载的关系词是不是同一族。
 * "儿子陈浩" ↔ "小儿子陈浩" → true（同一层关系，只是叫法不同）
 * "儿子陈浩" ↔ "秘密男友陈浩" → false（一个是亲属、一个是情人，是两个人）
 * 两边都没关系词时按 true 处理（纯改名场景）
 */
export function sameRelationFamily(a, b) {
    const fa = relationFamily(a);
    const fb = relationFamily(b);
    if (fa === -1 || fb === -1) return true;
    return fa === fb;
}

/** 名字清洗：剥掉模型残留在名字首尾的协议符号与空白（如 "~苏晴"、"+小张"、"苏晴："） */
export function cleanName(raw) {
    return String(raw || '')
        .trim()
        .replace(/^[+~\-=>#*·•、，,\s]+/, '')
        .replace(/[：:、，,\s]+$/, '')
        .trim();
}

/** 在已有节点里解析"这个人"：名字精确匹配 → 核心名匹配（顶层优先、非归档优先） */
export function resolveNode(state, raw) {
    const name = cleanName(raw);
    if (!name) return null;
    const all = Object.values(state.nodes || {});
    let hit = all.filter((n) => n.name === name);
    if (!hit.length) {
        const core = coreName(name);
        if (core) hit = all.filter((n) => coreName(n.name) === core);
    }
    if (!hit.length) return null;
    return hit.sort((a, b) => ((a.archived ? 1 : 0) - (b.archived ? 1 : 0)) || ((a.level || 0) - (b.level || 0)))[0];
}

/** 顶层节点解析：优先返回顶层（女主级）节点 */
export function resolveTop(state, raw) {
    const name = cleanName(raw);
    if (!name) return null;
    const tops = Object.values(state.nodes || {}).filter((n) => !n.parent);
    let hit = tops.filter((n) => n.name === name);
    if (!hit.length) {
        const core = coreName(name);
        if (core) hit = tops.filter((n) => coreName(n.name) === core);
    }
    return hit[0] || null;
}

/** 找出"同一个人挂在多处"的情况：[[核心名, [节点...]], ...] */
export function sameNameGroups(state) {
    const map = new Map();
    Object.values(state.nodes || {}).forEach((n) => {
        const key = coreName(n.name);
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(n);
    });
    return [...map.entries()].filter(([, list]) => list.length > 1);
}

/**
 * 找出「疑似同一人」—— 关系词表**没覆盖**到的那种前缀。
 *
 * 判定：A 的核心名以 B 的核心名结尾，且多出来的前缀是 **2~4 个纯中文**。
 *
 *   「管家赵叔」 = 「管家」 + 「赵叔」   → 疑似同一人 ✅
 *   「陈浩宇」    多出的是**后缀**「宇」   → 不判定 ✅
 *
 * **只剥前缀、不剥后缀** + **前缀 ≥2 字**，这两条合起来才能既治住「管家赵叔」，
 * 又不会把「陈浩宇」和「陈浩」并成一个人（那是本项目踩过的坑：
 * 「陈浩」只是「陈浩宇」的子串，两人不是同一个人）。
 *
 * 返回结构与 sameNameGroups 一致，方便共用同一套合并逻辑。
 * ⚠️ 这些组**不自动合并** —— 属于中低置信，交给用户在状态页确认（判错会删节点）。
 */
export function suspectedGroups(state) {
    const byCore = new Map();
    Object.values(state.nodes || {}).forEach((n) => {
        const k = coreName(n.name);
        if (!k) return;
        if (!byCore.has(k)) byCore.set(k, []);
        byCore.get(k).push(n);
    });
    const keys = [...byCore.keys()];
    if (keys.length < 2) return [];

    const buckets = new Map();   // 锚核心名 -> Set(核心名)
    keys.forEach((k) => {
        // 泛称节点：名字**整个就是关系词**（如「继母」「亲妈」——模型偶尔只写关系不写名字）。
        // 它和「继母刘芳」这种带名字的版本是同一个人，但核心名一个叫「继母」一个叫「刘芳」，
        // 永远对不上。这里配对：泛称归到带名字的那一组。
        // 注意要在**全名**里找「k + 名字」——byCore 的键是核心名（继母刘芳→刘芳），看不到全名。
        const isGeneric = RELATION_WORDS.includes(k);
        let anchor = null;
        if (isGeneric) {
            Object.values(state.nodes || {}).forEach((n) => {
                if (anchor) return;
                const full = String(n.name || '');
                if (!full.startsWith(k) || full === k) return;
                const rest = full.slice(k.length);
                if (!/^[\u4e00-\u9fa5]{1,4}$/.test(rest)) return;   // 剩余部分是纯中文名字
                const a = coreName(full);
                if (a && a !== k && byCore.has(a)) anchor = a;      // 锚 = 带名字节点的核心名
            });
        } else {
            for (const other of keys) {
                if (other === k || other.length >= k.length) continue;
                if (!k.endsWith(other)) continue;
                const prefix = k.slice(0, k.length - other.length);
                if (!/^[\u4e00-\u9fa5]{2,4}$/.test(prefix)) continue;   // 纯中文 2~4 字
                if (anchor === null || other.length < anchor.length) anchor = other;
            }
        }
        if (!anchor) return;
        if (!buckets.has(anchor)) buckets.set(anchor, new Set([anchor]));
        buckets.get(anchor).add(k);
    });

    const out = [];
    buckets.forEach((keySet, anchor) => {
        const list = [];
        keySet.forEach((k) => { list.push(...(byCore.get(k) || [])); });
        if (list.length > 1) out.push([anchor, list]);
    });
    return out;
}

/**
 * 合并重复挂载：同一个人（核心名相同）挂在多处时，**只保留一处**，其余合并掉。
 *
 * 为什么不能只靠 syncSameName：它会保留两边、只把状态共享过去，
 * 于是世界里永远同时挂着「胡静 > 儿子陈浩」和「陆雪 > 秘密男友陈浩」两个陈浩，
 * 面板上看起来就是"同一个人反复出现"。这里直接把副本并掉（子分支搬过去）。
 *
 * 保留规则（分越高越优先保留）：
 *   1. 顶层节点 > 子节点（顶层是人物的锚点，绝不能删）
 *   2. 有子分支的 > 没子分支的（避免把子树一起丢掉）
 *   3. 关系更亲密的 > 疏远的（secret/lover/未婚夫 之类优先，保住最亲的那一层）
 *   4. 最近更新过的 > 旧的
 *
 * @param {object} state
 * @param {{dryRun?:boolean}} [opts] dryRun=true 时只报告不修改
 * @returns {{removed:number, merged:[{keep:string, drop:string[]}]}}
 */
const RELATION_PRIORITY = [
    /秘密|情人|炮友|暧昧|追求|暗恋/,      // 最亲密 / 最敏感的一层优先
    /未婚夫|未婚妻|男友|女友|男朋友|女朋友|老公|丈夫|老婆|妻子|恋人|伴侣|对象/,
    /儿子|女儿|父亲|母亲|爸爸|妈妈|父母|哥哥|姐姐|弟弟|妹妹/,
];

function keepScore(state, n) {
    let score = 0;
    if (!n.parent) score += 1000;                       // 顶层最优先
    const kids = Object.values(state.nodes).filter((c) => c.parent === n.id).length;
    score += Math.min(kids, 20) * 50;                   // 有子分支优先
    const rel = String(n.name || '');
    for (let i = 0; i < RELATION_PRIORITY.length; i++) {
        if (RELATION_PRIORITY[i].test(rel)) { score += (RELATION_PRIORITY.length - i) * 10; break; }
    }
    // **先建档的优先**：重复挂载里保留建档/Roster 期从真实资料长出来的那一份。
    // 判据用 nodes 的**插入顺序**而不是 seq —— seq 在每次更新时都会 bump
    // （applyOps 尾部），同一轮里"先幻觉副本、后真行"时 seq 会反过来；
    // 插入顺序只由建档时间决定，幻觉副本永远排在真节点后面。
    // （v2.3.25 事故：补漏轮幻觉出「孙翌童 > 未婚夫张伟」，旧代码"最近更新优先"
    // 把陈晓北家的真张伟删掉、留下挂错的假张伟。）
    score -= Math.min(Object.keys(state.nodes).indexOf(n.id) / 200, 9);
    return score;
}

export function mergeDuplicateMounts(state, opts = {}) {
    return applyMerge(state, sameNameGroups(state), !!opts.dryRun);
}

/**
 * 合并「疑似同一人」（**中低置信**：关系词表没覆盖，靠"前缀 2~4 字纯中文"推出来的）。
 * 只由用户在状态页主动点「合并」触发 —— 判错会删节点，绝不自动跑。
 */
export function mergeSuspected(state) {
    return applyMerge(state, suspectedGroups(state), false);
}

/** 合并一组「同一人」的节点（高置信与低置信共用这份逻辑） */
function applyMerge(state, groups, dryRun) {
    const result = { removed: 0, merged: [] };

    groups.forEach(([, list]) => {
        // 顶层节点单独分组：同一核心名有多个顶层时不动（那属于用户自己的命名，不该自动删）
        const tops = list.filter((n) => !n.parent);
        const subs = list.filter((n) => !!n.parent);
        if (tops.length > 1) return;                    // 多个顶层重名 → 交给用户裁决
        if (!subs.length) return;

        // 如果已有顶层锚点，所有子挂载都是"同一个人挂在别人下面" → 全部并进顶层
        let keep = tops[0] || null;
        if (!keep) {
            const ranked = subs.slice().sort((a, b) => keepScore(state, b) - keepScore(state, a));
            keep = ranked[0];
        }
        const drops = subs.filter((n) => n.id !== keep.id);
        if (!drops.length) return;

        const entry = { keep: keep.id, drop: drops.map((d) => d.id) };
        result.merged.push(entry);
        result.removed += drops.length;
        if (dryRun) return;

        drops.forEach((d) => {
            // 把被合并节点的子分支整体搬到保留节点下，避免丢子树
            remapChildren(state, d.id, keep.id);
            delete state.nodes[d.id];
        });
        state.order = (state.order || []).filter((id) => state.nodes[id] && !state.nodes[id].parent);
    });

    // 兜底：确保所有顶层都在 order 里、子节点不在
    Object.values(state.nodes).forEach((n) => {
        if (!n.parent && !state.order.includes(n.id)) state.order.push(n.id);
    });
    state.order = (state.order || []).filter((id) => state.nodes[id] && !state.nodes[id].parent);
    return result;
}

const SHARED_FIELDS = ['category', 'time', 'untilMin', 'location', 'summary', 'mood', 'goal', 'floor', 'archived'];

/**
 * 同一个人的多处挂载共享同一份状态（以最近被更新的那一处为准）
 * —— 关系网保留两边，但不会出现"两个陈浩状态不一样"
 */
export function syncSameName(state, enabled = true) {
    if (!enabled) return 0;
    let synced = 0;
    sameNameGroups(state).forEach(([, list]) => {
        const latest = list.slice().sort((a, b) => (b.seq || 0) - (a.seq || 0))[0];
        list.forEach((n) => {
            if (n === latest) {
                n.sharedWith = '';
                return;
            }
            SHARED_FIELDS.forEach((k) => { n[k] = latest[k]; });
            n.sharedWith = latest.id;
            synced++;
        });
    });
    return synced;
}

/** 清理"倒挂孤儿"：和某个有子分支的顶层女主同核心名、却挂在别人下面的子节点（之前 bug 产生的重复） */
export function dedupeInvertedOrphans(state) {
    const topsWithChildren = Object.values(state.nodes).filter(
        (t) => !t.parent && Object.values(state.nodes).some((c) => c.parent === t.id),
    );
    let removed = 0;
    const toDelete = [];
    Object.values(state.nodes).forEach((n) => {
        if (!n.parent) return;
        const core = coreName(n.name);
        const dup = topsWithChildren.find((t) => coreName(t.name) === core);
        if (dup && dup.id !== n.id && dup.id !== n.parent) {
            // 只删没有子分支的倒挂孤儿（有子分支的留着，syncSameName 已共享状态）
            const hasKids = Object.values(state.nodes).some((c) => c.parent === n.id);
            if (!hasKids) toDelete.push(n.id);
        }
    });
    toDelete.forEach((id) => { delete state.nodes[id]; removed++; });
    if (removed) state.order = (state.order || []).filter((id) => state.nodes[id] && !state.nodes[id].parent);
    return removed;
}

/* ---------------- 待审提案（提案-裁决制） ---------------- */

const PENDING_MAX = 20;

/** 模型在演化阶段提到的新顶层角色 → 进待审名单，由用户决定是否建档 */
function pushPending(state, item, floor) {
    if (!Array.isArray(state.pending)) state.pending = [];
    const name = item.path[0];
    state.pending = state.pending.filter((p) => p.name !== name);
    state.pending.unshift({
        name,
        path: item.path.slice(),
        op: item.op || '~',
        category: item.category || '',
        text: String(item.text || '').slice(0, 200),
        floor,
        at: new Date().toLocaleString('zh-CN'),
    });
    if (state.pending.length > PENDING_MAX) state.pending.length = PENDING_MAX;
}

/** 批准提案：按提案路径建档（默认建成顶层角色） */
export function approvePending(state, name) {
    if (!Array.isArray(state.pending)) return null;
    const p = state.pending.find((x) => x.name === name);
    if (!p) return null;
    state.pending = state.pending.filter((x) => x.name !== name);
    // v2.3.19：同名守卫 —— 提案的名字如果已经作为**子分支**挂在别人下面（典型：赵海
    // 早就是「柳青>金主赵海」），resolveTop 会返回 null，于是旧代码会再建一个**顶层赵海**，
    // 世界上就出现两个赵海。这种提案的正确处理是"挂到已有那个节点上"，不是新建。
    const existing = Object.values(state.nodes).find(
        (n) => !n.archived && n.name !== name && coreName(n.name) === coreName(name));
    if (existing) {
        // 已经存在同一个人 → 只把提案里的状态补进去，不新建节点
        try {
            const f = parseFields(String(p.text || ''));
            if (f.location) existing.location = f.location;
            if (f.time) existing.time = f.time;
            if (f.mood) existing.mood = f.mood;
            if (f.summary) existing.summary = f.summary.slice(0, 120);
        } catch (e) { /* 解析失败就只清提案 */ }
        if (p.category) existing.category = p.category;
        existing.floor = p.floor || existing.floor || 0;
        existing.seq = (state.seq = (state.seq || 0) + 1);
        return existing;
    }
    const path = p.path.length > 1 && resolveTop(state, p.path[0]) ? p.path : [p.name];
    // v2.3.15：批准入场 ≠ 未出场 —— 她是因为**在剧情里出现了**才被提名进树的，
    // 所以按提案里的类别进场（没有就默认【交互】），提案行里的时间/地点/描述一并带上；
    // 性格留空，之后用「只补性格」从世界书条目注入。
    const node = ensureNode(state, path, p.category || 'interaction');
    node.floor = p.floor || 0;
    node.seq = (state.seq = (state.seq || 0) + 1);
    try {
        const f = parseFields(String(p.text || ''));
        if (f.location) node.location = f.location;
        if (f.time) node.time = f.time;
        if (f.mood) node.mood = f.mood;
        if (f.summary) node.summary = f.summary.slice(0, 120);
        else if (!node.summary && p.text) node.summary = String(p.text).slice(0, 120);
    } catch (e) { /* 解析失败就退回只带原文 */ }
    state.order = (state.order || []).filter((id) => state.nodes[id] && !state.nodes[id].parent);
    Object.values(state.nodes).forEach((n) => {
        if (!n.parent && !state.order.includes(n.id)) state.order.push(n.id);
    });
    return node;
}

/** 忽略提案 */
export function dismissPending(state, name) {
    if (!Array.isArray(state.pending)) return;
    state.pending = state.pending.filter((p) => p.name !== name);
}

/** 把 ops 应用到 state
 * @param {{lockPersona?:boolean, freezeTop?:boolean}} [opts]
 *   lockPersona=true 时，已有性格的角色不许被改写
 *   freezeTop=true 时（演化/记忆导入阶段），顶层名单冻结：
 *     新顶层角色一律进待审名单，不直接建档 —— 防止模型随手发明新名字污染状态树
 * @returns {{added:[],updated:[],archived:[],migrated:[],seduced:[],redirected:[],pending:[]}}
 */
export function applyOps(state, ops, defaultOp = '~', floor = 0, opts = {}) {
    const res = { added: [], updated: [], archived: [], migrated: [], seduced: [], redirected: [], pending: [], personaFilled: [], reparented: [] };
    for (const rawItem of ops) {
        let item = rawItem;
        const op = item.op || defaultOp;

        // 只补性格模式（v2.3.15）：给"剧情中途入场、用户批准建档"的角色注入性格用。
        // 只把性格的**空位**填上（已有的维度一个字不动），
        // 不改类别 / 时间 / 地点 / 心情 / 目标 / 摘要 / 关系 / 挂载，也不新建、不归档。
        // —— 以前直接跑第二步会把这类角色打回【未出场】（类别被覆盖），
        //    且空值字段会把她的在位状态整个冲掉。
        if (opts.personaOnly) {
            const inc = (item.fields && item.fields.persona) || null;
            if (op !== '-' && item.path && item.path.length && inc && Object.keys(inc).length) {
                const node = state.nodes[makeId(item.path)];
                if (node) {
                    node.persona = node.persona || {};
                    const before = PERSONA_ORDER.filter((k) => node.persona[k]).length;
                    Object.keys(inc).forEach((k) => { if (!node.persona[k]) node.persona[k] = inc[k]; });
                    if (PERSONA_ORDER.filter((k) => node.persona[k]).length > before) {
                        res.personaFilled.push(item.path[item.path.length - 1]);
                    }
                }
            }
            continue;
        }

        // 倒挂保护 / 顶层分家（v2.3.13 重写）：
        // 模型写 "A > 关系B" 时，叶子 B 的核心名命中某个顶层节点，分两种情况：
        //   ① B 是**锚点**（女主级：已整理 state.built 或正在本批整理 opts.batchAnchors 里）
        //      → 保持原倒挂保护：整行重定向成对顶层锚点的更新。
        //      拦的是"母亲 > 女儿汤加琳"这种把女主挂到家人下面的倒挂行。
        //   ② B 是**花名册遗留的普通人**（第 1 步把全卡所有人都建成顶层，家人/男友本该是树枝）
        //      → 以前这里无差别拍平 → 关系树永远建不起来（实测：陈浩/周磊/张建国永远当"主分支"，
        //        模型给"张子薇 > 父亲张建国"写的挂行全被改写成顶层更新，继母造出李芳和刘芳两个）。
        //      现在改为**搬家**：把顶层节点整体搬到模型指定的挂载点下，
        //      原节点数据保留，本行新内容继续正常合并 —— 树从平的变成分层的。
        if (op !== '-' && item.path.length >= 2) {
            const leaf = item.path[item.path.length - 1];
            const leafCore = coreName(leaf);
            if (leafCore) {
                const top = Object.values(state.nodes).find((n) => !n.parent && coreName(n.name) === leafCore);
                if (top) {
                    const anchors = new Set([].concat(state.built || [], opts.batchAnchors || []));
                    const targetId = makeId(item.path);
                    if (anchors.has(top.name)) {
                        item = Object.assign({}, item, { path: [top.name] });
                        const note = `${leaf}→${top.name}`;
                        if (!res.redirected.includes(note)) res.redirected.push(note);
                    } else if (!state.nodes[targetId]) {
                        // 搬家双闸（v2.3.17）：
                        // ① 挂载根必须是锚点（女主级：built / 本批）——只有女主有资格收养家人。
                        //    非锚点顶层挂出来的行（花名册遗留的赵叔写「赵叔 > 雇主米彩」）是倒挂行，
                        //    不设闸会把女主米彩连子树整体拖到赵叔下面（实测事故：树根被偷、全部 id 错位）。
                        // ② 有子分支的顶层不搬——她是一个家族的根，搬了整棵树跟着错位。
                        // 任一闸不满足 → 按倒挂处理：重定向为对该顶层的更新。
                        const mountRoot = resolveTop(state, item.path[0]);
                        const rootIsAnchor = anchors.has(item.path[0])
                            || (mountRoot && anchors.has(mountRoot.name));
                        const topHasKids = Object.values(state.nodes).some((c) => c.parent === top.id);
                        if (!rootIsAnchor || topHasKids) {
                            item = Object.assign({}, item, { path: [top.name] });
                            const note = `${leaf}→${top.name}`;
                            if (!res.redirected.includes(note)) res.redirected.push(note);
                        } else {
                            // 搬家：顶层 → 模型指定的子分支位置（子树跟着搬，order 里除名）
                            remapChildren(state, top.id, targetId);
                            const moved = state.nodes[top.id];
                            delete state.nodes[top.id];
                            moved.id = targetId;
                            moved.parent = makeId(item.path.slice(0, -1));
                            moved.name = leaf;
                            moved.level = item.path.length - 1;
                            state.nodes[targetId] = moved;
                            state.order = (state.order || []).filter((id) => id !== top.id);
                            res.reparented.push(leaf);
                        }
                    }
                }
            }
        }

        // 顶层冻结（提案-裁决制）：演化阶段模型写的顶层名必须命中已有角色，
        // 认不出的新名字 → 待审名单，绝不自动建档
        if (opts.freezeTop && op !== '-' && item.path.length >= 1) {
            let top = resolveTop(state, item.path[0]);
            if (!top) {
                // 【简称映射】模型写「周磊」，而世界树里挂的是「张子薇 > 男朋友周磊」。
                // 顶层里当然找不到 → 会被当成新角色塞进待审名单，于是这个人**永远更新不到**，
                // 用户只看到待审列表越堆越多。
                // 这里用核心名把简称映射回完整路径（只认唯一命中，多个候选仍走待审）。
                const core = coreName(item.path[0]);
                const cands = core
                    ? Object.values(state.nodes).filter((n) => (
                        !n.archived && n.name !== item.path[0] && coreName(n.name) === core
                    ))
                    : [];
                if (cands.length === 1) {
                    const chain = [];
                    let cur = cands[0];
                    let guard = 0;
                    while (cur && guard++ < 20) {
                        chain.unshift(cur.name);
                        cur = cur.parent ? state.nodes[cur.parent] : null;
                    }
                    const note = `${item.path[0]}→${chain.join(' > ')}`;
                    if (chain.length && !res.redirected.includes(note)) res.redirected.push(note);
                    item = Object.assign({}, item, { path: [...chain, ...item.path.slice(1)] });
                    top = resolveTop(state, item.path[0]);
                }
            }
            if (!top) {
                pushPending(state, item, floor);
                if (!res.pending.includes(item.path[0])) res.pending.push(item.path[0]);
                continue;
            }
            if (top.name !== item.path[0]) {
                const note = `${item.path[0]}→${top.name}`;
                item = Object.assign({}, item, { path: [top.name, ...item.path.slice(1)] });
                if (!res.redirected.includes(note)) res.redirected.push(note);
            }
        }

        // 子分支冻结（第 2 步整理专用）：只允许在**已有角色**下面挂新子分支。
        // 目的是挡住"从世界书条目里挖出一堆没戏份的亲戚"——
        // 顶层是靠 freezeTop 挡住的，但模型的溢出主要发生在子分支这一层。
        // 父节点必须已经存在，且**父节点就是本批要整理的角色**（或它们的后代）。
        if (opts.freezeNewSub && op !== '-' && item.path.length >= 2) {
            const parentId = makeId(item.path.slice(0, -1));
            const parent = state.nodes[parentId];
            const parentTop = resolveTop(state, item.path[0]);
            const allowed = !!parent || !!parentTop;   // 父路径能对上已有节点 → 允许挂子分支
            if (!allowed) {
                pushPending(state, item, floor);
                if (!res.pending.includes(item.path[0])) res.pending.push(item.path[0]);
                continue;
            }
        }

        const name = item.path[item.path.length - 1];

        if (op === '-') {
            const id = makeId(item.path);
            if (state.nodes[id]) {
                state.nodes[id].archived = true;
                state.nodes[id].category = 'cooldown';
                if (!state.archived.includes(name)) state.archived.push(name);
                res.archived.push(name);
            }
            continue;
        }

        // 迁移检测：同名但挂载点不同。
        // 三条铁律：
        //   ① 只把**子分支**挪位置，顶层节点（女主级锚点）永远不许被迁移吃掉；
        //   ② 拼写对不上时只认"核心名完全相等"（子串包含匹配会把"女儿汤加琳"
        //      错认成"汤加琳"迁移，正是"两个汤加琳"bug 的源头）；
        //   ③ **不许跨顶层搬家**：把"胡静 > 儿子陈浩"改成"陆雪 > 秘密男友陈浩"
        //      不是迁移，那是把一个陈浩从胡静家搬到陆雪身边 —— 结果是
        //      "儿子的关系没了、凭空多出一个跟陆雪在一起的陈浩"。
        //      只有当两处挂载的**最顶层父节点相同**（同一个女主的关系网内部改名），
        //      才认迁移；跨顶层一律按"另有其人"处理。
        const existIds = Object.keys(state.nodes).filter((k) => state.nodes[k].name === name);
        const targetId = makeId(item.path);
        const targetTop = rootTopId(state, targetId);
        let oldId = null;
        if (existIds.length && !existIds.includes(targetId)) {
            const cands = existIds.map((k) => state.nodes[k]).filter((n) => !!n.parent);
            // 只认挂在**同一个顶层**下的同名节点才迁移（铁律 ③：不许跨顶层搬家）。
            // 旧代码 same.length ? same : cands —— 跨顶层时兜底到 cands，
            // 等于允许"把陈晓北家的未婚夫张伟搬到孙翌童家"（模型幻觉行照单全收）。
            // 现在跨顶层一律不迁移：本行另建副本，交给 syncSameName 共享状态 +
            // applyOps 结尾的 mergeDuplicateMounts 合并，绝不啃掉别人家的原节点。
            const same = cands.filter((n) => rootTopId(state, n.id) === targetTop);
            const pick = same;
            if (pick.length) {
                oldId = (pick.find((n) => n.level === item.path.length - 1) || pick[0]).id;
            }
        } else if (!existIds.length) {
            // 名字带了关系前缀导致对不上（如 "同事小张" → "小张"）：
            // 核心名相同才视为同一个人迁移，且必须满足
            //   · 对方是非顶层、没有子分支的子节点
            //   · 对方和本条挂在**同一个顶层**下面
            //   · 关系词同族（"儿子陈浩" ↔ "小儿子陈浩" 算，"儿子陈浩" ↔ "男友陈浩" 不算）
            const core = coreName(name);
            const hit = core
                ? Object.values(state.nodes).find((n) => (
                    n.id !== targetId && !!n.parent
                    && coreName(n.name) === core
                    && !Object.values(state.nodes).some((c) => c.parent === n.id)
                    && rootTopId(state, n.id) === targetTop
                    && sameRelationFamily(n.name, name)
                ))
                : null;
            if (hit) oldId = hit.id;
        }
        if (oldId) {
            remapChildren(state, oldId, targetId);
            delete state.nodes[oldId];
            res.migrated.push(name);
        }

        const existed = !!state.nodes[targetId];
        const node = ensureNode(state, item.path, item.category || (existed ? state.nodes[targetId].category : 'unseen'));
        if (item.category) {
            if (item.category === 'interaction' && node.category !== 'interaction') res.seduced.push(name);
            node.category = item.category;
        }
        const incoming = Object.assign({}, item.fields || {});
        const incomingPersona = incoming.persona;
        delete incoming.persona;
        // 近况（v2.4.0）：空值不回写 —— 近况靠「一段时间不强化自动回落」衰减，
        // 而不是像心情/目标那样每轮被空值冲掉（那是易变字段，这是带记忆的短中期状态）。
        if (!incoming.mindset) delete incoming.mindset;
        Object.assign(node, incoming);
        // 状态有效期：把时间段（"8:30-9:00"）的结束点换算成绝对分钟，供"到期才更新"调度。
        // 模型没给时间段 → null，该角色退回老逻辑（每轮照常覆盖），不会被误豁免。
        if ('time' in incoming) node.untilMin = computeUntil(state, incoming.time);
        // 近况盖戳：记下写入时的楼层和世界分钟，供衰落判定
        if (incoming.mindset) {
            node.mindsetFloor = floor;
            node.mindsetMin = state.worldMinutes != null ? state.worldMinutes : null;
        }

        // 性格：已有维度锁死，空缺维度允许首次补齐（v2.3.12）。
        // 整理阶段（lockPersona=false）：自由合并——"补充细节但不推翻基调"由提示词约束。
        // 更新阶段（lockPersona=true）：写过的维度一个字不许动（铆钉）；
        //   但父母/家人这类分支角色常常没赶上第 2 步整理、性格一直空着——
        //   这里允许"首次补齐"：只填空位，绝不覆盖已有值。补过一次后自然永久锁死。
        if (incomingPersona && Object.keys(incomingPersona).length) {
            if (!opts.lockPersona) {
                node.persona = Object.assign({}, node.persona || {}, incomingPersona);
            } else {
                node.persona = node.persona || {};
                const before = PERSONA_ORDER.filter((k) => node.persona[k]).length;
                Object.keys(incomingPersona).forEach((k) => {
                    if (!node.persona[k]) node.persona[k] = incomingPersona[k];
                });
                if (PERSONA_ORDER.filter((k) => node.persona[k]).length > before) {
                    res.personaFilled.push(name);
                }
            }
        }

        node.archived = false;
        node.floor = floor;
        node.seq = (state.seq = (state.seq || 0) + 1);
        const ai = state.archived.indexOf(name);
        if (ai !== -1) state.archived.splice(ai, 1);
        if (!existed) res.added.push(name); else if (!res.migrated.includes(name)) res.updated.push(name);
    }
    // 顶层顺序修正
    state.order = (state.order || []).filter((id) => state.nodes[id] && !state.nodes[id].parent);
    Object.values(state.nodes).forEach((n) => {
        if (!n.parent && !state.order.includes(n.id)) state.order.push(n.id);
    });
    // 清理倒挂孤儿（之前 bug 产生的"两个汤加琳"之类的重复）
    dedupeInvertedOrphans(state);
    // 合并重复挂载（"儿子陈浩" / "秘密男友陈浩" 同时存在 → 只留一处）
    if (!opts.keepDuplicates) mergeDuplicateMounts(state);
    return res;
}

/* ---------------- 状态有效期（时间段调度） ----------------
 * 机制：不重要的角色也给一个时间段（"买菜 8:00-9:00"）。
 *   世界时间没过 9:00 → 状态还有效，本轮不用动他；
 *   世界时间过了 9:00 → 状态过期了，这轮必须给新状态。
 * 实现：worldMinutes 是单调递增的累积分钟（跨天不重置），
 *   让"任意两个时刻"都能纯数字比较；节点上存绝对到期分钟 untilMin。
 * 时间文本里没有 HH:MM 的轮次不推进计数器 → 该轮不做豁免，退回 v2.3.4 行为。
 */

/** 一次推进超过 12 小时 → 视为大跳（换天/长时间跨度），所有人状态一并作废 */
const TIME_JUMP_MIN = 720;

/** 从自由文本里取最后一个 HH:MM → 当天分钟数（0..1439）；取不到返回 null */
export function hhmmToMin(text) {
    const all = String(text || '').match(/(\d{1,2}):(\d{2})/g);
    if (!all || !all.length) return null;
    const m = all[all.length - 1].match(/(\d{1,2}):(\d{2})/);
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
    return h * 60 + mi;
}

/* ---------------- 场景卡解析 / 世界时间校正（v2.3.16） ---------------- */

/**
 * 读正文的场景卡（<SceneInfo>…</SceneInfo>）—— 很多卡用它标注：地点 / 时间 / 在场角色。
 * 这比"名字出现在文本里"精确得多：被台词提一句的人（"让周磊去小卖部拿火腿肠"）不算在场。
 * 返回 { names:[], time:'星期X HH:MM', hm:'HH:MM', location:'' }；没有场景卡时返回 null。
 */
export function parseSceneInfo(text) {
    const m = String(text || '').match(/<SceneInfo>([\s\S]*?)<\/SceneInfo>/i);
    if (!m) return null;
    const body = m[1];
    const out = { names: [], time: '', hm: '', location: '' };
    const loc = body.match(/地点[：:][ \t]*([^\n]+)/);
    if (loc) out.location = loc[1].trim();
    const tm = body.match(/时间[：:][ \t]*([^\n]+)/);
    if (tm) {
        const c = convertSceneTime(tm[1]);
        out.time = c.time;
        out.hm = c.hm;
    }
    const nm = body.match(/在场角色[：:]?[ \t]*([\s\S]*)$/);
    if (nm) {
        nm[1].split(/\r?\n/).forEach((ln) => {
            ln.split(/[、,，]/).forEach((tok) => {
                let s = tok.trim().replace(/^[-*•]\s*/, '').trim();
                if (!s) return;
                s = s.split('|')[0].split(/[（(]/)[0].trim();
                if (s && s.length <= 12) out.names.push(s);
            });
        });
    }
    return (out.names.length || out.time || out.location) ? out : null;
}

/** 场景卡时间 → 世界时间格式："2026年10月15日 周四 下午 15:20" → { time:'星期四 15:20', hm:'15:20' } */
function convertSceneTime(raw) {
    const s = String(raw || '');
    const wd = s.match(/周([一二三四五六日天])/);
    const hm = s.match(/(\d{1,2})[：:](\d{2})/);
    if (!hm) return { time: '', hm: '' };
    let h = Number(hm[1]);
    if (/(下午|晚上|傍晚|夜间)/.test(s) && h < 12) h += 12;
    if (/凌晨/.test(s) && h === 12) h = 0;
    const hhmm = `${String(h).padStart(2, '0')}:${hm[2]}`;
    const week = wd ? `星期${wd[1] === '天' ? '日' : wd[1]}` : '';
    return { time: week ? `${week} ${hhmm}` : hhmm, hm: hhmm };
}

/**
 * 世界时间以正文为准（v2.3.16）：正文场景卡里读到的时间是权威刻度。
 * 模型忘了写 @time、或写得比正文慢时，把世界时钟向前校正到正文时间。
 * 只做 ≤6 小时的前向校正；跨天 / 回退嫌疑不强行拉（交给模型）。
 */
export function syncWorldTime(state, timeText) {
    const t = String(timeText || '').trim();
    if (!t) return false;
    const target = hhmmToMin(t);
    if (target == null) return false;
    const cur = hhmmToMin(state.worldTime);
    if (state.worldMinutes == null || cur == null) {
        state.worldMinutes = target;
        state.worldTime = t;
        return true;
    }
    let diff = target - cur;
    if (diff < 0) diff += 1440;
    if (diff === 0) { state.worldTime = t; return false; }
    if (diff > 360) return false;
    state.worldMinutes += diff;
    state.worldTime = t;
    return true;
}

/** "8:30-9:00" → 开始时刻的当天分钟数（510）；没有明确区间返回 null */
export function rangeStartMin(text) {
    const m = String(text || '').match(/(\d{1,2}):(\d{2})\s*[~\-—－至到]\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
    return h * 60 + mi;
}

/** "8:30-9:00" → 结束时刻的当天分钟数（540）；没有明确区间返回 null */
export function rangeEndMin(text) {
    const m = String(text || '').match(/(\d{1,2}):(\d{2})\s*[~\-—－至到]\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = Number(m[3]);
    const mi = Number(m[4]);
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
    return h * 60 + mi;
}

/** 绝对分钟 → HH:MM（显示用） */
export function minToHHMM(abs) {
    const v = ((Math.round(Number(abs) || 0) % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * 推进世界分钟计数器。
 * 时间没走（同一个 HH:MM）→ 不推进；取不到 HH:MM → 不推进。
 * @returns {{advanced:boolean, jump:boolean}}
 */
function advanceClock(state, newTime) {
    const prevMin = hhmmToMin(state.worldTime);
    const curMin = hhmmToMin(newTime);
    if (curMin == null) return { advanced: false, jump: false };
    if (state.worldMinutes == null || prevMin == null) {
        state.worldMinutes = curMin;   // 首次建立：以当前时刻为起点
        return { advanced: true, jump: false };
    }
    let diff = curMin - prevMin;
    if (diff < 0) diff += 1440;        // 23:50 → 0:10 跨天
    if (diff === 0) return { advanced: false, jump: false };
    state.worldMinutes += diff;
    return { advanced: true, jump: diff > TIME_JUMP_MIN };
}

/** 状态行的时间段 → 绝对到期分钟；没有明确区间返回 null */
export function computeUntil(state, timeText) {
    const endMin = rangeEndMin(timeText);
    if (endMin == null) return null;
    const curMin = hhmmToMin(state.worldTime);
    if (curMin == null || state.worldMinutes == null) return null;
    let delta = endMin - curMin;
    if (delta < 0) delta += 1440;      // 跨天（如 23:00-1:00）
    return state.worldMinutes + delta;
}

/* ---------------- 当前时刻覆盖判定（v2.3.21） ----------------
 * 为什么只看 untilMin 不够：昨晚写的「19:38-21:00」被模型原样重发到今天白天时，
 * computeUntil 会按**当前时刻**重新盖戳 ——「有效到今晚 21:00」。家人就这样把
 * 昨晚的活动（饭后散步 / 敷面膜 / 陪客户喝酒）在状态里挂一整天，谁都不去动他。
 * 修法：有效 = ①绝对到期没过（untilMin，管跨天）+ ②当前时刻落在时间段内
 *   （开始 ≤ 现在 ≤ 结束；开始给 30 分钟提前量 —— 模型爱写整点，别误杀；
 *    跨午夜区间如「23:00-1:00」午夜前后两段都算内）。
 * 解析不出时间段的行退回只看 untilMin 的老行为。
 */
const START_SLACK = 30; // 开始时刻允许的提前量（分钟）

export function statusActive(state, node) {
    if (state.worldMinutes == null || node.untilMin == null) return true; // 没建时钟 / 没时间段 → 老行为
    if (state.worldMinutes > node.untilMin) return false;                // 已越过截止时刻
    const nowTod = hhmmToMin(state.worldTime);
    const s = rangeStartMin(node.time);
    const e = rangeEndMin(node.time);
    if (nowTod == null || s == null || e == null) return true;           // 解析不出区间 → 只看 untilMin
    if (s > e + START_SLACK) {
        // 跨午夜区间：午夜前 ≥ 开始，午夜后 ≤ 结束
        return nowTod >= s || nowTod <= e;
    }
    return nowTod >= s - START_SLACK && nowTod <= e;
}

/** 状态已失效的角色名（越过截止时刻，或时间段不在当前时刻内 —— 都该换新状态） */
export function expiredNames(state) {
    const out = [];
    if (state.worldMinutes == null) return out;
    Object.values(state.nodes || {}).forEach((n) => {
        if (n.archived || n.untilMin == null) return;
        if (!statusActive(state, n) && !out.includes(n.name)) out.push(n.name);
    });
    return out;
}

/** 状态仍在有效期内的角色（带截止时刻，提示词里用来"别动他们"） */
export function validNames(state) {
    const out = [];
    if (state.worldMinutes == null) return out;
    Object.values(state.nodes || {}).forEach((n) => {
        if (n.archived || n.untilMin == null) return;
        if (statusActive(state, n) && !out.some((x) => x.name === n.name)) {
            out.push({ name: n.name, until: minToHHMM(n.untilMin) });
        }
    });
    return out;
}

/** 把一次解析结果（含 @time / @hide / @心线 / @承诺 / @对手）整体应用到 state */
export function applyParsed(state, parsed, floor = 0, opts = {}) {
    if (parsed.worldTime && parsed.worldTime !== state.worldTime) {
        const clock = advanceClock(state, parsed.worldTime);
        // 时间大跳（换天 / 长时间跨度）→ 所有人的状态一并作废，下一轮全量重估
        if (clock.jump) Object.values(state.nodes || {}).forEach((n) => { n.untilMin = 0; });
        state.worldTime = parsed.worldTime;
    }
    if (parsed.hide && parsed.hide.length) state.hidden = parsed.hide.slice();
    const res = applyOps(state, parsed.ops, '~', floor, opts);
    // v2.4.0 攻防生态：心线 / 承诺走独立通道（不进 ops，不吃 freezeTop 的顶层闸）
    res.bonds = applyBondOps(state, parsed.bonds, floor);
    res.commits = applyCommitOps(state, parsed.commits, { floor });
    applyRivalOps(state, parsed.rivals);
    return res;
}

/** 情感类关键词（子分支永远排最前） */
const EMOTION_KEYS = ['老公', '丈夫', '老婆', '未婚夫', '未婚妻', '男友', '女朋友', '女朋友', '情人', '暧昧', '暗恋', '追求', '前男友', '前女友', '炮友', '对象', '恋人', '伴侣'];
const KIN_KEYS = ['父亲', '母亲', '爸爸', '妈妈', '父母', '哥哥', '姐姐', '弟弟', '妹妹', '兄弟', '姐妹', '爷爷', '奶奶', '外公', '外婆', '叔', '阿姨', '姑', '舅'];

function childSortKey(node) {
    const n = node.name || '';
    const txt = n + ' ' + (node.summary || '');
    if (EMOTION_KEYS.some((k) => txt.includes(k))) return 0;
    if (KIN_KEYS.some((k) => txt.includes(k))) return 1;
    return 2;
}

export function childrenOf(state, parentId, includeArchived = false) {
    return Object.values(state.nodes)
        .filter((n) => n.parent === parentId && (includeArchived || !n.archived))
        .sort((a, b) => (childSortKey(a) - childSortKey(b)) || ((a.seq || 0) - (b.seq || 0)));
}

export function topNodes(state) {
    const byId = new Map(state.order.map((id, i) => [id, i]));
    return Object.values(state.nodes)
        .filter((n) => !n.parent)
        .sort((a, b) => (byId.has(a.id) ? byId.get(a.id) : 999) - (byId.has(b.id) ? byId.get(b.id) : 999));
}

/* ---------------- 现场识别（谁正在正文里演） ---------------- */

/**
 * 从最近几层剧情里找出「正在现场的角色」。
 *
 * 用户的诉求：正文里刚刚交互过的角色，不要再被"世界推演"往前推一格——
 * 现场发生的事就按现场写（正文就是现场记录），别的地方的事才交给世界引擎推演。
 *
 * 判定方式（保守，只认高置信的）：
 *   · 最近 N 层（默认 2 层，含用户层）里**被点名出现过**的角色，且
 *   · 该角色当前类别是 交互（未出场、冷却的人不算"在现场"）
 *
 * 返回 Set<name>。
 *
 * @param {object} state
 * @param {{text?:string, floors?:number}} [opts] text=近几层剧情纯文本
 */
export function sceneNames(state, opts = {}) {
    const out = new Set();
    const text = String(opts.text || '');
    if (!text) return out;
    // v2.3.13：扫全部活着的角色，不再只看攻防/交互。
    // 以前只扫这两类 → 建档刚完成时全员【未出场】→ 现场检测永远是空名单
    // → 正在正文里演的角色检测不到（没被保护、也没人翻她的类别）
    // → 模型看得出她在现场、不写她的行 → 她永远停在【未出场】。死锁。
    const alive = Object.values(state.nodes || {}).filter((n) => !n.archived);
    // 同时按"节点名"和"核心名"匹配：节点常带关系前缀（"胡静 > 儿子陈浩宇"），
    // 而正文里只会写"陈浩宇"。只在正文命中「名字」或「核心名」时才算出场。
    const cands = [];
    alive.forEach((n) => {
        const name = n.name;
        const core = coreName(name);
        cands.push({ name, match: name, len: name.length });
        if (core && core !== name) cands.push({ name, match: core, len: core.length });
    });
    // 长的先匹配，避免"陈浩"抢在"陈浩宇"前面
    cands.sort((a, b) => b.len - a.len);
    for (const c of cands) {
        if (!c.match || c.match.length < 2) continue;
        if (!text.includes(c.match)) continue;
        // 短路匹配：命中的其实是另一个更长的人名的一部分 → 不算出场
        // 例：正文写"陈浩宇"，"陈浩" 只是它的子串 → 陈浩并没有在现场
        const swallowedBy = cands.some((o) => (
            o.match !== c.match && o.match.length > c.match.length
            && o.match.includes(c.match) && text.includes(o.match)
        ));
        if (swallowedBy) continue;
        out.add(c.name);
    }
    return out;
}

/** 该角色是不是"现场角色"（正文刚演过） */
export function isScene(state, name, sceneSet) {
    if (!sceneSet || !sceneSet.size) return false;
    return sceneSet.has(name);
}

/**
 * 状态行（v2.3.23）：公开面 —— 时间 · 地点 · 在做什么。
 * 面板展示和上下文注入共用这一种写法（不用 | 竖线堆在一起）。
 * 注意：**不含心情 / 目标** —— 那些是内心面，由调用方决定给不给（防全知）。
 */
export function stateLine(node) {
    const parts = [];
    if (node.time) parts.push(node.time);
    if (node.location) parts.push(node.location);
    if (node.summary) parts.push(node.summary);
    return parts.join(' · ');
}

export function nodeLine(node, opts = {}) {
    const parts = [];
    if (node.time) parts.push(node.time);
    if (node.location) parts.push(node.location);
    if (node.summary) parts.push(node.summary);
    let s = parts.join(' ');
    if (opts.persona) {
        const pl = personaLine(node);
        if (pl) s = s ? `${pl} ｜ ${s}` : pl;
    }
    if (node.mood) s += ` / 心情：${node.mood}`;
    if (node.goal) s += ` / 目标：${node.goal}`;
    if (node.mindset) s += ` / 近况：${node.mindset}`;
    return s;
}

function walk(state, node, lines, depth) {
    const chain = [];
    let cur = node;
    while (cur) { chain.unshift(cur.name); cur = cur.parent ? state.nodes[cur.parent] : null; }
    const path = chain.join(' > ');
    lines.push(`${path} 【${CATEGORY_LABEL[node.category] || '未出场'}】 ${nodeLine(node, { persona: true })}`.trim());
    // v2.4.0 心线：@心线 行紧跟角色行（编辑页原样往返；补漏轮的 serializeSubset 同样带上）
    const bonds = node.bonds || {};
    Object.keys(bonds).forEach((t) => {
        const b = bonds[t];
        if (!b || !Number.isFinite(b.tier)) return;
        lines.push(`@心线 ${node.name}→${t} ${BOND_TIERS[b.tier] || '陌生'}${b.note ? `（依据：${b.note}）` : ''}`);
    });
    // v2.4.0 对手档案：金主/追求者/未婚夫等挂在女主下面的主动方
    if (node.rival && node.parent) {
        const r = node.rival;
        lines.push(`@对手 ${node.name} 手段${r.level || 0}/6${r.lastFloor ? ` · 上次出手第${r.lastFloor}层${r.lastResult ? '：' + r.lastResult : ''}` : ''}`);
    }
    if (depth <= 0) return;
    for (const c of childrenOf(state, node.id, true)) walk(state, c, lines, depth - 1);
}

/**
 * 剧情出现顺序（v2.3.18 引入，v2.3.20 修正主键）
 * 主键 = appearFloor：最近一次**在正文里出场**的楼层。越近越靠前。
 * 没出场过的（appearFloor 空）= 0，排在后面，按建档顺序（seq）。
 *
 * ⚠️ 为什么主键是 appearFloor 而不是 floor：
 * floor 是"世界引擎最后**更新**的楼层" —— 现场登记的人也在更新、背景天天被推演的人
 * 也一样新，用它排序时主键全相等，只能退到 seq（建档顺序），结果"谁先被录入世界"永远
 * 排在"谁最近在戏里"前面（金晶晶先录入就一直压在孙翌童头上）。
 * 现场角色被"现场保护"排除在推演外，本来就不该和后台角色比"引擎更新" —— 要写的是
 * "最近一次在正文里出场"，所以单独用 appearFloor 记录。
 */
export function plotOrderCmp(a, b) {
    const aa = Number(a && a.appearFloor) || 0;
    const bb = Number(b && b.appearFloor) || 0;
    if (aa !== bb) return bb - aa;   // 最近出场的在前
    return ((a && a.seq) || 0) - ((b && b.seq) || 0);
}

/** 按档位分组 + 组内按剧情出现顺序排：给面板和序列化共用，保证两边顺序一致 */
export function groupedTops(state, tops) {
    const list = Array.isArray(tops) ? tops : topNodes(state);
    const out = { interaction: [], cooldown: [], unseen: [] };
    list.forEach((n) => { if (out[n.category]) out[n.category].push(n); else out.unseen.push(n); });
    Object.keys(out).forEach((k) => out[k].sort(plotOrderCmp));
    return out;
}

/** 序列化为协议文本（用于快照、手动编辑、注入给模型） */
export function serialize(state, opts = {}) {
    const onlyVisible = !!opts.onlyVisible;
    const lines = [];
    if (state.worldTime) lines.push(`@time ${state.worldTime}`);
    if (state.hidden && state.hidden.length) lines.push(`@hide ${state.hidden.join('、')}`);
    const tops = topNodes(state).filter((n) => !onlyVisible || !state.hidden.includes(n.name));
    const groups = groupedTops(state, tops);
    for (const cat of CATEGORY_ORDER) {
        for (const t of groups[cat] || []) walk(state, t, lines, 99);
    }
    // 兜底：类别异常的节点也输出，避免丢数据
    const printed = new Set(lines.map((l) => l.split(' 【')[0]));
    for (const t of tops) {
        if (printed.has(t.name)) continue;
        walk(state, t, lines, 99);
    }
    // v2.4.0 承诺：序列化在末尾（编辑页整体替换时按文本重建）
    (state.commitments || []).forEach((c) => {
        if (c.status === 'active') lines.push(`@承诺 +${c.who} 「${c.text}」生效`);
        else if (c.status === 'broken') lines.push(`@承诺 ~${c.who} 已违背「${c.text}」`);
        else lines.push(`@承诺 -${c.who} 已解除「${c.text}」`);
    });
    return lines.join('\n');
}

/** 整篇替换（手动编辑保存用） */
export function replaceFromText(state, text, floor = 0) {
    const parsed = parseLines(text);
    const backupHidden = (state.hidden || []).slice();
    const next = emptyState();
    next.phase = state.phase || 'empty';
    next.seq = state.seq || 0;
    next.worldTime = parsed.worldTime || state.worldTime || '';
    next.timeline = state.timeline || [];
    next.snapshots = state.snapshots || [];
    next.events = state.events || [];
    next.logs = state.logs || [];
    next.archived = state.archived || [];
    next.built = state.built || [];
    next.lastCovered = state.lastCovered || [];
    next.pending = state.pending || [];
    next.drafts = state.drafts || [];
    next.worklogs = state.worklogs || [];
    next.memoryText = state.memoryText || '';
    next.memoryRaw = state.memoryRaw || '';
    next.memoryAt = state.memoryAt || '';
    next.hidden = parsed.hide.length ? parsed.hide : backupHidden;
    applyOps(next, parsed.ops, '~', floor);
    // v2.4.0 攻防生态：编辑页是整体替换语义 —— 心线/对手照文本重建，承诺清空后按文本重建
    applyBondOps(next, parsed.bonds, floor);
    applyCommitOps(next, parsed.commits, { floor, reset: true });
    applyRivalOps(next, parsed.rivals);
    // v2.3.10：编辑页删人后，built / lastCovered 里会残留这些人的名字，
    // 建档页就会一直显示"已整理 24 个"这种幽灵计数。这里按编辑后的实际节点对齐。
    try {
        const alive = new Set(Object.values(next.nodes || {}).map((n) => n.name));
        next.built = (next.built || []).filter((n) => alive.has(n));
        next.lastCovered = (next.lastCovered || []).filter((n) => alive.has(n));
    } catch (e) { /* ignore */ }
    return next;
}
