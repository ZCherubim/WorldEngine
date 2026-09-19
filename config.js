/**
 * 全局设置（存在 extensionSettings 里，跨聊天共享）
 * 注意：世界状态数据本身存在 chat_metadata 里，这里只存"设置"
 */
import { getContext } from './core/st.js';

/** 插件版本号：面板顶部会显示，用来确认手机上跑的是不是新版 */
export const PLUGIN_VERSION = '2.3.24';

export const SETTINGS_KEY = 'worldEngine';

export const CATEGORY_KEYS = ['interaction', 'cooldown', 'unseen'];

export const DEFAULT_SETTINGS = {
    enabled: true,          // 总开关
    autoUpdate: true,       // AI 回复后自动演化
    api: {
        mode: 'tavern',     // tavern=跟随酒馆主连接 / auto=有独立API就用、没有或不通就用酒馆 / direct=只用插件里填的独立 API
        tavernProfile: '',  // 酒馆连接管理器里的预设 id；留空=跟随酒馆当前选中的那个
        url: '',            // 独立 API 地址（留空 = 用酒馆主连接）
        key: '',
        model: '',
        modelOptions: [],   // 拉取到的模型列表（下拉选择用）
        temperature: 0.45,
        maxTokens: 4096,
        // 走连接管理器时是否把该连接的预设（提示词 + 参数）也套上。
        // 默认关：预设里的正文格式要求会被整份灌进演化提示词，污染判断。
        includePreset: false,
    },
    allowFallback: true,    // 独立 API 失败时自动改用酒馆主连接
    debug: true,            // 控制台输出请求/返回摘要（排错用）
    tracking: {
        updateDepth: 3,     // 更新参考层数（v2.3.8 起从 4 降到 3）。一层 = 聊天里的一条消息，用户发言和 AI 回复各算一层，3 层通常是 2 条 AI 回复 + 1 条用户发言。正文占输入大头，实测 8K→3.8s、20K→19.5s（非线性），砍输入是最直接的提速
        initDepth: 40,      // 初始化参考层数
        injectionDepth: 2,  // 注入深度（1=只女主 2=含一级子分支 3=全部）
        // v2.3.18：攻防档已删除，只剩 交互 / 冷却 / 未出场 三档。
        // 冷却阈值从 8 提到 20 —— 进过剧情的人不要那么快沉下去（"我明明刚和她聊过，她就消失了"）。
        cooldownThreshold: 20, // 冷却阈值（距上次变动超过 N 层转冷却）
        interactionLimit: 0,  // 交互上限（0 = 不限：档位只表示"和剧情有没有关系"，扩容不花钱 —— mustCoverNames 只看时间片，不看类别）
        autoFill: false,    // 更新后自动补全被漏掉的角色（v2.3.8 起默认关：补全要再发一次完整请求，一次演化变两次，耗时直接叠加。漏掉的角色下一轮会被 mustCover 自动点名补推，不会永久丢；追求覆盖率可手动开）
        fillLimit: 30,      // 单次补全最多点名几个角色
        fillMinMissing: 3,  // 漏掉几人以上才值得再发一次补全请求（1 = 每次都补，最慢）
        batchSize: 3,       // 分批整理时每批几个角色
        autoFallback: false, // 建档时若一个交互都没有，是否自动兜底硬提（默认关：没人就是 0）
        mergeSameName: true, // 同一人挂在多处时共享状态（如"儿子陈浩"与"秘密男友陈浩"）
        mergeDuplicates: true, // 同一人挂在多处时**合并成一处**（关掉就只共享状态、保留多个挂载点）
        sceneGuard: true,    // 现场保护：正文刚演过的角色不再被推演出新一层状态（推荐开）
        sceneDepth: 2,       // 现场保护看最近几层正文
        timeSlot: true,      // 状态有效期：状态行带时间段，没到期就不重复推演（关掉 = 每轮照旧全量重估）
        noteCount: 3,       // 更新时带最近几条工作小结
        autoRollback: false, // 删楼自动回退（默认关：删前文楼层不会动世界状态）
        snapshots: false,   // 是否保存快照（回退关闭后默认不存）
    },
    worldbook: {
        enabled: true,      // 世界书开关
        name: '',           // 手工指定世界书名（留空=自动取角色卡绑定的）
        initFull: true,     // 初始化全量带入
        updateActive: true, // 更新时只带交互档相关的条目（冷却/未出场的不带，省 token）
        selectedUids: [],   // 用户勾选的条目 uid
        selectionMade: false, // false=还没挑过（全部可用）；true 且 selectedUids 为空=一条都不用
        includeNsfw: false, // 整理时是否一并带入 NSFW 条目
        maxChars: 0,        // 单次带入字数软上限，0=不限
        organizeDropOverview: true, // 分批整理时不再重复塞速览（第 1 步已经用过）
    },
    memory: {
        eventLimit: 0,      // 小白X 记忆：带入多少条事件，0=全部
        momentCount: 3,     // 每人轨迹最多带几条最近进展
        maxChars: 20000,    // 记忆文本软上限（每轮演化都会全量重发，默认给个上限防 token 膨胀；0=不限）
        batchEvents: 20,    // 导入时分批：每批多少条事件（0=不分批，一次性塞）
    },
    /**
     * 每轮演化的输入装配开关。
     *
     * 这是"我到底给模型喂了啥"的总控台：每一路输入一个开关，
     * 关掉 = 这一路在提示词里变成一句"（未启用）"，不占 token。
     * 提示词里对应的 {{占位符}} 依然存在，所以你可以自己决定
     * 要不要在自定义提示词里保留、怎么使用。
     *
     * 默认值 = v2.3.2 的行为（全开），升级不改变你已经习惯的输出。
     */
    feed: {
        chat: true,        // {{chat}}        最近 N 层正文
        state: true,       // {{state}}       完整世界状态
        worldinfo: true,   // {{worldinfo}}   命中的世界书条目
        memory: true,      // {{memory}}      外部剧情记忆（小白X 导入）
        notes: true,       // {{recentNotes}} 最近几次的工作小结
        mustCover: true,   // {{mustCover}}   本轮必须覆盖的角色清单
        scene: true,       // {{scene}}       本轮正在现场的角色
        jump: true,        // {{jump}}        上次世界时间 → 现在
        names: true,       // {{user}}/{{char}} 用户与主角名
    },
    writeToChat: {          // 写入正文
        enabled: false,
        auto: false,        // true=不用确认直接写
        topN: 3,            // 只挑最关键的几个角色写入（本轮有变化 > 交互）
        categories: { interaction: true, cooldown: false, unseen: false },
    },
    inject: {               // 上下文注入
        enabled: true,
        persona: true,      // v2.3.23：是否把「角色性格」块也注入（人设参考；关掉省 token）
        skipWritten: true,  // 已写进正文的类别不再注入，避免重复
        position: 'beforeLast', // beforeLast | afterSystem
    },
    prompts: {
        roster: '',         // 第 1 步 建档（认人 + 定性格），留空=内置默认
        organize: '',       // 第 2 步 整理（分批精读世界书）
        update: '',         // 第 3 步 载入剧情（演化）
        init: '',           // 旧版字段，仅作 roster 的兼容回退
    },
    ui: {
        ballX: null,            // 旧字段（当作"宽屏记忆"兼容）
        ballY: null,
        ballWideX: null,        // 桌面/宽屏 记住的位置
        ballWideY: null,
        ballNarrowX: null,      // 手机/窄屏 记住的位置（和桌面分开存，互不干扰）
        ballNarrowY: null,
        tab: 'state',
        // 外观：auto = 跟酒馆明暗自动判定（默认）；light/dark = 强制；st = 跟随酒馆主题配色
        theme: 'auto',
    },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, patch) {
    if (!isObj(patch)) return base;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(patch)) {
        if (isObj(patch[k]) && isObj(out[k])) out[k] = deepMerge(out[k], patch[k]);
        else if (patch[k] !== undefined) out[k] = patch[k];
    }
    return out;
}

