/**
 * World Engine 世界引擎 - 插件入口
 * 安装：整个文件夹丢进 SillyTavern/public/scripts/extensions/third-party/WorldEngine/
 */
import { getSettings, invalidateSettingsCache, PLUGIN_VERSION } from './config.js';
import { waitAppReady, getContext, getEventSource, getEventTypes, getChatArray, toast } from './core/st.js';
import { getState, commit } from './core/state.js';
import { getChatLength } from './core/chat.js';
import { rollbackToFloor } from './core/snapshot.js';
import { injectIntoPrompt, buildInjectionText } from './core/injector.js';
import { mountUI, refresh, openPanel, closePanel, doBuild, doUpdate, setBusy, isBusy, resetBallPosition, ballDebugInfo } from './ui/panel.js';

let lastKnownFloor = -1;
let lastAutoFloor = -1;
let saving = false;
let updating = false;
let slashRegistered = false;

/**
 * 注册斜杠命令 /we —— 悬浮球之外的第二入口。
 * 手机上悬浮球被挡住 / 拖丢了的时候，在聊天框输入 /we 就能打开面板。
 */
function registerSlashCommand() {
    if (slashRegistered) return true;
    const c = getContext();
    const w = typeof window !== 'undefined' ? window : {};
    const parser = (c && c.SlashCommandParser) || w.SlashCommandParser;
    const cmd = (c && c.SlashCommand) || w.SlashCommand;
    if (!parser || !cmd || typeof parser.addCommandObject !== 'function') return false;
    try {
        parser.addCommandObject(cmd.fromProps({
            name: 'we',
            aliases: ['worldengine'],
            helpString: 'World Engine 世界引擎：/we 打开面板 ｜ /we build 一键建立 ｜ /we update 立即更新 ｜ /we reset 悬浮球归位',
            callback: (args) => {
                const a = String(args || '').trim().toLowerCase();
                if (a === 'build' || a === '建立') { openPanel('build'); doBuild(false); return ''; }
                if (a === 'update' || a === '更新') { openPanel('state'); doUpdate(true); return ''; }
                if (a === 'reset' || a === '归位') { resetBallPosition(); return ''; }
                openPanel();
                return '';
            },
        }));
        slashRegistered = true;
        console.log('[WorldEngine] 已注册斜杠命令：/we');
        return true;
    } catch (e) {
        console.warn('[WorldEngine] 注册 /we 命令失败（不影响面板）', e);
        return false;
    }
}

/** 防止自己触发的生成事件把自己再唤醒一轮（跟随酒馆通道会走官方生成接口，会发 GENERATION_* 事件） */
function guarded(fn) {
    return async (...args) => {
        if (updating) return;
        updating = true;
        try { await fn(...args); } finally { updating = false; }
    };
}

function syncFloor(initial = false) {
    const floor = getChatLength();
    if (!initial && lastKnownFloor >= 0 && floor < lastKnownFloor) {
        // 楼层变少（删楼）。默认**不回退**：删掉前面的楼层不影响世界状态，
        // 需要的时候自己点一次「立即更新」就行。
        const s = getSettings();
        if (s.tracking.autoRollback) {
            const state = getState();
            if (Object.keys(state.nodes || {}).length) {
                const r = rollbackToFloor(state, floor);
                saving = true;
                commit(state);
                saving = false;
                toast(`检测到删楼：${r.msg}`);
                refresh();
            }
        }
    }
    lastKnownFloor = floor;
    return floor;
}

const autoUpdateOnce = guarded(async function maybeAutoUpdate() {
    const s = getSettings();
    if (!s.enabled || !s.autoUpdate) return;
    const chat = getChatArray();
    if (!chat.length) return;
    const last = chat[chat.length - 1];
    if (last && last.is_user) return; // 只等 AI 回复完成
    // 面板正在跑任务（建档/演化/记忆导入）时直接退出，**不消费** lastAutoFloor：
    // 这样 busy 结束后的下一次 AI 回复仍能触发演化，这一轮不会被静默吞掉
    if (isBusy()) return;
    const floor = chat.length;
    if (floor === lastAutoFloor) return;
    lastAutoFloor = floor;
    try {
        await doUpdate(false);
    } catch (e) {
        console.error('[WorldEngine] 自动演化失败', e);
    }
    // 尾随补跑：演化期间到达的新消息事件都被 guarded 丢掉了，
    // 结束后看一眼楼层是不是又前进了，是就补一轮，不让演化"丢楼"
    try {
        const chat2 = getChatArray();
        const last2 = chat2[chat2.length - 1];
        if (chat2.length > lastAutoFloor && !(last2 && last2.is_user) && !isBusy()) {
            setTimeout(() => { autoUpdateOnce(); }, 0);
        }
    } catch (e) { /* ignore */ }
});

function registerEvents() {
    const es = getEventSource();
    const types = getEventTypes();
    if (!es || !types) { console.warn('[WorldEngine] 未取到事件源，功能受限'); return; }

    if (types.APP_READY) es.on(types.APP_READY, () => { invalidateSettingsCache(); mountUI(); syncFloor(true); refresh(); });
    if (types.CHAT_CHANGED) es.on(types.CHAT_CHANGED, () => {
        if (saving) return;
        // 切聊天：楼层数按"初始化"重置——不同聊天的楼层数没有可比性，
        // 直接比会把"新聊天更短"误判成删楼（开着 autoRollback 时会误回退）
        lastAutoFloor = -1;
        invalidateSettingsCache();
        syncFloor(true);
        refresh();
    });
    if (types.CHAT_COMPLETION_PROMPT_READY) es.on(types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        try { injectIntoPrompt(data); } catch (e) { console.error('[WorldEngine] 注入失败', e); }
    });
    if (types.MESSAGE_RECEIVED) es.on(types.MESSAGE_RECEIVED, () => { syncFloor(); autoUpdateOnce(); });
    if (types.GENERATION_ENDED) es.on(types.GENERATION_ENDED, () => { syncFloor(); autoUpdateOnce(); });
    if (types.MESSAGE_DELETED) es.on(types.MESSAGE_DELETED, () => { syncFloor(); refresh(); });
    if (types.MESSAGE_UPDATED) es.on(types.MESSAGE_UPDATED, () => { if (!saving) refresh(); });
}

async function main() {
    console.log(`[WorldEngine] v${PLUGIN_VERSION} 等待酒馆就绪…`);
    await waitAppReady();
    console.log(`[WorldEngine] v${PLUGIN_VERSION} 就绪，挂载入口`);
    mountUI();
    syncFloor(true);
    registerEvents();

    // 斜杠命令的解析器可能比插件晚就绪，重试几次
    let tries = 0;
    const trySlash = () => {
        if (registerSlashCommand() || tries++ >= 12) return;
        setTimeout(trySlash, 1000);
    };
    trySlash();

    // 兜底：万一挂载那一刻 DOM 还没稳，隔几秒再确认一次
    setTimeout(() => { try { mountUI(); } catch (e) { /* ignore */ } }, 2000);
    setTimeout(() => { try { mountUI(); } catch (e) { /* ignore */ } }, 6000);

    // 调试接口
    window.WorldEngine = {
        open: openPanel,
        close: closePanel,
        refresh,
        build: (rebuild = false) => doBuild(rebuild),
        update: () => doUpdate(true),
        state: () => getState(),
        injection: () => buildInjectionText(),
        settings: () => getSettings(),
        setBusy,
        resetBall: () => { resetBallPosition(); return '悬浮球已归位'; },
        ballInfo: () => {
            const text = ballDebugInfo();
            console.log('[WorldEngine] 悬浮球诊断\n' + text);
            return text;
        },
        diagnose: async () => {
            const { runDiagnostics } = await import('./core/diag.js');
            const text = await runDiagnostics();
            console.log('\n[WorldEngine 自检结果]\n' + text);
            toast('自检完成，结果已打印到控制台');
            return text;
        },
    };
    console.log(`[WorldEngine] v${PLUGIN_VERSION} 已加载。\n`
        + '　· 面板：屏幕右下角「世界」悬浮球（可拖动）\n'
        + '　· 找不到球：在聊天输入框输入 /we\n'
        + '　· 控制台：WorldEngine.open() / build() / update() / state() / injection() / diagnose()');
}

main().catch((e) => console.error('[WorldEngine] 初始化失败', e));