function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
}

let cache = null;
// 缓存的是不是"真存档"：false 表示上次调用时 context 还没就绪、拿到的是默认值副本，
// 这种情况下不永久缓存，下次调用重新尝试读存档，避免一整个会话都用脱离存档的默认值
let cacheFromStorage = false;

function settingsRoot() {
    const c = getContext();
    const root = (c && c.extensionSettings) || window.extension_settings || null;
    if (!root) return null;
    if (!root[SETTINGS_KEY]) root[SETTINGS_KEY] = {};
    return root;
}

export function getSettings() {
    if (cache && cacheFromStorage) return cache;
    const root = settingsRoot();
    if (!root) { cache = clone(DEFAULT_SETTINGS); cacheFromStorage = false; return cache; }
    cache = deepMerge(clone(DEFAULT_SETTINGS), root[SETTINGS_KEY] || {});
    cacheFromStorage = true;
    return cache;
}

/** 让设置缓存失效（切聊天 / APP_READY 时调用，防止用到别处的脏缓存） */
export function invalidateSettingsCache() { cache = null; cacheFromStorage = false; }

export function saveSettings() {
    const root = settingsRoot();
    if (root) root[SETTINGS_KEY] = cache;
    const c = getContext();
    try { if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced(); } catch (e) { /* ignore */ }
    try { if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced(); } catch (e) { /* ignore */ }
}

export function resetSettings() {
    cache = clone(DEFAULT_SETTINGS);
    saveSettings();
    return cache;
}
