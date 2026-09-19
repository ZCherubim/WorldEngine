/**
 * World Engine 面板 UI
 * 悬浮球（可拖拽记住位置）+ 页签：世界状态 / 建档 / 条目 / 大事记 / 运行设置 / 提示词 / 日志 / 编辑
 */
import { getSettings, saveSettings, PLUGIN_VERSION } from '../config.js';
import { escapeHtml, toast } from '../core/st.js';
import { getChatLength, getRecentChat } from '../core/chat.js';
import {
    getState, commit, toggleHidden, clearState, pushLog,
    addDraft, updateDraft, removeDraft, clearDrafts, recentWorklogs,
} from '../core/state.js';
import {
    CATEGORY_LABEL, CATEGORY_ORDER, childrenOf, topNodes, serialize, replaceFromText, sameNameGroups,
    personaLine, hasPersona, splitSummary, approvePending, dismissPending, mergeDuplicateMounts,
    expiredNames, validNames, suspectedGroups, mergeSuspected, groupedTops,
    stateLine, PERSONA_ORDER, PERSONA_LABEL,
} from '../core/protocol.js';
import { extractHour, timeOfDay } from '../core/timeline.js';
import { initializeWorld, buildRoster, organizeBatch, finalizeOrganize, probeWorldBook } from '../core/initializer.js';
import { updateWorld, applyMemory } from '../core/updater.js';
import { buildWorldDynamicsLine, writeDynamicsToLatestFloor, removeDynamicsFromLatestFloor } from '../core/chat.js';
import { addManualEvent } from '../core/events.js';
import { callLLM, currentChannel, apiReady, listTavernProfiles, fetchModelList } from '../api/llm.js';
import { getPrompt, resetPrompt, isCustomPrompt, defaultPrompt } from '../core/template.js';
import { loadWorldBook, selectionMade, getWorldBookName, entriesForNames, selectedEntries } from '../core/worldbook.js';
import { lwbToText, COMPACT_INSTRUCTION } from '../core/lwbMemory.js';

let panelEl = null;
let ballEl = null;
let currentTab = 'state';
let busy = false;
let lastDiag = '';
let entryCache = { loaded: false, entries: [] };
let entryLoading = false;
let pickedCharacters = [];
let buildStatus = '';
let logFilter = 'worklog';   // worklog | build | update | all
let memoryDraft = '';        // 记忆输入框里的内容
let memoryInfo = '';         // 记忆解析结果提示
let orgEntryUids = null;     // 第 2 步手动挑的条目 uid；null = 还没挑（按名字自动匹配）
let buildExpanded = false;   // 建档完成后是否手动展开"第 1/2 步"（默认收起）
let pageListenerBound = false;
let pressGuardBound = false; // 按下保护只绑一次（绑在 document 上，和面板生命周期无关）

const EYE_ON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

/* ---------------- 主题检测（避免白底白字） ---------------- */

function parseColor(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
    if (m) {
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a === 0) return null;
        return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    return null;
}

function luminance(rgb) {
    const [r, g, b] = rgb;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 判断酒馆当前是浅色还是深色：取几个可能的背景变量，都不行就看 body 背景 */
function detectLightTheme() {
    try {
        const cs = getComputedStyle(document.body);
        const bgVars = ['--SmartThemeChatTintColor', '--SmartThemeBlurTintColor'];
        for (const v of bgVars) {
            const rgb = parseColor(cs.getPropertyValue(v).trim());
            if (rgb) return luminance(rgb) > 0.6;
        }
        const bodyBg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor);
        if (bodyBg) return luminance(bodyBg) > 0.6;
        // 最后看文字色：深色文字 → 浅色主题
        const fg = parseColor(cs.getPropertyValue('--SmartThemeBodyColor').trim()) || parseColor(cs.color);
        if (fg) return luminance(fg) < 0.5;
    } catch (e) { /* ignore */ }
    return false;
}

/**
 * 外观：
 *   auto  = 自动判定酒馆是明是暗（默认，v2.3.5 之前的行为）
 *   light / dark = 强制
 *   st    = **跟随酒馆主题配色** —— 不再是"我们的面板"，而是从宿主的
 *           --SmartTheme* 变量派生出一整套 token（见 style.css 的 #we-panel.we-st）。
 *           装了任何酒馆主题，面板都跟着走，不再是"两张皮"。
 */
function applyTheme(el) {
    if (!el) return;
    let mode = 'auto';
    try { mode = (getSettings().ui && getSettings().ui.theme) || 'auto'; } catch (e) { /* ignore */ }
    const light = mode === 'light' ? true : mode === 'dark' ? false : detectLightTheme();
    el.classList.toggle('we-light', light);
    el.classList.toggle('we-dark', !light);
    el.classList.toggle('we-st', mode === 'st');
}

/* ---------------- 悬浮球 ---------------- */

const BALL_SIZE = 52;
let ballListenerBound = false;

/**
 * 当前"用户真正能看见"的区域。
 * 手机上布局视口（innerWidth/Height）和可视视口（visualViewport）经常不一样
 * （地址栏收放、缩放、横竖屏），只用 innerHeight 算位置很容易把东西放到屏幕外。
 */
function viewport() {
    const win = (typeof window !== 'undefined') ? window : null;
    const doc = (typeof document !== 'undefined' && document.documentElement) || {};
    const layoutW = (win && win.innerWidth) || doc.clientWidth || 360;
    const layoutH = (win && win.innerHeight) || doc.clientHeight || 640;
    const vv = win && win.visualViewport ? win.visualViewport : null;
    const vvW = vv && vv.width ? vv.width : layoutW;
    const vvH = vv && vv.height ? vv.height : layoutH;
    // 取小的那个：布局视口比可视视口宽时用可视的；缩得很小时别用超大的可视宽度
    const w = Math.min(layoutW, vvW) || layoutW;
    const h = Math.min(layoutH, vvH) || layoutH;
    const offX = vv && Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0;
    const offY = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
    return { w, h, offX, offY, layoutW, layoutH };
}

/** 把球限制在当前可见范围内；返回是否做了修正（改过就说明原来跑到屏幕外了） */
function clampBallPos(el) {
    if (!el) return false;
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
    const { w, h, offX, offY } = viewport();
    const size = el.offsetWidth || BALL_SIZE;
    const nl = Math.max(offX + 4, Math.min(offX + Math.max(4, w - size - 4), left));
    const nt = Math.max(offY + 4, Math.min(offY + Math.max(4, h - size - 4), top));
    if (Math.round(nl) === Math.round(left) && Math.round(nt) === Math.round(top)) return false;
    el.style.left = `${Math.round(nl)}px`;
    el.style.top = `${Math.round(nt)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return true;
}

/** 窄屏（手机）判定：按可视宽度，不按媒体查询（手机上布局视口有时比 560 还宽） */
function isNarrowScreen() {
    return viewport().w <= 600;
}

/** 位置存两套：桌面一套、手机一套 —— 在电脑上拖过不会影响手机上的位置（反之亦然） */
function ballSlot(narrow) {
    return narrow ? ['ballNarrowX', 'ballNarrowY'] : ['ballWideX', 'ballWideY'];
}

function saveBallPos(el) {
    if (!el) return;
    const st = getSettings();
    const narrow = isNarrowScreen();
    const [kx, ky] = ballSlot(narrow);
    let x = parseFloat(el.style.left);
    let y = parseFloat(el.style.top);
    const r = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
    if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) { x = r.left; y = r.top; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    st.ui[kx] = Math.round(x);
    st.ui[ky] = Math.round(y);
    if (!narrow) { st.ui.ballX = Math.round(x); st.ui.ballY = Math.round(y); } // 兼容旧字段
    saveSettings();
}

/** 读当前设备类别下记住的位置；不可用（跑到屏幕外/没有）返回 null */
function readSavedBall() {
    const s = getSettings();
    const narrow = isNarrowScreen();
    const [kx, ky] = ballSlot(narrow);
    let x = s.ui[kx];
    let y = s.ui[ky];
    if ((x == null || y == null) && !narrow && s.ui.ballX != null && s.ui.ballY != null) {
        x = s.ui.ballX; y = s.ui.ballY;   // 老版本只存过这一份，当作桌面位置
    }
    if (x == null || y == null) return null;
    x = Number(x); y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const { w, h, offX, offY } = viewport();
    const size = BALL_SIZE;
    // 至少有 24px 落在可见区域内才认这个坐标
    const visW = Math.min(x + size, offX + w) - Math.max(x, offX);
    const visH = Math.min(y + size, offY + h) - Math.max(y, offY);
    if (visW < 24 || visH < 24) return null;
    return { x, y };
}

function persistBallPos(el) {
    saveBallPos(el);
}

/** 用 JS 直接算出"右下角"坐标 —— 完全不依赖 CSS 的 max()/env()
 *  （部分手机浏览器不认这些新语法，会把整条声明丢掉，球就没了偏移、落到文档末尾 → 就是"看不到悬浮球"）
 */
function placeBallDefault(el) {
    if (!el) return;
    const { w, h, offX, offY } = viewport();
    const size = el.offsetWidth || BALL_SIZE;
    el.style.left = `${Math.max(offX + 4, Math.round(offX + w - size - 12))}px`;
    el.style.top = `${Math.max(offY + 4, Math.round(offY + h - size - 130))}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

/** 用 JS 把关键样式写死成内联 —— 就算手机上 style.css 是旧缓存、或某些新语法被丢掉，球也一定能看见 */
function applyBallInlineStyles(el) {
    if (!el || !el.style) return;
    const st = el.style;
    st.position = 'fixed';
    st.zIndex = '100003';
    st.display = 'flex';
    st.alignItems = 'center';
    st.justifyContent = 'center';
    st.width = '52px';
    st.height = '52px';
    st.borderRadius = '50%';
    st.color = '#ffffff';
    st.fontSize = '12px';
    st.fontWeight = '600';
    st.letterSpacing = '1px';
    st.background = 'linear-gradient(135deg,#4f6ef7,#8b5bff)';
    st.boxShadow = '0 6px 18px rgba(0,0,0,.35)';
    st.cursor = 'grab';
    st.userSelect = 'none';
    st.touchAction = 'none';
    st.pointerEvents = 'auto';
    st.opacity = '1';
    st.visibility = 'visible';
    // 位置一律由 JS 算，别让旧的 CSS 规则（right/bottom）掺和进来
    st.right = 'auto';
    st.bottom = 'auto';
    st.margin = '0';
    st.padding = '0';
}

/**
 * 面板几何：全部用 JS 算成像素写进 inline-style。
 * 不依赖 vh/dvh/max()/env()/transform —— 手机上踩过的坑全在这里。
 *
 * 手机：贴可视区顶部 + 固定像素高度（内容整块滚动、表头吸顶），保证页签一定看得见。
 * 电脑：宽度 620、高度按内容自适应（上限 86% 视口高），垂直居中 —— render() 后会再精修一次。
 */
function applyPanelGeometry(el) {
    if (!el || !el.style) return;
    const { w, h, offX, offY } = viewport();
    const st = el.style;
    const narrow = w <= 600;
    const maxH = Math.max(240, Math.round(h * (narrow ? 0.92 : 0.86)));

    st.position = 'fixed';
    st.zIndex = '100001';
    st.margin = '0';
    st.transform = 'none';
    st.display = 'flex';
    st.flexDirection = 'column';
    st.boxSizing = 'border-box';
    st.bottom = 'auto';
    st.maxHeight = `${maxH}px`;

    if (narrow) {
        st.left = `${Math.round(offX)}px`;
        st.right = 'auto';
        st.width = `${Math.round(w)}px`;
        st.maxWidth = 'none';
        st.height = `${maxH}px`;                 // 固定高度：整块滚动，怎么算都不会把按钮挤没
        st.top = `${Math.round(offY + Math.max(0, h - maxH))}px`;
        st.marginLeft = '0';
        st.marginRight = '0';
        st.borderRadius = '14px';
    } else {
        st.left = '0';
        st.right = '0';
        st.width = 'auto';
        st.maxWidth = '620px';
        st.height = 'auto';                      // 内容自适应
        st.top = `${Math.round(offY + Math.max(0, (h - maxH) / 2))}px`;
        st.marginLeft = 'auto';
        st.marginRight = 'auto';
        st.borderRadius = '14px';
    }
    el.classList.toggle('we-mobile', narrow);
}

/** 电脑端：按真实内容高度再垂直居中一次（内容短的时候居中最舒服） */
function recenterPanel() {
    if (!panelEl || !panelEl.style) return;
    if (panelEl.classList.contains('we-mobile')) return;   // 手机端贴顶，不动
    try {
        const { h, offY } = viewport();
        const maxH = parseFloat(panelEl.style.maxHeight) || h;
        const r = panelEl.getBoundingClientRect();
        const used = Math.max(120, Math.min((r && r.height) || maxH, maxH));
        panelEl.style.top = `${Math.round(offY + Math.max(0, (h - used) / 2))}px`;
    } catch (e) { /* ignore */ }
}

/** 球现在到底可不可见（不在视口内 / 尺寸为 0 都算不可见） */
function ballLooksVisible(el) {
    try {
        if (!document.body || !document.body.contains(el)) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width < 8 || r.height < 8) return false;
        const { w, h, offX, offY } = viewport();
        if (r.right < offX || r.bottom < offY) return false;
        if (r.left > offX + w || r.top > offY + h) return false;
        // 至少要有 20px 落在可见区域里
        const visW = Math.min(r.right, offX + w) - Math.max(r.left, offX);
        const visH = Math.min(r.bottom, offY + h) - Math.max(r.top, offY);
        return visW >= 20 && visH >= 20;
    } catch (e) { return true; }
}

/** 悬浮球几何信息（手机上没法开控制台时，用面板里的「诊断」按钮把它们显示出来） */
export function ballDebugInfo() {
    const el = document.getElementById('we-ball');
    const { w, h, offX, offY, layoutW, layoutH } = viewport();
    const lines = [];
    lines.push(`视口：可视 ${w}×${h}${offX || offY ? `（偏移 ${offX},${offY}）` : ''} ｜ 布局 ${layoutW}×${layoutH}`);
    if (!el) { lines.push('悬浮球：**DOM 里不存在**（挂载失败）'); return lines.join('\n'); }
    const r = el.getBoundingClientRect();
    lines.push(`球位置：left ${Math.round(r.left)} / top ${Math.round(r.top)}　尺寸 ${Math.round(r.width)}×${Math.round(r.height)}`);
    lines.push(`球是否可见：${ballLooksVisible(el) ? '是' : '否'}`);
    lines.push(`内部样式：left=${el.style.left || '—'} top=${el.style.top || '—'} right=${el.style.right || '—'} bottom=${el.style.bottom || '—'}`);
    return lines.join('\n');
}

/** 回到默认位置（右下角）。只清当前设备类别的那一份记忆。 */
export function resetBallPosition(save = true) {
    const st = getSettings();
    const narrow = isNarrowScreen();
    const [kx, ky] = ballSlot(narrow);
    st.ui[kx] = null;
    st.ui[ky] = null;
    if (!narrow) { st.ui.ballX = null; st.ui.ballY = null; }   // 兼容旧字段
    if (save) saveSettings();
    const el = document.getElementById('we-ball');
    if (el) {
        el.style.left = '';
        el.style.top = '';
        el.style.right = '';
        el.style.bottom = '';
        applyBallInlineStyles(el);
        placeBallDefault(el);
        if (!ballLooksVisible(el)) console.warn('[WorldEngine] 归位后球仍不可见，请把这条日志发我', el.getBoundingClientRect());
    }
    toast('悬浮球已回到默认位置（右下角）');
}

/** 已挂载时重新校正位置（切屏、横竖屏切换后调用） */
export function ensureBallVisible() {
    const el = document.getElementById('we-ball');
    if (!el) return false;
    if (clampBallPos(el)) persistBallPos(el);
    return true;
}

function bindBallGlobalListeners() {
    if (ballListenerBound || typeof window.addEventListener !== 'function') return;
    ballListenerBound = true;
    // 防抖：连续 resize（拖窗口边框 / 手机地址栏收放）只做一次复查，
    // 不然每个中间尺寸都排一个 setTimeout 跑 clamp + 强制回流
    let recheckTimer = null;
    const recheck = () => {
        if (recheckTimer) clearTimeout(recheckTimer);
        recheckTimer = setTimeout(() => {
            recheckTimer = null;
            ensureBallVisible();
            if (panelEl) applyPanelGeometry(panelEl);   // 面板开着时也跟着视口走
        }, 200);
    };
    window.addEventListener('resize', recheck);
    window.addEventListener('orientationchange', recheck);
    // 手机地址栏收放 / 缩放：visualViewport 会变，但 window.resize 不一定会触发
    const vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === 'function') {
        vv.addEventListener('resize', recheck);
        vv.addEventListener('scroll', recheck);
    }
    // 从后台切回来（bfcache）也复查一次
    window.addEventListener('pageshow', recheck);
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
    }
}

export function mountUI() {
    // v2.3.4：整个挂载流程包进 try/catch。
    // 球是插件的唯一入口——挂载流程里任何一步炸了，用户看到的就是"整个插件消失了"。
    // 兜底球不依赖任何辅助函数、全部内联样式，只要 document.body 在就能挂上。
    try {
        mountUIInner();
    } catch (e) {
        console.error('[WorldEngine] 悬浮球挂载流程出错，走兜底方案：', e);
        try { emergencyBall(); } catch (e2) { console.error('[WorldEngine] 兜底球也失败：', e2); }
    }
}

/**
 * 兜底球（v2.3.4）：挂在左上角，纯内联样式，点击开面板。
 * 只有正常挂载流程抛错时才会出现它——出现即说明有 bug，
 * 控制台红字里能看到原因。宁可丑，不能没有。
 */
function emergencyBall() {
    if (document.getElementById('we-ball')) return;
    if (!document.body) return;
    const el = document.createElement('div');
    el.id = 'we-ball';
    el.textContent = '世界';
    el.title = 'World Engine（兜底模式，点击打开面板）';
    el.setAttribute('role', 'button');
    el.style.cssText = 'position:fixed;left:16px;top:16px;width:56px;height:56px;border-radius:50%;'
        + 'background:#7c5cff;color:#fff;display:flex;align-items:center;justify-content:center;'
        + 'font-size:15px;font-weight:600;z-index:100003;cursor:pointer;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none;';
    el.addEventListener('click', () => {
        try { openPanel(); } catch (err) { console.error('[WorldEngine] 打开面板失败', err); }
    });
    document.body.appendChild(el);
    ballEl = el;
    console.warn('[WorldEngine] 已挂载兜底悬浮球（屏幕左上角）。正常球不该走这条路，请把上面的红字发给开发者。');
}

function mountUIInner() {
    bindBallGlobalListeners();
    if (document.getElementById('we-ball')) { ensureBallVisible(); return; }
    const el = document.createElement('div');
    el.id = 'we-ball';
    el.textContent = '世界';
    el.title = 'World Engine 世界引擎\n· 单击打开面板\n· 按住可拖动位置（桌面和手机分别记）';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', '打开 World Engine 世界引擎面板');
    // 键盘可达（v2.3.6）：Tab 能聚焦到球，Enter / 空格打开面板
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
            ev.preventDefault();
            try { openPanel(); } catch (err) { console.error('[WorldEngine] 打开面板失败', err); }
        }
    });
    applyBallInlineStyles(el);   // 关键样式内联：不依赖 style.css 有没有被正确加载

    // 记住的位置只在"当前屏幕上还看得见"时才用（而且桌面/手机分开存）
    const saved = readSavedBall();
    if (saved) {
        el.style.left = `${saved.x}px`;
        el.style.top = `${saved.y}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }

    /* ---------------- 拖动 ----------------
     * 关键：move / up 事件绑在 document 上，**不绑在球上**。
     * 绑在球上的话，鼠标一快、球没跟上、光标离开球的那 52px，事件就断了 ——
     * 电脑上就是"拖不动"，而手机上 touchmove 会一直投给 touchstart 的元素，
     * 所以手机反而正常。这一条就是电脑端拖不动的根因。
     */
    let dragging = false; let moved = false; let sx = 0; let sy = 0; let ox = 0; let oy = 0;
    let lastTouchAt = 0; let activePointerId = null;

    const pointOf = (e) => {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    };
    const endDrag = () => {
        try { document.body.style.userSelect = ''; } catch (err) { /* ignore */ }
        el.style.cursor = 'grab';
    };
    const onDown = (e) => {
        if (e.button !== undefined && e.button !== null && e.button !== 0) return;  // 只认左键
        dragging = true; moved = false;
        const p = pointOf(e);
        sx = p.x; sy = p.y;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top;
        activePointerId = (e.pointerId !== undefined) ? e.pointerId : null;
        el.classList.add('we-dragging');
        el.style.cursor = 'grabbing';
        try { document.body.style.userSelect = 'none'; } catch (err) { /* ignore */ }
        if (activePointerId !== null) { try { el.setPointerCapture(activePointerId); } catch (err) { /* ignore */ } }
        if (typeof e.preventDefault === 'function') e.preventDefault();
    };
    const onMove = (e) => {
        if (!dragging) return;
        // 多指触摸时只看第一根手指
        const p = pointOf(e);
        const dx = p.x - sx; const dy = p.y - sy;
        if (!moved && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;   // 4px 容差，避免"手抖也算拖动"
        moved = true;
        const { w, h, offX, offY } = viewport();
        const size = el.offsetWidth || BALL_SIZE;
        const nx = Math.max(offX, Math.min(offX + Math.max(0, w - size), ox + dx));
        const ny = Math.max(offY, Math.min(offY + Math.max(0, h - size), oy + dy));
        el.style.left = `${Math.round(nx)}px`; el.style.top = `${Math.round(ny)}px`;
        el.style.right = 'auto'; el.style.bottom = 'auto';
        if (typeof e.preventDefault === 'function') e.preventDefault();
    };
    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        moved = moved || false;
        el.classList.remove('we-dragging');
        endDrag();
        if (moved) {
            persistBallPos(el);
            console.log('[WorldEngine] 悬浮球位置已记住：', el.style.left, el.style.top, isNarrowScreen() ? '（手机）' : '（桌面）');
        } else {
            togglePanel();      // 没移动 = 点击
        }
    };
    const onCancel = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('we-dragging');
        endDrag();
    };
    const onUpMouse = () => {
        // 触屏兜底：老浏览器在 touchend 之后还会补一对 mouse 事件，别处理两次
        if (Date.now() - lastTouchAt < 700) return;
        onUp();
    };

    const hasPointer = typeof window !== 'undefined' && ('PointerEvent' in window);
    if (hasPointer) {
        el.addEventListener('pointerdown', onDown);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
    } else {
        el.addEventListener('touchstart', (e) => { lastTouchAt = Date.now(); onDown(e); }, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', () => { lastTouchAt = Date.now(); onUp(); });
        document.addEventListener('touchcancel', onCancel);
        el.addEventListener('mousedown', onDown);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUpMouse);
    }
    // 拖动中浏览器失焦（比如 Alt+Tab、拖到外面松手）→ 结束拖动，别卡在拖拽态
    if (typeof window.addEventListener === 'function') window.addEventListener('blur', onCancel);

    // 双保险：球必须挂在 body 上（body 还没出来就重试）
    const attach = (tries = 0) => {
        if (document.getElementById('we-ball')) return;
        if (!document.body) {
            if (tries < 20) setTimeout(() => attach(tries + 1), 150);
            else console.warn('[WorldEngine] 找不到 document.body，悬浮球挂不上');
            return;
        }
        document.body.appendChild(el);
        ballEl = el;
        if (!saved) placeBallDefault(el);              // 首次/没记住：JS 直接算，不赌 CSS 语法
        else if (clampBallPos(el)) persistBallPos(el); // 有记住的位置：拉回可见范围

        // 挂载后隔几个时间点复查（手机地址栏收放、首次布局完成都可能改变视口）
        [120, 500, 1500, 3500].forEach((delay) => {
            setTimeout(() => {
                if (document.getElementById('we-ball') !== el) return;
                if (ballLooksVisible(el)) return;
                console.warn('[WorldEngine] 悬浮球不可见，强制归位。位置：', el.getBoundingClientRect());
                const st = getSettings();
                st.ui.ballX = null;               // 丢掉坏坐标，永远走默认位置
                st.ui.ballY = null;
                saveSettings();
                applyBallInlineStyles(el);
                placeBallDefault(el);
            }, delay);
        });

        if (!ballLooksVisible(el)) {
            console.warn('[WorldEngine] 悬浮球挂载后立刻判定不可见，先归位一次');
            placeBallDefault(el);
        }
        console.log('[WorldEngine] 悬浮球已挂载（屏幕右下角，可拖动）。看不到就在聊天框输入 /we 打开面板，或 /we reset 归位。');
    };
    attach();
}

export function setBusy(v, label) {
    busy = v;
    if (ballEl) {
        ballEl.classList.toggle('we-busy', v);
        ballEl.textContent = v ? (label || '···') : '世界';
    }
}

/**
 * 悬浮球状态角标：成功 ✓ / 失败 ✕，几秒后自动消失。
 * 角标与推演光环都用**伪元素**承载 —— 球的 DOM 结构不动（这地方出过事故：
 * 结构一动球就没了），伪元素不影响 textContent 和拖拽逻辑。
 */
let ballBadgeTimer = null;
export function flashBall(kind, ms) {
    if (!ballEl) return;
    ballEl.classList.remove('we-ok', 'we-err');
    void ballEl.offsetWidth;                 // 强制重排，连续两次同位角标也能重放动画
    ballEl.classList.add(kind === 'err' ? 'we-err' : 'we-ok');
    if (ballBadgeTimer) clearTimeout(ballBadgeTimer);
    ballBadgeTimer = setTimeout(() => {
        if (ballEl) ballEl.classList.remove('we-ok', 'we-err');
    }, Number(ms) || (kind === 'err' ? 6000 : 4000));
}

/**
 * 屏幕顶部状态横幅：显示几秒后淡出。
 * 悬浮球只做"在跑 / 成功 / 失败"的极简反馈，具体文字走这里 —— 不挤在球上，
 * 也不占面板（面板关着的时候也知道插件在干嘛）。
 */
let topStatusTimer = null;
export function showTopStatus(text, isError) {
    if (!document.body || !text) return;
    let el = document.getElementById('we-top-status');
    if (!el) {
        el = document.createElement('div');
        el.id = 'we-top-status';
        document.body.appendChild(el);
    }
    el.textContent = String(text);
    el.classList.toggle('we-err', !!isError);
    el.classList.add('we-show');
    if (topStatusTimer) clearTimeout(topStatusTimer);
    topStatusTimer = setTimeout(() => { el.classList.remove('we-show'); }, 5200);
}

/** 面板是否正在跑任务（建档/演化/记忆导入）。index.js 的自动演化靠它避免丢轮次 */
export function isBusy() {
    return busy;
}

/* ---------------- 面板 ---------------- */

export function togglePanel() {
    if (panelEl && document.body.contains(panelEl)) closePanel();
    else openPanel();
}

export function openPanel(tab) {
    const s = getSettings();
    currentTab = tab || s.ui.tab || 'state';
    if (panelEl && document.body.contains(panelEl)) { render(); return; }

    panelEl = document.createElement('div');
    panelEl.id = 'we-panel';
    panelEl.innerHTML = `
        <div class="we-timebar" id="we-timebar">
            <span class="we-tb-title">World Engine <span class="we-ver">v${escapeHtml(PLUGIN_VERSION)}</span> <span class="we-dot" id="we-tb-dot" title="引擎状态"></span></span>
            <span class="we-tb-time" id="we-tb-time"></span>
            <span class="we-close" data-act="close" title="关闭">&times;</span>
        </div>
        <div class="we-tabs">
            <button data-tab="state">世界状态<span class="we-tab-dot" data-dot="state"></span></button>
            <button data-tab="build">建档</button>
            <button data-tab="entries">条目</button>
            <button data-tab="events">大事记</button>
            <button data-tab="settings">运行设置</button>
            <button data-tab="prompts">提示词</button>
            <button data-tab="logs">日志</button>
            <button data-tab="edit">编辑</button>
        </div>
        <div class="we-body" id="we-body"></div>
        <div class="we-footer">
            <button class="we-primary" id="we-fbtn-build" data-act="build">一键建立</button>
            <button data-act="goto-build">分步建档</button>
            <button id="we-fbtn-update" data-act="update">立即更新</button>
            <button data-act="write">注入正文</button>
            <button data-act="edit">编辑</button>
        </div>
    `;
    document.body.appendChild(panelEl);
    lastBodyHtml = '';        // 面板是新建的，body 是空的 —— 不清缓存会渲染成空白页
    applyPanelGeometry(panelEl);      // 几何全部由 JS 算成像素，不赌 CSS
    if (ballEl) ballEl.style.display = 'none';   // 面板开着时先把球收起来，免得叠在一起
    ensureBackdrop();
    applyTheme(panelEl);
    panelEl.addEventListener('click', onClick);
    panelEl.addEventListener('change', onChange);
    bindPressGuard();
    bindPageListeners();
    // 电脑上按 Esc 关面板
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', onPanelKeydown);
    render();
}

/**
 * 从后台切回来 / 页面恢复时重渲染一次。
 * 手机浏览器切走再切回来，DOM 有时会和渲染状态不同步（"上面切了页签、下面没换"），
 * 这里强制刷一遍，保证看到的和 state 一致。
 */
function bindPageListeners() {
    if (pageListenerBound || typeof document === 'undefined') return;
    pageListenerBound = true;
    const kick = () => { if (panelEl && document.body && document.body.contains(panelEl)) render(); };
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(kick, 60); });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pageshow', () => setTimeout(kick, 60));
        window.addEventListener('focus', () => setTimeout(kick, 120));
    }
}

/**
 * 按下保护（v2.3.19 → v2.3.20 修 bug）：手指按下的那一刻起，暂停一切重渲染，抬起再补。
 * 这样"建档 / 忽略"这类按钮从 pointerdown 到 click 之间，DOM 绝不会被换掉。
 *
 * ⚠️ 事件时序的坑（v2.3.19 踩过）：浏览器里 pointerup 在 click **之前**派发。
 * 如果在 pointerup 里同步重建 DOM，按钮会在 click 派发前一刻被换掉 —— click 还是丢。
 * 所以抬起后**不立刻渲染**，只把 queued 的渲染挪到 setTimeout(...,0)：
 * 让 click 事件先派发完，下一帧再补渲染。这是"偶发竞态"和"必现 bug"的区别。
 */
let pressResetTimer = null;
function bindPressGuard() {
    if (pressGuardBound || typeof document === 'undefined') return;
    pressGuardBound = true;
    const down = () => {
        pressing = true;
        if (pressResetTimer) clearTimeout(pressResetTimer);
        // 兜底：5 秒还没抬手，强制解除（长按、异常中断都不会把渲染卡死）
        pressResetTimer = setTimeout(() => {
            pressing = false;
            if (renderQueued) { renderQueued = false; try { render(true); } catch (e) { /* ignore */ } }
        }, 5000);
    };
    const up = () => {
        pressing = false;
        if (pressResetTimer) { clearTimeout(pressResetTimer); pressResetTimer = null; }
        if (renderQueued) {
            renderQueued = false;
            // 关键：延迟到 click 派发之后再渲。同步渲染会把按钮换掉，click 照样丢。
            setTimeout(() => { try { render(true); } catch (e) { /* ignore */ } }, 0);
        }
    };
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('pointerdown', down, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
        // 老 webview（尤其手机内置浏览器）可能没有 pointer 事件
        document.addEventListener('touchstart', down, true);
        document.addEventListener('touchend', up, true);
        document.addEventListener('touchcancel', up, true);
        document.addEventListener('mousedown', down, true);
        document.addEventListener('mouseup', up, true);
    }
}

/** 面板开着时的键盘快捷键（目前就 Esc） */
function onPanelKeydown(e) {
    if (!panelEl) return;
    const k = e && (e.key || e.keyCode);
    if (k === 'Escape' || k === 'Esc' || k === 27) closePanel();
}

/** 半透明遮罩：把面板和页面隔开，手机上点一下空白处就能关 */
function ensureBackdrop() {
    let bd = document.getElementById('we-backdrop');
    if (!bd) {
        bd = document.createElement('div');
        bd.id = 'we-backdrop';
        bd.addEventListener('click', () => closePanel());
        document.body.appendChild(bd);
    }
    return bd;
}

function removeBackdrop() {
    const bd = document.getElementById('we-backdrop');
    if (bd && bd.parentNode) bd.parentNode.removeChild(bd);
}

export function closePanel() {
    removeBackdrop();
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
    if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onPanelKeydown);
    if (ballEl) ballEl.style.display = 'flex';   // 面板关了，把球放出来
}

export function refresh() {
    if (panelEl && document.body.contains(panelEl)) render();
}

const TAB_RENDERERS = {
    state: () => renderState(),
    build: () => renderBuild(),
    entries: () => renderEntries(),
    events: () => renderEvents(),
    settings: () => renderSettings(),
    prompts: () => renderPrompts(),
    logs: () => renderLogs(),
    edit: () => renderEdit(),
};

/**
 * 页签红点：有「待审新角色」时在「世界状态」页签上亮一个点。
 * 以前这批人只写在状态页里，用户不点进去就不知道有人在等他审批。
 */
function updateTabDots(state) {
    if (!panelEl) return;
    const pending = (state && state.pending ? state.pending.length : 0) || 0;
    const dot = panelEl.querySelector('[data-dot="state"]');
    if (!dot) return;
    dot.classList.toggle('we-on', pending > 0);
    dot.title = pending ? `有 ${pending} 个新角色待审` : '';
}

/**
 * 底部按钮主次随阶段走（v2.3.10）：
 *   建档期（empty/roster/organizing）→「一键建立」是主按钮
 *   运行期（running）→ 日常用的是「立即更新」，把它提成主按钮，
 *   一键建立降级（再点会弹确认，防误触重跑整套建档烧调用）
 */
function updateFooterButtons(state) {
    if (!panelEl) return;
    const bBuild = panelEl.querySelector('#we-fbtn-build');
    const bUpdate = panelEl.querySelector('#we-fbtn-update');
    if (!bBuild || !bUpdate) return;
    const running = !!state && state.phase === 'running';
    bBuild.classList.toggle('we-primary', !running);
    bUpdate.classList.toggle('we-primary', running);
}

/**
 * 渲染（v2.3.19 加固：待审按钮点不动的根治）
 *
 * 病因：body.innerHTML = fn() 是**整页重建**。浏览器规则是 —— 按下和抬起之间
 * 如果按钮节点被换掉，click 事件根本不会派发（click 派发在 down/up 目标的最近公共祖先上）。
 * 演化结束、MESSAGE_UPDATED、切回前台都会触发重建，所以用户手指按在「建档」上时
 * 正好一次重建 → 点击无声死亡，体感就是"按钮按不了"。
 *
 * 两层防御：
 *   ① 内容没变就完全不重建（绝大多数 refresh 其实是空转，根本不需要动 DOM）；
 *   ② 手指还按着时，把渲染排队，抬手再补 —— 保证按下到抬起之间 DOM 绝不动。
 */
let lastBodyHtml = '';
let pressing = false;
let renderQueued = false;

function render(force) {
    if (!panelEl) return;
    // ② 手指按着 → 排队，等抬起再渲（force 用于切页签这种必须立刻生效的）
    if (pressing && !force) { renderQueued = true; return; }
    // 面板被别的脚本挪走 / 移出 DOM 时，先挂回来，否则后面全是在改一个看不见的节点
    if (typeof document !== 'undefined' && document.body && !document.body.contains(panelEl)) {
        try { document.body.appendChild(panelEl); } catch (e) { /* ignore */ }
    }
    try { applyTheme(panelEl); } catch (e) { /* ignore */ }
    try { updateFooterButtons(getState()); } catch (e) { /* ignore */ }
    try { updateTabDots(getState()); } catch (e) { /* ignore */ }
    const s = getSettings();
    if (s.ui.tab !== currentTab) { s.ui.tab = currentTab; saveSettings(); }
    try {
        panelEl.querySelectorAll('.we-tabs button').forEach((b) => {
            b.classList.toggle('we-active', b.dataset.tab === currentTab);
        });
    } catch (e) { /* ignore */ }
    try { updateTimeBar(); } catch (e) { /* ignore */ }

    const body = panelEl.querySelector('#we-body');
    if (!body) return;   // 面板结构被破坏了，直接放弃（至少别抛错）
    const fn = TAB_RENDERERS[currentTab] || TAB_RENDERERS.state;
    // 折叠状态快照：innerHTML 重建会把 <details> 的展开态清掉，
    // 用户手动展开过的子分支在每次 refresh 后都自动收回，体验很差。先记再还原。
    const openFolds = readOpenFolds(body);
    // 滚动位置快照（v2.3.14）：整页重建会把滚动位置清回顶部。
    // 切换页签时不保留（新页签从顶部看起），同一页签内刷新时保留。
    const keepScroll = (panelEl.dataset.lastTab === currentTab) ? body.scrollTop : 0;
    try {
        // ① 内容没变就别动 DOM —— 这一步本身就消灭了绝大多数"按钮被换掉"的机会
        const html = fn();
        if (force || html !== lastBodyHtml) {
            lastBodyHtml = html;
            panelEl.dataset.lastTab = currentTab;
            body.innerHTML = html;
            body.scrollTop = keepScroll;
        }
    } catch (err) {
        // 关键：单个页签渲染失败，绝不能让它把整个面板卡死
        // （以前就是 renderState 抛错 → 页签高亮变了、下面还停在旧页面）
        console.error('[WorldEngine] 页签渲染失败：', currentTab, err);
        try {
            body.innerHTML = `<div class="we-hint" style="color:#d9534f">「${escapeHtml(currentTab)}」页渲染出错：${escapeHtml(err.message)}<br><br>其他页签仍可用。把 F12 控制台里这条红字发我，我来修。</div>`;
        } catch (e2) { /* ignore */ }
    }
    try { restoreOpenFolds(body, openFolds); } catch (e) { /* ignore */ }
    try { refreshFeedEstimate(); } catch (e) { /* ignore */ }   // 设置页：刷新"当前输入约 N 字"
    try { recenterPanel(); } catch (e) { /* ignore */ }   // 电脑端按内容高度再居中一次（手机端跳过）
}

/** 记录当前 DOM 里所有展开的折叠块（data-fold 是稳定 key，节点重建后仍能对上） */
function readOpenFolds(root) {
    const set = new Set();
    try {
        root.querySelectorAll('details[data-fold][open]').forEach((d) => set.add(d.dataset.fold));
    } catch (e) { /* ignore */ }
    return set;
}

/** 把折叠状态还原到新渲染出来的 DOM 上 */
function restoreOpenFolds(root, openSet) {
    if (!openSet || !openSet.size) return;
    try {
        root.querySelectorAll('details[data-fold]').forEach((d) => {
            if (openSet.has(d.dataset.fold)) d.open = true;
        });
    } catch (e) { /* ignore */ }
}

function updateTimeBar() {
    const bar = panelEl && panelEl.querySelector('#we-timebar');
    const t = panelEl && panelEl.querySelector('#we-tb-time');
    if (!bar || !t) return;
    const state = getState();
    const hour = extractHour(state.worldTime) ?? new Date().getHours();
    const tod = timeOfDay(hour);
    bar.className = `we-timebar we-bg-${tod.key}`;
    t.textContent = state.worldTime ? `${state.worldTime} · ${tod.label}` : `未建立世界 · ${tod.label}`;

    // 引擎状态点：绿=待命 / 橙=推演中 / 红=上次失败 / 灰=还没跑过
    const dot = panelEl.querySelector('#we-tb-dot');
    if (dot) {
        const kind = engineDotKind(state);
        dot.className = `we-dot we-dot-${kind}`;
        dot.title = ({
            busy: '正在推演世界…',
            ok: '上次推演成功',
            err: '上次推演失败（看「日志」页）',
            idle: '还没有推演过',
        })[kind];
    }
}

/** 引擎状态：以最近一条 update 日志的成败为准（自动演化也会写这条日志） */
function engineDotKind(state) {
    if (busy) return 'busy';
    const last = (state.logs || []).find((l) => String(l.type || '').startsWith('update'));
    if (!last) return 'idle';
    return last.ok === false ? 'err' : 'ok';
}

/* ---------------- 建档页（分步） ---------------- */

function phaseLabel(phase) {
    return ({
        empty: '未开始',
        roster: '第 1 步完成（认人 + 性格，还没建关系）',
        organizing: '第 2 步进行中（分批整理）',
        characters: '第 2 步进行中（分批整理）',
        running: '初始化完成，世界运行中',
    })[phase || 'empty'] || '未开始';
}

/** 整理草稿区 */
function draftCards(state) {
    const drafts = state.drafts || [];
    if (!drafts.length) {
        return '<div class="we-sub">还没有草稿。每整理一批，插件会把这一批的整理结果存成草稿放在这里，下一批会自动带上它们比对冲突；全部整理完点「汇总定稿」后会自动清空。</div>';
    }
    const out = [];
    out.push(`<div class="we-hint" style="margin:6px 0">共 ${drafts.length} 份草稿（点标题展开，可编辑/删除）。下一批整理时会自动带上这些小结去比对冲突。</div>`);
    drafts.forEach((d, i) => {
        out.push(`<details class="we-fold we-draft">
            <summary>#${i + 1} ｜ ${escapeHtml((d.batch || []).join('、'))} ｜ ${escapeHtml(String(d.notes || '').slice(0, 40))}</summary>
            <div class="we-sub">${escapeHtml(d.at || '')}</div>
            <div class="we-field"><label>工作小结（会作为下一批的参考）</label>
                <textarea class="we-draft-notes" data-id="${escapeHtml(d.id)}" style="min-height:60px">${escapeHtml(d.notes || '')}</textarea></div>
            <details><summary class="we-sub" style="cursor:pointer">看完整整理原稿</summary>
                <textarea class="we-draft-raw" data-id="${escapeHtml(d.id)}" style="min-height:180px">${escapeHtml(d.raw || '')}</textarea>
            </details>
            <div class="we-row">
                <button data-act="draft-save" data-id="${escapeHtml(d.id)}">保存这份草稿</button>
                <button data-act="draft-del" data-id="${escapeHtml(d.id)}">删除这份</button>
            </div>
        </details>`);
    });
    out.push(`<div class="we-row"><button data-act="draft-clear-all">清空全部草稿</button></div>`);
    return out.join('');
}

/** 第 2 步的条目选择器：自动命中本批角色的条目默认勾上，可手动加减 */
function organizeEntryPicker(s) {
    if (!s.worldbook.enabled) return '<div class="we-sub">世界书已关闭，本批不带任何条目。</div>';
    if (!entryCache.loaded) {
        ensureEntriesLoaded();
        return '<div class="we-sub">正在读取世界书条目…</div>';
    }
    const all = entryCache.entries;
    if (!all.length) {
        return '<div class="we-sub">没读到世界书条目（角色卡可能没绑世界书，可在运行设置里手填世界书名）。</div>';
    }
    const usable = selectedEntries(all);
    if (!usable.length) {
        return '<div class="we-hint" style="color:#d9534f">你在「条目」页一条都没勾，本批不会带任何世界书内容。<button data-act="goto-entries" style="margin-left:6px">去挑条目</button></div>';
    }
    const matched = entriesForNames(usable, pickedCharacters, { includeNsfw: !!s.worldbook.includeNsfw });
    const matchedUids = matched.map((e) => e.uid);
    if (orgEntryUids === null) orgEntryUids = matchedUids.slice();   // 还没手动挑 → 默认勾命中项
    const pickedSet = new Set(orgEntryUids);

    const row = (e) => `<label class="we-inline" style="display:flex;gap:6px;padding:2px 0">
        <input type="checkbox" class="we-org-entry-cb" data-uid="${escapeHtml(e.uid)}" ${pickedSet.has(e.uid) ? 'checked' : ''}>
        <span>${escapeHtml(e.title)}</span>
        ${entryBadges(e)}
        <span class="we-sub">${e.length} 字${e.names && e.names.length ? ' ｜ ' + escapeHtml(e.names.join('、')) : ''}</span>
    </label>`;

    const out = [];
    out.push(`<div class="we-sub" style="margin-top:4px">本批带入的条目：按角色名<b>自动命中 ${matched.length} 条</b>（标题 / 关键词里提到了本批角色），<b>默认已勾上</b>。你也可以手动加减。</div>`);
    out.push(`<div class="we-row" style="margin:4px 0;flex-wrap:wrap">
        <button data-act="org-entries-matched">只勾命中的 ${matched.length} 条</button>
        <button data-act="org-entries-all">勾全部可用 ${usable.length} 条</button>
        <button data-act="org-entries-none">一条都不带</button>
        <span class="we-sub">当前已勾 ${orgEntryUids.length} 条</span>
    </div>`);

    const mainList = matched.length ? matched : usable;
    const rest = matched.length ? usable.filter((e) => !matchedUids.includes(e.uid)) : [];
    if (!matched.length) out.push('<div class="we-sub">（没有条目标题/关键词命中本批角色——可能世界书里的名字和角色名对不上。下面是全部可用条目，需要就手动勾。）</div>');
    out.push(`<div style="max-height:210px;overflow:auto;border:1px solid var(--we-bd);border-radius:8px;padding:6px;margin-top:4px">
        ${mainList.map(row).join('')}
        ${rest.length ? `<details style="margin-top:6px"><summary class="we-sub" style="cursor:pointer">其他条目（${rest.length} 条，一般不用带）</summary>${rest.map(row).join('')}</details>` : ''}
    </div>`);
    return out.join('');
}

/**
 * 「本批带入的世界书条目」区域（v2.3.14）：
 * 抽出来是为了**局部刷新** —— 勾选角色时只重绘这一块，不再整页重渲染
 * （以前整页重建会丢滚动位置：勾一下就跳回顶部）。
 */
function orgAreaHtml() {
    const s = getSettings();
    return `<div class="we-sect-title">本批带入的世界书条目（已选 ${pickedCharacters.length} 个角色）</div>`
        + (pickedCharacters.length
            ? organizeEntryPicker(s)
            : '<div class="we-sub">先在上面勾选角色，这里会列出她们命中的条目。</div>');
}

/** 勾选变化后的局部刷新：同步角色勾选框状态 + 重绘条目区（不动滚动位置） */
function refreshPickUI() {
    document.querySelectorAll('.we-char-cb').forEach((cb) => {
        cb.checked = pickedCharacters.includes(cb.dataset.char);
    });
    const area = document.getElementById('we-org-area');
    if (area) area.innerHTML = orgAreaHtml();
}

function renderBuild() {
    const state = getState();
    const s = getSettings();
    const tops = topNodes(state);
    const allNodes = Object.values(state.nodes || {});
    const built = Array.isArray(state.built) ? state.built : [];
    const batchSize = Math.max(1, Number(s.tracking.batchSize) || 3);
    const unbuilt = tops.map((n) => n.name).filter((n) => !built.includes(n));
    const drafts = state.drafts || [];
    const done = state.phase === 'running';       // 第 2 步跑完 → 世界进入运行态
    const collapsed = done && !buildExpanded;     // 默认把第 1/2 步收起来

    // 清理已不存在的勾选（角色被删/改名后），但**不自动补勾**（v2.3.14）：
    // 以前这里是"空 → 自动勾未整理的前 N 个"，导致点「全部取消」/手动全取消
    // 都会被自动勾回来。自动接下一批改在整理完成时显式挑（见 stage-organize）。
    if (pickedCharacters.length) {
        pickedCharacters = pickedCharacters.filter((n) => tops.some((t) => t.name === n));
    }

    const out = [];
    const counts = { interaction: 0, cooldown: 0, unseen: 0 };
    tops.forEach((n) => { counts[n.category] = (counts[n.category] || 0) + 1; });
    out.push(`<div class="we-hint">当前阶段：<b>${escapeHtml(phaseLabel(state.phase))}</b> ｜ 角色 ${tops.length} 个，已整理 ${built.length} 个 ｜ 通道：${escapeHtml(currentChannel())}</div>`);
    out.push(`<div class="we-hint" style="margin-top:4px">
        <span class="we-badge we-b-interaction">交互 ${counts.interaction}</span>
        <span class="we-badge we-b-cooldown">冷却 ${counts.cooldown}</span>
        <span class="we-badge we-b-unseen">未出场 ${counts.unseen}</span>
        ${counts.interaction === 0 ? '　初始化阶段交互是 0 是正常的，第 3 步载入剧情后才会开始进人' : ''}
    </div>`);
    if (s.worldbook.enabled && selectionMade() && !(s.worldbook.selectedUids || []).length) {
        out.push('<div class="we-hint" style="color:#d9534f">注意：你在「条目」页一条都没勾选，建档不会带任何世界书内容。<button data-act="goto-entries" style="margin-left:6px">去挑条目</button></div>');
    }
    if (buildStatus) out.push(`<div class="we-hint" style="margin:6px 0">⏳ ${escapeHtml(buildStatus)}</div>`);

    if (collapsed) {
        /* ---- 建档已完成：第 1/2 步收起 ---- */
        out.push(`<div class="we-card">
            <div class="we-row">
                <span class="we-name">✓ 建档已完成</span>
                <span class="we-badge we-b-interaction">${tops.length} 个角色</span>
                <button data-act="toggle-build">展开重做第 1/2 步</button>
            </div>
            <div class="we-sub">世界已在运行，之后每轮 AI 回复后会自动更新；想手动推就点下面第 3 步的「立即更新」。</div>
            <div class="we-sub">开新卡（新聊天）时会自动回到展开状态，重新走建档。想现在就重做，点上面的「展开重做第 1/2 步」。</div>
        </div>`);
    } else {
        if (done) {
            out.push('<div class="we-row" style="margin:2px 0 6px"><button data-act="toggle-build">收起第 1/2 步（建档已完成，平时不用看）</button></div>');
        }

        /* ---- 第 1 步 ---- */
        out.push(`<div class="we-card">
            <div class="we-row"><span class="we-name">第 1 步｜认人（列花名册）</span></div>
            <div class="we-sub">只读「人物速览」，把<b>这张卡里有什么人全列出来</b>——男女都列、不筛、不判断谁重要。每人只写一句"她/他是谁 + 和谁有关系"。</div>
            <div class="we-sub"><b>这一步不写性格</b>（速览里根本没有性格资料，写了就是编的），<b>不建关系树、不写任何状态</b>，全部先标【未出场】。性格和关系网都留到第 2 步。</div>
            <div class="we-sub">当前世界书：${escapeHtml(getWorldBookName() || '（未绑定，可去运行设置手填）')}</div>
            <div class="we-row" style="margin-top:6px">
                <button data-act="stage-roster">① 生成角色表</button>
                <button data-act="goto-entries">挑选带入的条目</button>
            </div>
        </div>`);

        /* ---- 待建档总览 ---- */
        out.push(`<div class="we-card">
            <div class="we-row"><span class="we-name">待建档（${allNodes.length} 个，全部平铺）</span></div>
            <div class="we-sub">${tops.length} 个顶层 + ${allNodes.length - tops.length} 个关系人。已整理 ${built.length} 个，剩 ${Math.max(0, allNodes.length - built.length)} 个。</div>
            <div style="margin-top:6px;max-height:300px;overflow:auto">
                ${allNodes.length ? allNodes.map((n) => {
                    const isBuilt = built.includes(n.name);
                    const pl = personaLine(n);
                    const indent = '　'.repeat(Math.max(0, (n.level || 0)));
                    return `<div class="we-flatrow" style="padding-left:${(n.level || 0) * 12}px">
                        <span class="we-name">${escapeHtml(indent + n.name)}</span>
                        ${isBuilt ? '<span class="we-badge we-b-interaction">已整理</span>' : '<span class="we-badge we-b-unseen">待整理</span>'}
                        ${hasPersona(n) ? '' : '<span class="we-badge we-b-sed">缺性格</span>'}
                        <span class="we-sub">${escapeHtml(pl || n.summary || '（还没内容）')}</span>
                    </div>`;
                }).join('') : '<div class="we-sub">（还没有人，请先做第 1 步）</div>'}
            </div>
        </div>`);

        /* ---- 第 2 步 ---- */
        out.push(`<div class="we-card">
            <div class="we-row"><span class="we-name">第 2 步｜分批整理 + 带条目（每批 2~3 个，可重复多批）</span></div>
            <div class="we-sub">勾几个角色 → 插件把<b>她们各自的世界书条目</b>带进去 → 整理出<b>性格、行为、关系网</b>，并留一份"这一轮我干了什么"的小结存成草稿。<b>性格在这一步才定。</b></div>
            <div class="we-sub">世界里的人基本都挂在女性角色（有专门条目的人）的关系网下 —— 挑女性角色就行，她的家人/男友会从她的条目里自动长成树枝。下一批会自动带上已有小结<b>比对冲突</b>；唯一原则：<b>情人 &gt; 家人</b>。</div>
            ${tops.length ? '' : '<div class="we-sub">（还没有角色，请先做第 1 步）</div>'}
            ${unbuilt.length ? `<div class="we-row" style="margin-top:4px"><button data-act="pick-unbuilt">自动勾选待整理的 ${Math.min(batchSize, unbuilt.length)} 个</button><button data-act="pick-none">全部取消</button></div>` : ''}
            <div style="margin-top:6px;max-height:220px;overflow:auto">
                ${tops.map((n) => {
                    const isBuilt = built.includes(n.name);
                    const checked = pickedCharacters.includes(n.name) ? 'checked' : '';
                    return `<label class="we-inline" style="display:flex;gap:6px;padding:2px 0">
                        <input type="checkbox" class="we-char-cb" data-char="${escapeHtml(n.name)}" ${checked}>
                        <span>${escapeHtml(n.name)}</span>
                        ${isBuilt ? '<span class="we-badge we-b-interaction">已整理</span>' : '<span class="we-badge we-b-unseen">待整理</span>'}
                        <span class="we-sub">${escapeHtml((personaLine(n) || n.summary || '').slice(0, 30))}</span>
                    </label>`;
                }).join('')}
            </div>
            <div id="we-org-area">${orgAreaHtml()}</div>
            <div class="we-row" style="margin-top:6px">
                <button class="we-primary" data-act="stage-organize">② 整理这批角色</button>
                <label class="we-inline"><input type="checkbox" id="we-batch-nsfw" ${s.worldbook.includeNsfw ? 'checked' : ''}> 一并带入 NSFW 条目</label>
                <label class="we-inline" title="给剧情中途入场、已批准建档的角色用：只把性格从她的条目注入，不动状态/类别/关系"><input type="checkbox" id="we-batch-personaonly"> 只补性格（不碰状态/类别）</label>
            </div>
            <div class="we-sect-title">整理草稿（${drafts.length}）</div>
            ${draftCards(state)}
            <div class="we-row" style="margin-top:6px">
                <button class="${built.length ? 'we-primary' : ''}" data-act="stage-finalize">③ 建档完成（汇总定稿，收起第 1/2 步）</button>
                <button data-act="stage-rebuild">清空重来</button>
            </div>
        </div>`);
    }

    /* ---- 第 3 步（永远显示） ---- */
    const mem = state.memoryText || '';
    out.push(`<div class="we-card">
        <div class="we-row"><span class="we-name">第 3 步｜载入近期剧情（之后天天跑的就是这个）</span></div>
        <div class="we-sub">读最近 ${s.tracking.updateDepth} 层聊天（你的发言和 AI 回复各算一层）+ 当前世界状态 + 命中的世界书条目 → 增量更新每个角色的状态。<b>性格字段是锁死的，这一轮改不动。</b></div>
        <div class="we-row" style="margin-top:6px">
            <button class="we-primary" data-act="update">立即更新</button>
            <span class="we-sub">每次输出的「## 小结」会存进日志页，下一轮自动带回去，免得前后打架</span>
        </div>

        <div class="we-sect-title">外部剧情记忆（小白X 等）</div>
        <div class="we-sub">已经聊了很多层、不想从头推演时，把别处导出的剧情记忆 JSON 粘进来，让 AI 直接整理进角色状态。之后的每一轮更新都会自动带上它。</div>
        <div class="we-field"><label>粘贴记忆 JSON（小白X 的"导出记忆"整段复制过来就行）</label>
            <textarea id="we-memory-input" style="min-height:120px" placeholder="把 JSON 粘在这里…">${escapeHtml(memoryDraft)}</textarea></div>
        <div class="we-row">
            <button data-act="memory-preview">解析预览</button>
            <button data-act="memory-import">导入并整理</button>
            <button data-act="memory-copy-instruction">复制压缩指令</button>
            <button data-act="memory-clear">清除已导入的记忆</button>
        </div>
        ${memoryInfo ? `<div class="we-hint" style="margin-top:4px">${memoryInfo}</div>` : ''}
        ${mem ? `<div class="we-hint" style="margin-top:4px">已导入记忆 <b>${mem.length}</b> 字${state.memoryAt ? `（${escapeHtml(state.memoryAt)}）` : ''} —— 每轮更新都会带上。
            <details><summary style="cursor:pointer">看记忆内容</summary><pre style="max-height:220px;overflow:auto;white-space:pre-wrap">${escapeHtml(mem.slice(0, 6000))}</pre></details>
        </div>` : '<div class="we-hint" style="margin-top:4px">还没导入外部记忆（不导入也完全能用）。</div>'}
    </div>`);

    if (state.phase === 'running') {
        out.push('<div class="we-hint">世界已在运行：之后每轮 AI 回复后会自动演化，也可以用底部「立即更新」手动推。</div>');
    }
    return out.join('');
}

/* ---------------- 世界书条目页 ---------------- */

async function ensureEntriesLoaded(force = false) {
    if (entryLoading) return;
    if (entryCache.loaded && !force) return;
    entryLoading = true;
    try {
        const entries = await loadWorldBook(true, getSettings().worldbook.name);
        entryCache = { loaded: true, entries };
    } catch (e) {
        entryCache = { loaded: true, entries: [] };
        toast(`世界书读取失败：${e.message}`, 'error');
    }
    entryLoading = false;
    render();
}

function entryBadges(e) {
    const b = [];
    if (e.isOverview) b.push('<span class="we-badge we-b-sed">速览</span>');
    if (e.isNsfw) b.push('<span class="we-badge we-b-red">NSFW</span>');
    if (e.kind === 'character') b.push('<span class="we-badge we-b-interaction">角色</span>');
    if (!b.length) b.push('<span class="we-badge we-b-unseen">其他</span>');
    return b.join(' ');
}

function entriesStatsText() {
    const s = getSettings();
    const all = entryCache.entries;
    const picked = Array.isArray(s.worldbook.selectedUids) ? s.worldbook.selectedUids : [];
    const made = selectionMade();
    const used = made ? all.filter((e) => picked.includes(e.uid)) : all;
    const chars = used.reduce((a, e) => a + e.length, 0);
    if (made && !picked.length) {
        return '<b style="color:#d9534f">当前：一条都不带入</b>（建档与更新都不会把世界书内容给模型）';
    }
    return `当前：${made ? `已挑 <b>${picked.length}</b> 条` : '全部可用（还没挑过）'} ｜ 实际带入 <b>${used.length}</b> 条 / ${chars} 字`;
}

function renderEntries() {
    if (!entryCache.loaded) { ensureEntriesLoaded(); return '<div class="we-hint">正在读取世界书条目…</div>'; }
    const s = getSettings();
    const all = entryCache.entries;
    if (!all.length) {
        return `<div class="we-hint">没读到世界书条目。<br><br>可能原因：角色卡没绑定世界书（可在运行设置里手填世界书名），或酒馆版本没有世界书读取接口。<br><br>
        <button data-act="entries-refresh">重新读取</button></div>`;
    }
    const picked = Array.isArray(s.worldbook.selectedUids) ? s.worldbook.selectedUids : [];
    const pickedSet = new Set(picked);
    const nothingPicked = selectionMade();  // true = 严格按勾选来

    const out = [];
    out.push(`<div class="we-hint" id="we-entry-stats">${entriesStatsText()}<br>
        勾选是<b>即时保存</b>的，不用另外确认；没勾的条目在任何调用里都不会被塞进去。</div>`);
    out.push(`<div class="we-row" style="margin:6px 0">
        <button data-act="entries-all">全选</button>
        <button data-act="entries-essentials">只选速览</button>
        <button data-act="entries-none">全不选</button>
        <button data-act="entries-refresh">重新读取</button>
    </div>`);
    out.push(all.map((e) => `<div class="we-card">
        <label class="we-row" style="gap:6px">
            <input type="checkbox" class="we-entry-cb" data-uid="${escapeHtml(e.uid)}" ${(!nothingPicked || pickedSet.has(e.uid)) ? 'checked' : ''}>
            <span class="we-name">${escapeHtml(e.title)}</span>
            ${entryBadges(e)}
            <span class="we-sub">${e.length} 字</span>
        </label>
        ${e.names.length ? `<div class="we-sub">角色：${escapeHtml(e.names.join('、'))}</div>` : ''}
        <details><summary class="we-sub" style="cursor:pointer">看内容</summary>
            <div class="we-text" style="max-height:180px;overflow:auto">${escapeHtml(e.content.slice(0, 1500))}${e.content.length > 1500 ? '…' : ''}</div>
        </details>
    </div>`).join(''));
    return out.join('');
}

/* ---------------- 世界状态页 ---------------- */

function badge(cat) {
    const label = CATEGORY_LABEL[cat];
    // 档位表里没有的（旧存档的 attack、模型写的怪类别）不能渲染成 "undefined"
    if (!label) return '';
    return `<span class="we-badge we-b-${cat}">${label}</span>`;
}

function eyeBtn(name, hidden) {
    return `<span class="we-eye ${hidden ? 'we-off' : ''}" data-act="eye" data-name="${escapeHtml(name)}" title="隐藏/显示">${hidden ? EYE_OFF : EYE_ON}</span>`;
}

/** 心情 / 目标小行（内心面；缺的就不显示） */
function moodText(n) {
    return [n.mood && `心情：${n.mood}`, n.goal && `目标：${n.goal}`].filter(Boolean).join('　');
}

/**
 * 角色行的展示块（v2.3.23）：名字行 / 状态行（时间 · 地点 · 在做什么）/ 心情目标行 —— 各占一行。
 * 主视图不再把性格挤在状态里（性格去「角色性格档案」折叠块看）。
 */
function stateBlock(n, hidden, tagsHtml) {
    const st = stateLine(n);
    const mood = moodText(n);
    return `<div class="we-line we-stack">
        <div class="we-row">${eyeBtn(n.name, hidden)}<span class="we-name">${escapeHtml(n.name)}</span>${tagsHtml || ''}</div>
        ${st ? `<div class="we-text">${escapeHtml(st)}</div>` : ''}
        ${mood ? `<div class="we-sub">${escapeHtml(mood)}</div>` : ''}
    </div>`;
}

function childCards(state, node, detailed) {
    const kids = childrenOf(state, node.id);
    if (!kids.length) return '';
    return kids.map((c) => {
        const hidden = state.hidden.includes(c.name);
        const st = stateLine(c);
        const mood = moodText(c);
        if (!detailed) {
            return `<div class="we-card we-child ${hidden ? 'we-hidden' : ''}">
                <div class="we-row">${eyeBtn(c.name, hidden)}<span class="we-name">${escapeHtml(c.name)}</span>${badge(c.category)}</div>
                <div class="we-text">${escapeHtml(st || '（无状态）')}</div>
                ${mood ? `<div class="we-sub">${escapeHtml(mood)}</div>` : ''}
            </div>`;
        }
        return `<div class="we-card we-child ${hidden ? 'we-hidden' : ''}">
            <div class="we-row">${eyeBtn(c.name, hidden)}<span class="we-name">${escapeHtml(c.name)}</span>${badge(c.category)}</div>
            <div class="we-text">${escapeHtml(st || '（无状态）')}</div>
            ${mood ? `<div class="we-sub">${escapeHtml(mood)}</div>` : ''}
            ${c.floor > 0 ? `<div class="we-sub">最近一次更新：第 ${c.floor} 层</div>` : ''}
            ${childCards(state, c, true)}
        </div>`;
    }).join('');
}

/**
 * 子分支折叠：默认**全部收起**，只留一行摘要（有几个、都是谁）。
 * 用户的原话："子分支你直接全折叠起来算了" —— 主分支一眼能扫完，细节按需展开。
 *
 * @param {object} state
 * @param {object} node 父节点
 * @param {boolean} detailed 展开后子分支用详细卡片还是单行
 * @param {{depth?:number, parentKey?:string}} [opts] depth 用于缩进，parentKey 用于天然唯一的折叠组
 */
function childrenFold(state, node, detailed, opts = {}) {
    const kids = childrenOf(state, node.id);
    if (!kids.length) return '';
    const depth = opts.depth || 0;
    const key = opts.parentKey || node.id;
    // 摘要：名字 + 类别图标，让收起状态下也能一眼看到有谁
    const names = kids.map((c) => escapeHtml(c.name)).join('、');
    const hasNew = kids.some((c) => c.category === 'interaction');
    return `<details class="we-fold we-childfold" data-fold="c:${escapeHtml(key)}"${hasNew && depth === 0 ? ' open' : ''}>
        <summary>子分支（${kids.length}）<span class="we-childfold-names">${names}</span></summary>
        <div class="we-childfold-body">${childCards(state, node, detailed)}</div>
    </details>`;
}

function renderState() {
    const state = getState();
    const s = getSettings();
    const names = Object.keys(state.nodes || {});
    if (!names.length) {
        return `<div class="we-hint" style="padding:16px 0;text-align:center">
            还没有世界状态。<br><br>点下面的「建立世界状态」，插件会读取角色卡/世界书 + 最近剧情，多轮生成整棵世界树。
        </div>`;
    }

    const tops = topNodes(state);
    // v2.3.18：三档（攻防已删）+ 组内按「剧情出现顺序」排（最近在戏里的在前）
    const groups = groupedTops(state, tops);

    const out = [];
    out.push(`<div class="we-hint">共 ${names.length} 个角色 ｜ 通道：${escapeHtml(currentChannel())}</div>`);

    // 状态有效期（时间段调度）：谁到期该更新、谁还没到点，一眼看得见
    if (s.tracking.timeSlot !== false && state.worldMinutes != null) {
        const exp = expiredNames(state);
        const val = validNames(state);
        const expTxt = exp.length
            ? `（${exp.slice(0, 10).map((x) => escapeHtml(x)).join('、')}${exp.length > 10 ? '…' : ''}）` : '';
        const valTxt = val.length
            ? `（${val.slice(0, 10).map((v) => `${escapeHtml(v.name)} 到 ${escapeHtml(v.until)}`).join('、')}${val.length > 10 ? '…' : ''}）` : '';
        out.push(`<div class="we-hint" style="margin-top:4px">状态有效期（时间段到了才更新）：
            <b style="color:#e8a33d">本轮待更新 ${exp.length} 人</b>${expTxt}
            ｜ 还在有效期内 ${val.length} 人${valTxt}
        </div>`);
    }

    // 待审提案：演化阶段模型提到的新角色（顶层名单冻结，不会自动建档）
    const pending = state.pending || [];
    if (pending.length) {
        out.push(`<div class="we-group"><div class="we-group-title" style="color:#e8a33d">待审新角色 <span class="we-count">${pending.length}</span>
            <button data-act="pending-clear" style="margin-left:auto;padding:2px 10px;font-weight:400">全部忽略</button>
            </div>
            <div class="we-sub" style="margin-bottom:6px">模型提名了但还没建档的人。已经在别人下面挂着（如「柳青>金主赵海」）的，点「忽略」是对的，点「建档」反而会多出一份。</div>`);
        pending.forEach((p) => {
            out.push(`<div class="we-card">
                <div class="we-row"><span class="we-name">${escapeHtml(p.name)}</span>
                    ${p.category ? badge(p.category) : ''}
                    <button data-act="pending-approve" data-name="${escapeHtml(p.name)}" class="we-primary" style="padding:2px 10px">建档</button>
                    <button data-act="pending-dismiss" data-name="${escapeHtml(p.name)}" style="padding:2px 10px">忽略</button>
                </div>
                ${p.text ? `<div class="we-text">${escapeHtml(p.text)}</div>` : ''}
                <div class="we-sub">${escapeHtml(p.at || '')}${p.floor ? ` ｜ 第 ${p.floor} 层提及` : ''}</div>
            </div>`);
        });
        out.push('</div>');
    }


    // 最近一次工作小结
    const wl = recentWorklogs(state, 1)[0];
    if (wl) {
        out.push(`<div class="we-worklog" style="margin-top:4px">
            <div class="we-wl-head">
                <span class="we-wl-n">#${wl.n}</span>
                <span class="we-badge we-b-${kindGroup(wl.kind) === 'build' ? 'interaction' : 'cooldown'}">${escapeHtml(kindLabel(wl.kind))}</span>
                <span class="we-wl-text">${escapeHtml(wl.summary)}</span>
                <span class="we-sub">${escapeHtml(wl.at || '')}</span>
            </div>
        </div>`);
    }

    // 同一人挂在多处（关系是网状的）
    const sameGroups = sameNameGroups(state);
    if (sameGroups.length) {
        const list = sameGroups.map(([k, l]) => `${escapeHtml(k)}（${l.length}处）`).join('、');
        out.push(`<div class="we-hint" style="margin-top:4px">同一人挂在多处的：${list}
            ${s.tracking.mergeSameName === false
                ? ' —— 你关掉了自动合并，这几个人现在各自独立。'
                : ' —— 状态是共享的，不会各自分裂。'}
            <button data-act="merge-dups" style="margin-left:6px;padding:2px 8px">合并成一处</button>
        </div>`);
    }

    // 疑似同一人（关系词表没覆盖到的那种前缀，如「管家赵叔」vs「赵叔」）：只提示、不自动合并
    const suspected = suspectedGroups(state);
    if (suspected.length) {
        const list = suspected.map(([, l]) => l.map((n) => escapeHtml(n.name)).join('  /  ')).join('；');
        out.push(`<div class="we-hint" style="margin-top:4px;color:#e8a33d">疑似同一人（前缀不在关系词表里，需你确认）：${list}
            <button data-act="merge-suspected" style="margin-left:6px;padding:2px 8px">合并</button>
        </div>`);
    }

    // 还没挂上任何关系网的独立角色 —— 最容易"看不见"的一批
    const lonely = tops.filter((n) => !childrenOf(state, n.id, true).length);
    if (lonely.length) {
        out.push(`<div class="we-hint" style="margin-top:4px">还没挂上任何关系网的独立角色（${lonely.length}）：${lonely.slice(0, 20).map((n) => escapeHtml(n.name)).join('、')}${lonely.length > 20 ? '…' : ''}<br>
            想让她们有家人 / 关系网，在第 2 步整理时把她们勾上、带上各自的世界书条目即可（她的家人会从条目里自动长成树枝）。</div>`);
    }

    // 交互：一行主角色，子分支默认折叠（按剧情出现顺序，最近在戏里的排最前）
    if (groups.interaction.length) {
        out.push(`<div class="we-group"><div class="we-group-title">交互 <span class="we-count">${groups.interaction.length}</span>
            <span class="we-sub">按剧情出现顺序，最近在戏里的在前</span></div>`);
        groups.interaction.forEach((n) => {
            const hidden = state.hidden.includes(n.name);
            const kidCount = childrenOf(state, n.id).length;
            const appearTag = (n.appearFloor > 0) ? `第${n.appearFloor}层出场` : (n.floor > 0 ? `第${n.floor}层更新` : '');
            out.push(stateBlock(n, hidden, `${badge('interaction')}${appearTag ? `<span class="we-sub">${appearTag}</span>` : ''}${kidCount ? `<span class="we-sub">子 ${kidCount}</span>` : ''}`));
            out.push(childrenFold(state, n, false, { depth: 0, parentKey: n.id }));
        });
        out.push('</div>');
    }

    // 冷却：直接展开（v2.3.16：用户要"能看到他们在干嘛"——冷却的人也得有事情做、看得见）
    if (groups.cooldown.length) {
        out.push(`<div class="we-group"><div class="we-group-title">冷却 <span class="we-count">${groups.cooldown.length}</span></div>`);
        groups.cooldown.forEach((n) => {
            const hidden = state.hidden.includes(n.name);
            out.push(stateBlock(n, hidden, badge('cooldown')));
        });
        out.push('</div>');
    }

    // 未出场：折叠（还没有戏份的人，不需要天天看）
    if (groups.unseen.length) {
        out.push(`<div class="we-group"><details class="we-fold" data-fold="g:unseen"><summary>未出场（${groups.unseen.length}）</summary>`);
        groups.unseen.forEach((n) => {
            const hidden = state.hidden.includes(n.name);
            out.push(stateBlock(n, hidden, badge('unseen')));
        });
        out.push('</details></div>');
    }

    // 快照/时间线
    if ((state.timeline || []).length) {
        out.push(`<div class="we-group"><details class="we-fold" data-fold="g:timeline"><summary>时间跳跃（最近 ${state.timeline.length} 次）</summary>`);
        state.timeline.slice().reverse().forEach((t) => {
            out.push(`<div class="we-ev">${escapeHtml(t.from)} → ${escapeHtml(t.to)} <span style="opacity:.5">${escapeHtml(t.at)}</span></div>`);
        });
        out.push('</details></div>');
    }

    // 全部角色总览（平铺，方便核对有没有漏人或漏状态）
    out.push(`<div class="we-group"><details class="we-fold" data-fold="g:overview"><summary>全部角色总览（${names.length} 个，按关系树平铺）</summary>`);
    const flatLine = (n, depth) => {
        const txt = stateLine(n);
        return `<div class="we-line" style="padding-left:${depth * 14}px">
            <span class="we-name">${escapeHtml(n.name)}</span>
            ${badge(n.category)}
            <span style="opacity:.85">${escapeHtml(txt || '（还没有状态）')}</span>
            ${n.sharedWith ? '<span class="we-sub">（同一人）</span>' : ''}
        </div>`;
    };
    tops.forEach((t) => {
        out.push(flatLine(t, 0));
        childrenOf(state, t.id, true).forEach((c) => {
            out.push(flatLine(c, 1));
            childrenOf(state, c.id, true).forEach((g) => out.push(flatLine(g, 2)));
        });
    });
    out.push('</details></div>');

    // 角色性格档案（v2.3.23）：性格不再挤在状态行里 —— 主视图只看"在干什么"，
    // 想查性格 / 底色 / 软肋 / 说话 / 行为的人翻这里（和「全部角色总览」并列的折叠块，五维各占一行）
    const personaRows = [];
    const collectPersona = (n, d) => { if (hasPersona(n)) personaRows.push([n, d]); };
    tops.forEach((t) => {
        collectPersona(t, 0);
        childrenOf(state, t.id, true).forEach((c) => {
            collectPersona(c, 1);
            childrenOf(state, c.id, true).forEach((g) => collectPersona(g, 2));
        });
    });
    if (personaRows.length) {
        out.push(`<div class="we-group"><details class="we-fold" data-fold="g:persona"><summary>角色性格档案（${personaRows.length} 个，点开查阅）</summary>`);
        personaRows.forEach(([n, d]) => {
            const fields = PERSONA_ORDER
                .map((k) => (n.persona && n.persona[k])
                    ? `<div class="we-text" style="margin-top:2px">${PERSONA_LABEL[k]}：${escapeHtml(n.persona[k])}</div>`
                    : '')
                .join('');
            out.push(`<div class="we-card we-child ${state.hidden.includes(n.name) ? 'we-hidden' : ''}" style="margin-left:${d * 14}px">
                <div class="we-row"><span class="we-name">${escapeHtml(n.name)}</span>${badge(n.category)}</div>
                ${fields}
            </div>`);
        });
        out.push('</details></div>');
    }
    return out.join('');
}

/* ---------------- 大事记 ---------------- */

function renderEvents() {
    const state = getState();
    const list = state.events || [];
    const out = [];
    if (!list.length) {
        out.push('<div class="we-hint">暂无大事记。新角色登场、归档角色激活、子分支迁移、角色进入/退出交互档时会自动记录。</div>');
    } else {
        out.push(list.map((e, i) => `<div class="we-ev">
            <span class="we-ev-type">${escapeHtml(e.type || '')}</span>${escapeHtml(e.text || '')}
            <button class="we-mini-del" data-act="event-del" data-idx="${i}" title="删除这条">删除</button>
            <div class="we-sub">${escapeHtml(e.at || '')}</div>
        </div>`).join(''));
        out.push('<div class="we-row" style="margin-top:6px"><button data-act="events-clear">清空大事记</button></div>');
    }
    out.push('<div style="margin-top:10px" class="we-row"><input type="text" id="we-ev-text" placeholder="手动补一条大事记" style="flex:1;min-width:120px"><button data-act="add-event" style="padding:4px 8px">添加</button></div>');
    return out.join('');
}

/* ---------------- 运行设置 ---------------- */

function profileOptions(current) {
    let list = [];
    try { list = listTavernProfiles(); } catch (e) { list = []; }
    const opts = ['<option value="">（跟随酒馆当前选中的连接）</option>'];
    list.forEach((p) => {
        const label = `${p.name}${p.model ? ' · ' + p.model : ''}`;
        opts.push(`<option value="${escapeHtml(p.id)}" ${String(current) === p.id ? 'selected' : ''}>${escapeHtml(label)}</option>`);
    });
    if (current && !list.some((p) => p.id === String(current))) {
        opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（未找到该连接）</option>`);
    }
    return opts.join('');
}

function modelPickerHtml(s) {
    const opts = Array.isArray(s.api.modelOptions) ? s.api.modelOptions : [];
    const cur = escapeHtml(s.api.model || '');
    const datalist = opts.length
        ? `<datalist id="we-model-options">${opts.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')}</datalist>`
        : '';
    const select = opts.length
        ? `<select id="we-api-model-select">
             <option value="">— 从列表选择（共 ${opts.length} 个）—</option>
             ${opts.map((m) => `<option value="${escapeHtml(m)}" ${String(s.api.model) === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
           </select>`
        : '';
    return `${select}
        <input type="text" id="we-api-model" list="we-model-options" value="${cur}" placeholder="填或从列表里选，例：gemini-2.0-flash">
        ${datalist}`;
}

function renderSettings() {
    const s = getSettings();
    const cb = (v) => (v ? 'checked' : '');
    const cats = s.writeToChat.categories;
    // 输入装配开关：缺项默认开（兼容旧存档）
    const feed = {
        chat: s.feed.chat !== false,
        state: s.feed.state !== false,
        worldinfo: s.feed.worldinfo !== false,
        memory: s.feed.memory !== false,
        notes: s.feed.notes !== false,
        mustCover: s.feed.mustCover !== false,
        scene: s.feed.scene !== false,
        jump: s.feed.jump !== false,
        names: s.feed.names !== false,
    };
    const theme = (s.ui && s.ui.theme) || 'auto';
    return `<div class="we-form">
        <div class="we-sect-title">总开关</div>
        <label class="we-inline"><input type="checkbox" id="we-enabled" ${cb(s.enabled)}> 启用世界引擎</label>
        <label class="we-inline"><input type="checkbox" id="we-auto" ${cb(s.autoUpdate)}> AI 回复后自动演化世界</label>
        <div class="we-sect-title">外观</div>
        <div class="we-field"><label>面板配色</label><select id="we-theme">
            <option value="auto" ${theme === 'auto' ? 'selected' : ''}>自动（跟酒馆的明暗走）</option>
            <option value="st" ${theme === 'st' ? 'selected' : ''}>跟随酒馆主题（面板和你装的酒馆主题完全一致）</option>
            <option value="light" ${theme === 'light' ? 'selected' : ''}>强制浅色</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>强制深色</option>
        </select></div>
        <div class="we-sect-title">调用通道（跟酒馆一致）</div>
        <div class="we-field"><label>通道模式</label><select id="we-api-mode">
            <option value="tavern" ${s.api.mode === 'tavern' ? 'selected' : ''}>跟随酒馆主连接（你在酒馆「API 连接」里选哪个就用哪个 — 推荐）</option>
            <option value="auto" ${s.api.mode === 'auto' ? 'selected' : ''}>自动：插件里填了独立 API 就用，没填或不通就跟随酒馆主连接</option>
            <option value="direct" ${s.api.mode === 'direct' ? 'selected' : ''}>只用插件里填的独立 API</option>
        </select></div>
        <div class="we-field"><label>酒馆连接（连接管理器里的预设，留空=跟随酒馆当前选中的）</label>
            <div class="we-row">
                <select id="we-tavern-profile" style="flex:1">${profileOptions(s.api.tavernProfile)}</select>
                <button data-act="refresh-profiles">刷新</button>
            </div>
        </div>
        <label class="we-inline"><input type="checkbox" id="we-fallback" ${cb(s.allowFallback)}> 独立 API 失败时自动跟随酒馆主连接</label>
        <label class="we-inline"><input type="checkbox" id="we-include-preset" ${cb(s.api.includePreset === true)}> 走连接管理器时 <b>套用该连接的预设</b>（一般别开：预设里的正文格式要求会被灌进演化提示词，污染判断）</label>
        <label class="we-inline"><input type="checkbox" id="we-debug" ${cb(s.debug)}> 控制台输出请求/返回摘要（排错用）</label>

        <div class="we-sect-title">独立 API（留空=用酒馆主连接）</div>
        <div class="we-field"><label>API 地址（例：http://127.0.0.1:8080/v1，留空就用酒馆的）</label><input type="text" id="we-api-url" value="${escapeHtml(s.api.url)}"></div>
        <div class="we-field"><label>密钥 API Key</label><input type="password" id="we-api-key" value="${escapeHtml(s.api.key)}"></div>
        <div class="we-grid2">
            <div class="we-field"><label>温度</label><input type="number" step="0.05" min="0" max="2" id="we-api-temp" value="${s.api.temperature}"></div>
            <div class="we-field"><label>最大输出 Token</label><input type="number" min="256" step="256" id="we-api-maxtokens" value="${s.api.maxTokens}"></div>
        </div>
        <div class="we-field"><label>模型名（可下拉选择，也可手填）</label>
            ${modelPickerHtml(s)}
        </div>
        <div class="we-row">
            <button data-act="fetch-models">拉取模型列表</button>
            <button data-act="test-api">测试连接</button>
            <button class="we-primary" data-act="diagnose">一键自检</button>
        </div>
        <div class="we-hint">当前：${escapeHtml(currentChannel())}</div>
        <div class="we-hint" style="margin-top:4px">想看每次调用发出去的完整提示词：看「日志」页（最近 10 次，含模型原始输出），或勾上上面的「控制台输出请求/返回摘要」再按 F12。
        酒馆本身默认不把提示词打到服务端控制台，所以 Termux 里看不到是正常的；请求确实是从服务端发出的。</div>
        ${lastDiag ? `<pre style="max-height:240px;overflow:auto;white-space:pre-wrap;font-size:11.5px;background:rgba(0,0,0,.2);padding:8px;border-radius:6px;margin-top:6px">${escapeHtml(lastDiag)}</pre>` : ''}

        <div class="we-sect-title">追踪参数</div>
        <div class="we-grid2">
            <div class="we-field"><label>更新参考层数（一层 = 一条消息，用户发言和 AI 回复都算）</label><input type="number" min="1" id="we-update-depth" value="${s.tracking.updateDepth}"></div>
            <div class="we-field"><label>初始化参考层数</label><input type="number" min="1" id="we-init-depth" value="${s.tracking.initDepth}"></div>
            <div class="we-field"><label>注入深度（1女主 /2含子 /3全部）</label><input type="number" min="1" max="3" id="we-inject-depth" value="${s.tracking.injectionDepth}"></div>
            <div class="we-field"><label>冷却阈值（层）</label><input type="number" min="0" id="we-cooldown" value="${s.tracking.cooldownThreshold}"></div>
            <div class="we-field"><label>交互上限（0=不限）</label><input type="number" min="0" id="we-int-limit" value="${s.tracking.interactionLimit}"></div>
            <div class="we-field"><label>每批整理角色数</label><input type="number" min="1" max="10" id="we-batch-size" value="${s.tracking.batchSize}"></div>
            <div class="we-field"><label>更新时带最近几条小结</label><input type="number" min="0" max="10" id="we-note-count" value="${s.tracking.noteCount}"></div>
        </div>

        <div class="we-sect-title">输入装配（每轮演化到底给模型喂什么）</div>
        <div class="we-sub">每一项都能单独关掉。关掉 = 这一路不进提示词、不占 token；提示词里对应的 <b>{{占位符}}</b> 仍在，你可以自己决定怎么用它。
        想看每次真实的完整提示词：先点「保存设置」，再去「日志」页看最近 10 次（含模型原始输出）。</div>
        <label class="we-inline"><input type="checkbox" id="we-feed-chat" ${cb(feed.chat)}> <b>{{chat}}</b> 最近 N 层正文（层数在上面的「追踪参数」里调）</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-state" ${cb(feed.state)}> <b>{{state}}</b> 完整世界状态（角色越多这行越大）</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-worldinfo" ${cb(feed.worldinfo)}> <b>{{worldinfo}}</b> 命中的世界书条目</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-memory" ${cb(feed.memory)}> <b>{{memory}}</b> 外部剧情记忆（小白X 导入的）</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-notes" ${cb(feed.notes)}> <b>{{recentNotes}}</b> 最近几次的工作小结</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-mustcover" ${cb(feed.mustCover)}> <b>{{mustCover}}</b> 本轮必须覆盖的角色清单</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-scene" ${cb(feed.scene)}> <b>{{scene}}</b> 本轮正在现场的角色</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-jump" ${cb(feed.jump)}> <b>{{jump}}</b> 上次世界时间 → 现在</label>
        <label class="we-inline"><input type="checkbox" id="we-feed-names" ${cb(feed.names)}> <b>{{user}} / {{char}}</b> 主角与用户的名字</label>
        <div class="we-row" style="margin-top:6px">
            <button data-act="feed-all">全部开启</button>
            <button data-act="feed-min">只留世界状态 + 正文</button>
            <button data-act="feed-none">全部关闭</button>
        </div>
        <div class="we-hint" id="we-feed-est">正在估算当前输入体积…</div>

        <div class="we-sect-title">世界书</div>
        <label class="we-inline"><input type="checkbox" id="we-wb-enabled" ${cb(s.worldbook.enabled)}> 启用世界书</label>
        <div class="we-field"><label>世界书名（留空=自动取角色卡绑定的）</label><input type="text" id="we-wb-name" value="${escapeHtml(s.worldbook.name)}"></div>
        <label class="we-inline"><input type="checkbox" id="we-wb-nsfw" ${cb(s.worldbook.includeNsfw)}> 整理角色时一并带入 NSFW 条目</label>
        <label class="we-inline"><input type="checkbox" id="we-wb-dropover" ${cb(s.worldbook.organizeDropOverview !== false)}> 分批整理时不再重复塞「人物速览」（第 1 步已经用过）</label>
        <div class="we-field"><label>单次带入字数软上限（0=不限）</label><input type="number" min="0" id="we-wb-maxchars" value="${Number(s.worldbook.maxChars) || 0}"></div>
        <div class="we-row"><button data-act="probe-wb">检查世界书读取</button><button data-act="goto-entries">管理条目</button></div>

        <div class="we-sect-title">外部剧情记忆（小白X）</div>
        <div class="we-grid2">
            <div class="we-field"><label>带入多少条事件（0=全部）</label><input type="number" min="0" id="we-mem-events" value="${Number(s.memory.eventLimit) || 0}"></div>
            <div class="we-field"><label>每人轨迹带几条最近进展</label><input type="number" min="0" id="we-mem-moments" value="${Number(s.memory.momentCount) || 3}"></div>
            <div class="we-field"><label>记忆文本软上限字数（0=不限）</label><input type="number" min="0" id="we-mem-maxchars" value="${Number(s.memory.maxChars) || 0}"></div>
            <div class="we-field"><label>导入时分批：每批多少条事件（0=不分批，一次性塞；建议 15~25）</label><input type="number" min="0" id="we-mem-batch" value="${Number(s.memory.batchEvents) || 0}"></div>
        </div>

        <div class="we-sect-title">维护</div>
        <label class="we-inline"><input type="checkbox" id="we-autofill" ${cb(s.tracking.autoFill)}> 更新后自动补全被漏掉的角色（含家人子分支）。<b>关闭时一次演化只发一次请求、更快；漏掉的角色会在下一轮自动补推，不会永久丢</b></label>
        <div class="we-field" style="margin-left:22px"><label>漏掉几人以上才补一轮（补全要再发一次请求；调大 = 更省时间，1 = 每次都补）</label><input type="number" min="1" max="30" id="we-fillmin" value="${Math.max(1, Number(s.tracking.fillMinMissing) || 3)}"></div>
        <label class="we-inline"><input type="checkbox" id="we-autofallback" ${cb(s.tracking.autoFallback)}> 初始化时若一个交互都没有，自动兜底硬提（默认关：没人就是 0）</label>
        <label class="we-inline"><input type="checkbox" id="we-mergesame" ${cb(s.tracking.mergeSameName !== false)}> 同一人挂在多处时共享状态（如「儿子陈浩」与「秘密男友陈浩」）</label>
        <label class="we-inline"><input type="checkbox" id="we-mergedup" ${cb(s.tracking.mergeDuplicates !== false)}> 同一人挂在多处时<b>合并成一处</b>（关掉只共享状态，世界树上仍会出现多个同名的人）</label>
        <label class="we-inline"><input type="checkbox" id="we-timeslot" ${cb(s.tracking.timeSlot !== false)}> <b>状态有效期</b>：每个状态带一个时间段（如「买菜 8:00-9:00」），世界时间没走到截止时刻就不重复推演他；到期了才换新状态。关掉 = 每轮照旧全量重估</label>
        <label class="we-inline"><input type="checkbox" id="we-sceneg" ${cb(s.tracking.sceneGuard !== false)}> <b>现场保护</b>：正文刚演过的角色不再被推演出新一层状态（推荐开）</label>
        <div class="we-field" style="margin-left:22px"><label>现场看最近几层正文</label><input type="number" min="1" max="6" id="we-scened" value="${Number(s.tracking.sceneDepth) || 2}"></div>
        <div class="we-sect-title">实验性（不推荐依赖）</div>
        <label class="we-inline"><input type="checkbox" id="we-snapshots" ${cb(s.tracking.snapshots)}> 保存快照（每轮全量存一份，最多 10 份，state 会明显变胖）</label>
        <label class="we-inline"><input type="checkbox" id="we-auto-rollback" ${cb(s.tracking.autoRollback)}> 删楼时自动回退世界状态（需先开快照；10 份上限，长聊天基本覆盖不到你要的那层 —— 开之前先看 README「删楼与世界状态」）</label>
        <div class="we-row" style="margin-top:6px">
            <button data-act="reset-ball">悬浮球不见了？点这里归位（回右下角）</button>
            <button data-act="ball-diag">诊断悬浮球</button>
        </div>
        <div id="we-ball-diag" class="we-diagbox" style="display:none"></div>
        <div class="we-sub">手机上看不到悬浮球时：在聊天输入框里输入 <b>/we</b> 也能打开这个面板（<b>/we reset</b> 归位）。面板现在贴屏幕底部，页签在最上面一条，看不到就是没刷新到新版。</div>

        <div class="we-sect-title">正文写入</div>
        <label class="we-inline"><input type="checkbox" id="we-write-enabled" ${cb(s.writeToChat.enabled)}> 生成后把世界动态写入最新楼层正文</label>
        <label class="we-inline"><input type="checkbox" id="we-write-auto" ${cb(s.writeToChat.auto)}> 不用确认，直接写入</label>
        <div class="we-field"><label>写入几个角色（只挑最关键的：本轮有变化 > 交互）</label><input type="number" min="1" max="10" id="we-write-topn" value="${Number(s.writeToChat.topN) || 3}"></div>
        <div class="we-row" style="gap:12px">
            <label class="we-inline"><input type="checkbox" id="we-wc-interaction" ${cb(cats.interaction)}> 交互</label>
            <label class="we-inline"><input type="checkbox" id="we-wc-cooldown" ${cb(cats.cooldown)}> 冷却</label>
            <label class="we-inline"><input type="checkbox" id="we-wc-unseen" ${cb(cats.unseen)}> 未出场</label>
        </div>
        <div class="we-hint">想看完整世界状态就点悬浮球面板，正文里只放最关键的几条，别让报表淹没剧情。</div>
        <div class="we-row"><button data-act="clear-write">清除最新楼层的世界动态</button></div>

        <div class="we-sect-title">上下文注入</div>
        <div class="we-sub">防全知：正文 AI 看到的是「全员动向」（谁在哪、在做什么 —— 公开可见的事）＋「现场人物内心」（只有正文正在演的人给心情/目标）。远处的人心里想什么，它不会知道。</div>
        <label class="we-inline"><input type="checkbox" id="we-inject-enabled" ${cb(s.inject.enabled)}> 把世界状态注入 AI 上下文</label>
        <label class="we-inline"><input type="checkbox" id="we-inject-persona" ${cb(s.inject.persona !== false)}> 一并注入「角色性格」块（人设参考；嫌占 token 可关）</label>
        <label class="we-inline"><input type="checkbox" id="we-inject-skip" ${cb(s.inject.skipWritten)}> 已写进正文的类别不再注入</label>
        <div class="we-field"><label>注入位置</label><select id="we-inject-pos">
            <option value="beforeLast" ${s.inject.position === 'beforeLast' ? 'selected' : ''}>最近一条消息之前</option>
            <option value="afterSystem" ${s.inject.position === 'afterSystem' ? 'selected' : ''}>紧跟系统提示之后</option>
        </select></div>

        <div class="we-row" style="margin-top:6px">
            <button class="we-primary" data-act="save-settings">保存设置</button>
            <button data-act="export">导出世界状态 JSON</button>
        </div>

        <div class="we-sect-title" style="color:#d9534f">危险操作</div>
        <div class="we-sub">清空本聊天的<b>全部世界数据</b>：角色树、日志与工作小结、大事记、整理草稿、外部记忆、快照。清完等于回到没装插件时的状态，<b>不可恢复</b>。你的设置、提示词、API 配置不受影响。</div>
        <div class="we-row"><button data-act="wipe-all-data">清空一切数据（本聊天）</button></div>
    </div>`;
}

function collectSettings() {
    const s = getSettings();
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const num = (id, d) => { const v = Number(val(id)); return Number.isFinite(v) ? v : d; };
    const has = (id) => !!document.getElementById(id);

    if (has('we-enabled')) s.enabled = chk('we-enabled');
    if (has('we-auto')) s.autoUpdate = chk('we-auto');
    if (has('we-fallback')) s.allowFallback = chk('we-fallback');
    if (has('we-debug')) s.debug = chk('we-debug');
    // 外观（读不到控件时保持原值，别把用户选择清掉）
    s.ui = s.ui || {};
    if (document.getElementById('we-theme')) s.ui.theme = val('we-theme') || 'auto';
    if (has('we-api-mode')) s.api.mode = val('we-api-mode') || 'tavern';
    if (has('we-tavern-profile')) s.api.tavernProfile = val('we-tavern-profile') || '';
    if (has('we-api-url')) s.api.url = val('we-api-url').trim();
    if (has('we-api-key')) s.api.key = val('we-api-key').trim();
    if (has('we-api-model')) s.api.model = val('we-api-model').trim();
    if (has('we-api-temp')) s.api.temperature = num('we-api-temp', 0.45);
    if (has('we-api-maxtokens')) s.api.maxTokens = Math.max(256, num('we-api-maxtokens', 4096));
    if (document.getElementById('we-include-preset')) s.api.includePreset = chk('we-include-preset');
    if (has('we-update-depth')) s.tracking.updateDepth = num('we-update-depth', 3);
    if (has('we-init-depth')) s.tracking.initDepth = num('we-init-depth', 40);
    if (has('we-inject-depth')) s.tracking.injectionDepth = num('we-inject-depth', 2);
    if (has('we-cooldown')) s.tracking.cooldownThreshold = num('we-cooldown', 20);
    if (has('we-int-limit')) s.tracking.interactionLimit = num('we-int-limit', 0);
    if (has('we-wb-enabled')) s.worldbook.enabled = chk('we-wb-enabled');
    if (has('we-wb-name')) s.worldbook.name = val('we-wb-name').trim();
    if (has('we-wb-nsfw')) s.worldbook.includeNsfw = chk('we-wb-nsfw');
    if (has('we-wb-dropover')) s.worldbook.organizeDropOverview = chk('we-wb-dropover');
    if (has('we-wb-maxchars')) s.worldbook.maxChars = num('we-wb-maxchars', 0);
    if (has('we-batch-size')) s.tracking.batchSize = Math.max(1, num('we-batch-size', 3));
    if (has('we-note-count')) s.tracking.noteCount = Math.max(0, num('we-note-count', 3));
    if (has('we-autofill')) s.tracking.autoFill = chk('we-autofill');
    if (has('we-fillmin')) s.tracking.fillMinMissing = Math.max(1, Math.min(30, num('we-fillmin', 3)));
    if (has('we-autofallback')) s.tracking.autoFallback = chk('we-autofallback');
    if (has('we-mergesame')) s.tracking.mergeSameName = chk('we-mergesame');
    if (has('we-mergedup')) s.tracking.mergeDuplicates = chk('we-mergedup');
    if (has('we-timeslot')) s.tracking.timeSlot = chk('we-timeslot');
    if (has('we-sceneg')) s.tracking.sceneGuard = chk('we-sceneg');
    if (has('we-scened')) s.tracking.sceneDepth = Math.max(1, Math.min(6, num('we-scened', 2)));
    if (has('we-auto-rollback')) s.tracking.autoRollback = chk('we-auto-rollback');
    if (has('we-snapshots')) s.tracking.snapshots = chk('we-snapshots');
    if (has('we-mem-events')) s.memory.eventLimit = Math.max(0, num('we-mem-events', 0));
    if (has('we-mem-moments')) s.memory.momentCount = Math.max(0, num('we-mem-moments', 3));
    if (has('we-mem-maxchars')) s.memory.maxChars = Math.max(0, num('we-mem-maxchars', 0));
    if (has('we-mem-batch')) s.memory.batchEvents = Math.max(0, num('we-mem-batch', 0));
    // 输入装配开关（元素不存在时保持原值，避免"设置页没渲染完就把开关全关掉"）
    const feedKeys = ['chat', 'state', 'worldinfo', 'memory', 'notes', 'mustCover', 'scene', 'jump', 'names'];
    s.feed = s.feed || {};
    const feedIds = {
        chat: 'we-feed-chat', state: 'we-feed-state', worldinfo: 'we-feed-worldinfo',
        memory: 'we-feed-memory', notes: 'we-feed-notes', mustCover: 'we-feed-mustcover',
        scene: 'we-feed-scene', jump: 'we-feed-jump', names: 'we-feed-names',
    };
    const feedMissing = [];
    feedKeys.forEach((k) => {
        const el = document.getElementById(feedIds[k]);
        if (el && typeof el.checked === 'boolean') s.feed[k] = !!el.checked;
        else {
            feedMissing.push(k);
            // 读取失败绝不擅自改成 true：只在根本没有这个键时才补默认值。
            // （如果这里无脑置 true，用户点过「全部关闭」后在别处保存一次就会全被打开）
            if (s.feed[k] === undefined) s.feed[k] = true;
        }
    });
    if (has('we-write-enabled')) s.writeToChat.enabled = chk('we-write-enabled');
    if (has('we-write-auto')) s.writeToChat.auto = chk('we-write-auto');
    if (has('we-write-topn')) s.writeToChat.topN = Math.min(10, Math.max(1, num('we-write-topn', 3)));
    if (has('we-wc-interaction')) s.writeToChat.categories = {
        interaction: chk('we-wc-interaction'),
        cooldown: chk('we-wc-cooldown'),
        unseen: chk('we-wc-unseen'),
    };
    if (has('we-inject-enabled')) s.inject.enabled = chk('we-inject-enabled');
    if (has('we-inject-persona')) s.inject.persona = chk('we-inject-persona');
    if (has('we-inject-skip')) s.inject.skipWritten = chk('we-inject-skip');
    if (has('we-inject-pos')) s.inject.position = val('we-inject-pos');
    saveSettings();
    return feedMissing;
}

/* ---------------- 提示词 ---------------- */

function renderPrompts() {
    const tag = (kind) => (isCustomPrompt(kind) ? '<span class="we-badge we-b-sed">已自定义</span>' : '<span class="we-badge we-b-unseen">内置默认</span>');
    const fold = (kind, title, hint, ph, id, minH) => {
        const txt = getPrompt(kind);
        return `<details class="we-fold we-promptfold">
            <summary>${title} ${tag(kind)} <span class="we-sub">｜ ${txt.length} 字</span></summary>
            <div class="we-sub" style="margin-top:6px">${hint}</div>
            <div class="we-sub">可用占位符：${ph}</div>
            <textarea id="${id}" style="min-height:${minH}px;margin-top:4px">${escapeHtml(txt)}</textarea>
            <div class="we-row" style="margin-top:6px">
                <button data-act="save-prompts">保存全部提示词</button>
                <button data-act="reset-${kind}">恢复默认</button>
            </div>
        </details>`;
    };
    return `<div class="we-form">
        <div class="we-hint">三套提示词互相独立，<b>默认收起来了</b> —— 点标题展开才会看到全文。留空/清空 = 用内置默认。<br>
        <b>不改就用内置的</b>，完全够用；只有想调语气/加规矩时才需要展开。</div>

        ${fold('roster', '① 建档提示词（第 1 步：只认人）',
            '读人物速览，列一张花名册：谁是谁、和谁有关系。不写性格、不建树、不写状态。',
            '{{user}} {{char}} {{worldinfo}} {{chat}}', 'we-p-roster', 200)}

        ${fold('organize', '② 整理提示词（第 2 步：定性格 + 建关系）',
            '分批精读本批角色的世界书条目，定性格（5 维）、建关系网（情人 &gt; 家人）、写工作小结。',
            '{{user}} {{char}} {{worldinfo}}（只含本批条目）{{batch}} {{notes}} {{state}}', 'we-p-organize', 220)}

        ${fold('update', '③ 更新提示词（第 3 步：载入近期剧情）',
            '读最近几层剧情，增量更新每个角色的状态；性格字段被锁死，改不动。',
            '{{chat}} {{state}} {{worldinfo}} {{user}} {{char}} {{jump}} {{mustCover}} {{memory}} {{recentNotes}}', 'we-p-update', 220)}
    </div>`;
}

/* ---------------- 日志（工作小结 + 完整调用记录） ---------------- */

function kindLabel(kind) {
    return ({
        roster: '建档·认人',
        organize: '建档·整理',
        'organize-final': '建档·定稿',
        'update-auto': '更新·自动',
        'update-manual': '更新·手动',
        'update-fill': '更新·补漏',
        memory: '记忆导入',
        system: '系统',
    })[kind] || kind || '其它';
}

function kindGroup(kind) {
    const k = String(kind || '');
    if (/^(roster|organize|init)/.test(k)) return 'build';
    return 'update';
}

function logTypeLabel(type) {
    return ({
        'init-roster': '建档·认人',
        'init-organize': '建档·整理',
        'organize-final': '建档·定稿',
        'update-auto': '更新·自动',
        'update-manual': '更新·手动',
        'update-fill': '更新·补漏',
        'memory-import': '记忆导入',
    })[type] || type || '';
}

function filterBar(counts) {
    const btn = (key, label) => `<button data-act="log-filter" data-kind="${key}" class="${logFilter === key ? 'we-active' : ''}">${label}</button>`;
    return `<div class="we-row we-logfilter">
        ${btn('worklog', `只看小结（${counts.worklog}）`)}
        ${btn('build', `建档（${counts.build}）`)}
        ${btn('update', `更新（${counts.update}）`)}
        ${btn('all', `全部（${counts.all}）`)}
    </div>`;
}

/** 触发一次纯文本下载（用于导出完整提示词） */
function downloadText(filename, text) {
    try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        }, 0);
        return true;
    } catch (e) {
        console.error('[WorldEngine] 导出失败', e);
        return false;
    }
}

function renderLogs() {
    const state = getState();
    const worklogs = state.worklogs || [];
    const logs = state.logs || [];

    const counts = {
        worklog: worklogs.length,
        all: worklogs.length + logs.length,
        build: worklogs.filter((w) => kindGroup(w.kind) === 'build').length,
        update: worklogs.filter((w) => kindGroup(w.kind) === 'update').length,
    };

    const showWork = logFilter === 'worklog' || logFilter === 'all'
        || logFilter === 'build' || logFilter === 'update';
    const showLogs = logFilter === 'all' || logFilter === 'build' || logFilter === 'update';

    const pickWork = worklogs.filter((w) => (
        logFilter === 'worklog' || logFilter === 'all' ? true : kindGroup(w.kind) === logFilter
    ));
    const pickLogs = logs.filter((l) => (
        logFilter === 'all' ? true : kindGroup(l.type) === logFilter
    ));

    const out = [];
    out.push('<div class="we-hint">上面是「这一轮我干了什么」的工作小结（会回流进提示词，让模型知道上一轮做过什么）；下面是每次调用的提示词与模型原始输出，默认全部折叠。<b>提示词超过 14000 字会被截断</b>（一次演化的输入常常 2 万字以上），想核对原件请用下面的导出按钮。</div>');
    out.push(`<div class="we-row">
        <button data-act="export-prompt">导出最新一次的完整提示词</button>
        <button data-act="logs-export">导出全部日志（txt）</button>
        <button data-act="logs-clear">清空日志与小结</button>
    </div>`);
    out.push(filterBar(counts));

    if (showWork) {
        out.push(`<div class="we-sect-title">工作小结（${pickWork.length} 条）</div>`);
        if (!pickWork.length) {
            out.push('<div class="we-sub">还没有小结。做完第 1 步或第 3 步之后就会出现。</div>');
        } else {
            pickWork.forEach((w, i) => {
                out.push(`<div class="we-worklog">
                    <div class="we-wl-head">
                        <span class="we-wl-n">#${pickWork.length - i}</span>
                        <span class="we-badge we-b-${kindGroup(w.kind) === 'build' ? 'interaction' : 'cooldown'}">${escapeHtml(kindLabel(w.kind))}</span>
                        <span class="we-wl-text">${escapeHtml(w.summary)}</span>
                        <span class="we-sub">${escapeHtml(w.at || '')}</span>
                        <button class="we-mini-del" data-act="worklog-del" data-idx="${state.worklogs.indexOf(w)}" title="删除这条小结">删除</button>
                    </div>
                    ${w.note ? `<div class="we-sub">${escapeHtml(w.note)}</div>` : ''}
                </div>`);
            });
        }
    }

    if (showLogs) {
        out.push(`<div class="we-sect-title">完整调用记录（${pickLogs.length} 次）</div>`);
        if (!pickLogs.length) {
            out.push('<div class="we-sub">没有调用记录。</div>');
        } else {
            pickLogs.forEach((l, i) => {
                const ok = l.ok === false ? '<span class="we-badge we-b-red">失败</span>' : '';
                out.push(`<details class="we-fold we-logfold">
                    <summary>
                        <span class="we-wl-n">#${pickLogs.length - i}</span>
                        <span class="we-sub">${escapeHtml(logTypeLabel(l.type))}</span>
                        ${ok}
                        <span class="we-sub">${escapeHtml(l.at || '')}${l.ms ? ` ｜ ${l.ms}ms` : ''}</span>
                    </summary>
                    <div class="we-row">
                        <button data-act="copy" data-idx="${state.logs.indexOf(l)}" data-kind="prompt">复制提示词</button>
                        <button data-act="copy" data-idx="${state.logs.indexOf(l)}" data-kind="response">复制输出</button>
                        <button data-act="log-del" data-idx="${state.logs.indexOf(l)}">删除这条</button>
                    </div>
                    <div class="we-sub">提示词</div>
                    <pre class="we-logpre">${escapeHtml(l.prompt || '（空）')}</pre>
                    <div class="we-sub">模型原始输出</div>
                    <pre class="we-logpre">${escapeHtml(l.response || l.error || '（空）')}</pre>
                </details>`);
            });
        }
    }
    return out.join('');
}

/* ---------------- 编辑 ---------------- */

function renderEdit() {
    const state = getState();
    return `<div class="we-form">
        <div class="we-hint">直接编辑协议文本，整体覆盖式保存（隐藏标记会自动继承）。格式：角色名 【类别】 时间 地点 做什么 / 心情：x / 目标：y；子分支写「父 &gt; 子」；@time 行是世界时间；@hide 行是隐藏名单。</div>
        <textarea id="we-edit-text" style="min-height:320px">${escapeHtml(serialize(state))}</textarea>
        <div class="we-row"><button class="we-primary" data-act="save-edit">保存覆盖</button><button data-act="cancel-edit">返回</button></div>
    </div>`;
}

/* ---------------- 输入装配估算 ---------------- */

/**
 * 按当前「输入装配」开关，估算下一次演化请求里每一路输入的字数。
 * 这是"我终于能看见自己喂了什么"的那把尺子 —— 不需要真的发请求。
 * 数字是字符数（中文≈token 数的一半到一倍，看内容），用来比较相对大小足够。
 */
function estimateFeedChars() {
    const s = getSettings();
    const on = (k) => s.feed[k] !== false;
    const state = getState();
    const out = { state: 0, chat: 0, worldinfo: 0, memory: 0, other: 0, total: 0 };

    if (on('state')) out.state = serialize(state).length;

    if (on('chat')) {
        try {
            const msgs = getRecentChat(Math.max(1, Number(s.tracking.updateDepth) || 3));
            out.chat = msgs.reduce((n, m) => n + String(m && m.mes ? m.mes : '').length, 0);
        } catch (e) { out.chat = 0; }
    }

    if (on('worldinfo')) {
        // 优先用"上次实际带进去的长度"（真实值）；没有就按世界书是否启用给个提示性占位
        const last = state._feedStats && Number(state._feedStats.worldinfo);
        if (last) out.worldinfo = last;
        else if (s.worldbook.enabled) out.worldinfo = 0;   // 未知 → 显示为 "—"
    }

    if (on('memory')) out.memory = (state.memoryText || '').length;

    if (on('notes')) out.other += (state.worklogs || []).slice(0, Number(s.tracking.noteCount) || 3)
        .reduce((n, w) => n + String(w.summary || '').length, 0);

    if (on('mustCover')) {
        // 点名清单 ≈ 角色名长度之和；估不准就直接用上次实测值
        const last = state._feedStats && Number(state._feedStats.mustCover);
        out.other += last || Math.min(600, Object.keys(state.nodes || {}).length * 8);
    }
    if (on('scene')) {
        const last = state._feedStats && Number(state._feedStats.scene);
        out.other += last || 0;
    }
    out.other += getPrompt('update').length;   // 提示词本身的固定开销

    out.total = out.state + out.chat + out.worldinfo + out.memory + out.other;
    out.measured = !!(state._feedStats && state._feedStats.prompt);
    out.measuredTotal = out.measured ? Number(state._feedStats.prompt) : 0;
    return out;
}

/**
 * 刷新设置页上那行"当前输入约 N 字"的估算提示。
 * 放在 render 之后调用，避免在 HTML 字符串里算（那时 DOM 还没生成）。
 */
function refreshFeedEstimate() {
    const el = document.getElementById('we-feed-est');
    if (!el) return;
    const est = estimateFeedChars();
    const pct = (v) => (est.total ? Math.round((v / est.total) * 100) : 0);
    const measured = est.measured
        ? `<br><span class="we-sub">上次实测：发送给模型的提示词共 <b>${est.measuredTotal}</b> 字`
        + `${state_feedAt() ? `（${state_feedAt()}）` : ''} —— 这就是你每轮真实付出的输入体积</span>`
        : '<br><span class="we-sub">还没实测过，点一次「立即更新」后这里会显示上次真实发送的字节数</span>';
    el.innerHTML = `按当前开关估算，每次演化输入约 <b>${est.total}</b> 字 `
        + `<span class="we-sub">（世界状态 ${est.state}·${pct(est.state)}% ｜ 正文 ${est.chat}·${pct(est.chat)}% ｜ `
        + `世界书 ${est.worldinfo || '—'} ｜ 记忆 ${est.memory} ｜ 提示词+其他 ${est.other}）</span>`
        + measured;
}

/** 上次实测时间（没有就是空串） */
function state_feedAt() {
    try {
        const st = getState();
        return (st._feedStats && st._feedStats.at) || '';
    } catch (e) { return ''; }
}

/* ---------------- 交互 ---------------- */

function onClick(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    // 页签优先处理：以前被 data-act 的判断挡在前面，偶尔会漏掉
    const tabBtn = target.closest('.we-tabs button');
    if (tabBtn && tabBtn.dataset && tabBtn.dataset.tab) {
        currentTab = tabBtn.dataset.tab;
        render();
        return;
    }

    const t = target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    try {
        handleAction(act, t);
    } catch (err) {
        console.error(err);
        toast(`操作失败：${err.message}`, 'error');
    }
}

function onChange(e) {
    const id = e.target.id || '';
    // 换外观：立刻应用，不用等下次开面板（collectSettings 在后面照常跑一遍，幂等）
    if (id === 'we-theme') {
        const st = getSettings();
        st.ui = st.ui || {};
        st.ui.theme = e.target.value || 'auto';
        try { saveSettings(); } catch (err) { /* ignore */ }
        try { applyTheme(panelEl); } catch (err) { /* ignore */ }
    }
    const char = e.target.dataset ? e.target.dataset.char : '';
    if (char) {
        // 建档页角色勾选 → 只局部刷新条目区，不整页重渲染
        // （v2.3.14：以前这里 render() 整页重建，滚动位置丢失，勾一下就跳回顶部）
        const all = Array.from(document.querySelectorAll('.we-char-cb')).filter((cb) => cb.checked).map((cb) => cb.dataset.char);
        pickedCharacters = all;
        orgEntryUids = null;   // 重新按新角色自动命中
        refreshPickUI();
        return;
    }
    if (e.target.classList && e.target.classList.contains('we-org-entry-cb')) {
        // 第 2 步：手动勾/去勾本批要带入的条目
        orgEntryUids = Array.from(document.querySelectorAll('.we-org-entry-cb'))
            .filter((cb) => cb.checked)
            .map((cb) => cb.dataset.uid);
        return;
    }
    if (e.target.classList && e.target.classList.contains('we-entry-cb')) {
        // 条目勾选：即时保存，避免"点了没保存/切回来又变回去"
        const uids = Array.from(document.querySelectorAll('.we-entry-cb'))
            .filter((cb) => cb.checked)
            .map((cb) => cb.dataset.uid);
        const s = getSettings();
        s.worldbook.selectedUids = uids;
        s.worldbook.selectionMade = true;
        saveSettings();
        const stats = document.getElementById('we-entry-stats');
        if (stats) stats.innerHTML = entriesStatsText();
        return;
    }
    if (id === 'we-api-model-select') {
        const v = e.target.value;
        if (!v) return;
        const s = getSettings();
        s.api.model = v;
        saveSettings();
        const input = document.getElementById('we-api-model');
        if (input) input.value = v;
        toast(`已选模型：${v}`);
        return;
    }
    if (id === 'we-memory-input') {
        memoryDraft = e.target.value;
        return;
    }
    if (id === 'we-batch-nsfw') {
        const s = getSettings();
        s.worldbook.includeNsfw = !!e.target.checked;
        saveSettings();
        return;
    }
    if (id.startsWith('we-')) {
        if (e.target.type === 'checkbox' || e.target.type === 'number' || e.target.tagName === 'SELECT') {
            collectSettings();
        }
    }
}

async function handleAction(act, el) {
    const t = el;   // 统一别名，避免下方混用 t/el 笔误
    const s = getSettings();

    if (act === 'close') { closePanel(); return; }
    if (act === 'edit') { currentTab = 'edit'; render(); return; }
    if (act === 'goto-build') { currentTab = 'build'; render(); return; }
    if (act === 'goto-entries') { currentTab = 'entries'; render(); return; }
    if (act === 'cancel-edit') { currentTab = 'state'; render(); return; }

    /* ---- 建档分步 ---- */
    if (act === 'stage-roster') {
        if (busy) return;
        if (Object.keys(getState().nodes || {}).length && !confirm('已有角色表，重新生成会重建角色骨架（隐藏标记保留）。继续？')) return;
        await runStage('roster', (prog) => buildRoster({ onProgress: prog }));
        return;
    }
    if (act === 'stage-organize') {
        if (busy) return;
        const names = Array.from(document.querySelectorAll('.we-char-cb')).filter((cb) => cb.checked).map((cb) => cb.dataset.char);
        if (!names.length) { toast('请先勾选要整理的角色', 'error'); return; }
        const nsfw = document.getElementById('we-batch-nsfw');
        const includeNsfw = nsfw ? nsfw.checked : undefined;
        const poEl = document.getElementById('we-batch-personaonly');
        const personaOnly = poEl ? poEl.checked : false;   // 只补性格模式（v2.3.15）
        // 本批要带入哪些条目：优先用界面上勾的（可能手动改过）
        const boxes = Array.from(document.querySelectorAll('.we-org-entry-cb'));
        const entryUids = boxes.length ? boxes.filter((cb) => cb.checked).map((cb) => cb.dataset.uid) : (Array.isArray(orgEntryUids) ? orgEntryUids : undefined);
        await runStage('organize', (prog) => organizeBatch(names, { onProgress: prog, includeNsfw, entryUids, personaOnly }), `正在整理 ${names.join('、')}`);
        // 跑完一批自动接上下一批（v2.3.14）：以前是靠渲染时"空就自动补勾"兜的，
        // 现在改成在这里显式挑 —— 这样"手动全部取消"才能保持空
        const stAfter = getState();
        const builtNow = stAfter.built || [];
        const nextSize = Math.max(1, Number(getSettings().tracking.batchSize) || 3);
        pickedCharacters = topNodes(stAfter).map((n) => n.name).filter((n) => !builtNow.includes(n)).slice(0, nextSize);
        orgEntryUids = null;   // 下一批按新角色重新自动命中
        render();              // 让勾选框刷新成下一批
        return;
    }
    if (act === 'toggle-build') {
        buildExpanded = !buildExpanded;
        render();
        return;
    }
    if (act === 'org-entries-matched' || act === 'org-entries-all' || act === 'org-entries-none') {
        const s0 = getSettings();
        const usable = selectedEntries(entryCache.entries);
        if (act === 'org-entries-all') {
            orgEntryUids = usable.map((e) => e.uid);
        } else if (act === 'org-entries-none') {
            orgEntryUids = [];
        } else {
            const matched = entriesForNames(usable, pickedCharacters, { includeNsfw: !!s0.worldbook.includeNsfw });
            orgEntryUids = matched.map((e) => e.uid);
            if (!matched.length) toast('没有条目命中本批角色（世界书里的名字可能和角色名对不上）', 'error');
        }
        render();
        return;
    }
    if (act === 'stage-finalize') {
        if (busy) return;
        if (!(getState().drafts || []).length && Object.keys(getState().nodes || {}).length) {
            if (!confirm('现在没有整理草稿。直接定稿会把世界标成"运行中"（不会清空已有内容）。继续？')) return;
        }
        await runStage('finalize', (prog) => finalizeOrganize({ onProgress: prog }));
        return;
    }
    if (act === 'stage-rebuild') {
        if (busy) { toast('任务进行中，等它跑完再清空重来', 'error'); return; }
        if (!confirm('清空当前世界状态（快照与大事记也会清掉），从第 1 步重新来。确定？')) return;
        clearState();
        entryCache.loaded = false;
        pickedCharacters = [];
        orgEntryUids = null;
        buildExpanded = false;
        buildStatus = '';
        currentTab = 'build';
        render();
        toast('已清空，请从第 1 步开始');
        return;
    }

    // 清空一切（v2.3.10）：本聊天的全部世界数据一键归零。
    // 与「清空重来」的区别：那个是"从头建档"的快捷入口（还留在建档流程里），
    // 这个是"彻底回零"——日志、草稿、记忆、快照全清，且不跳回建档页。
    if (act === 'wipe-all-data') {
        if (busy) { toast('任务进行中，等它跑完再清空', 'error'); return; }
        if (!confirm('将清空本聊天的所有世界数据：角色树、日志与工作小结、大事记、整理草稿、外部记忆、快照。\n\n你的设置、提示词、API 配置不受影响。\n\n确定继续？')) return;
        if (!confirm('再确认一次：清空后不可恢复。真的要清空一切数据吗？')) return;
        clearState();
        entryCache.loaded = false;
        pickedCharacters = [];
        orgEntryUids = null;
        buildExpanded = false;
        buildStatus = '';
        memoryDraft = '';
        memoryInfo = '';
        logFilter = 'worklog';
        lastDiag = '';
        currentTab = 'state';
        render();
        toast('已清空本聊天的全部世界数据');
        return;
    }
    if (act === 'pick-unbuilt') {
        const state = getState();
        const built = state.built || [];
        const size = Math.max(1, Number(getSettings().tracking.batchSize) || 3);
        pickedCharacters = topNodes(state).map((n) => n.name).filter((n) => !built.includes(n)).slice(0, size);
        refreshPickUI();   // 局部刷新，不整页重渲染（v2.3.14）
        return;
    }
    if (act === 'pick-none') { pickedCharacters = []; refreshPickUI(); return; }

    /* ---- 整理草稿 ---- */
    if (act === 'draft-save') {
        const id = el.dataset.id;
        const st = getState();
        const notesEl = document.querySelector(`.we-draft-notes[data-id="${id}"]`);
        const rawEl = document.querySelector(`.we-draft-raw[data-id="${id}"]`);
        updateDraft(st, id, {
            notes: notesEl ? notesEl.value : undefined,
            raw: rawEl ? rawEl.value : undefined,
        });
        commit(st);
        toast('草稿已保存');
        render();
        return;
    }
    if (act === 'draft-del') {
        const st = getState();
        removeDraft(st, el.dataset.id);
        commit(st);
        toast('已删除这份草稿');
        render();
        return;
    }
    if (act === 'draft-clear-all') {
        if (!confirm('清空全部整理草稿？下一批整理时就没有之前的小结可以比对了。')) return;
        const st = getState();
        clearDrafts(st);
        commit(st);
        toast('已清空全部草稿');
        render();
        return;
    }

    /* ---- 外部剧情记忆 ---- */
    if (act === 'memory-preview' || act === 'memory-import') {
        const ta = document.getElementById('we-memory-input');
        const text = ta ? ta.value : memoryDraft;
        memoryDraft = text;
        if (!text.trim()) { toast('先把记忆 JSON 粘进文本框', 'error'); return; }
        const s0 = getSettings();
        const r = lwbToText(text, {
            eventLimit: Number(s0.memory.eventLimit) || 0,
            momentCount: Number(s0.memory.momentCount) || 3,
            maxChars: Number(s0.memory.maxChars) || 0,
        });
        if (!r.parsed.ok) {
            memoryInfo = `解析失败：${escapeHtml(r.parsed.error)}　（也没关系——可以直接点「导入并整理」，我会把原文整段交给模型自己读）`;
            render();
            if (act === 'memory-preview') { toast('没解析成结构化记忆，可尝试直接导入', 'error'); return; }
        } else {
            memoryInfo = `解析成功：人物 ${r.stats.characters} ｜ 事件 ${r.stats.events} ｜ 轨迹 ${r.stats.arcs} ｜ 事实 ${r.stats.facts} ｜ 关键词 ${r.stats.keywords}；压缩后 <b>${r.text.length}</b> 字`;
        }
        if (act === 'memory-preview') { render(); toast('已解析，上面显示了统计'); return; }

        const payload = r.parsed.ok ? r.text : String(text).trim();
        if (busy) return;
        setBusy(true, '整理记忆');
        buildStatus = '导入记忆…';
        render();
        try {
            const out = await applyMemory(payload, {
                raw: text,
                onProgress: (t) => { buildStatus = t; render(); },
            });
            toast(`记忆已整理进角色状态：校正 ${out.covered.length} 个角色${out.batched ? '（分批）' : ''}`);
            memoryInfo = `${memoryInfo}<br>✓ 已导入。${escapeHtml(out.summary)}`;
        } catch (e) {
            console.error(e);
            toast(`导入失败：${e.message}`, 'error');
            memoryInfo = `导入失败：${escapeHtml(e.message)}`;
        } finally {
            buildStatus = '';
            setBusy(false);
            render();
        }
        return;
    }
    if (act === 'memory-copy-instruction') {
        copyText(COMPACT_INSTRUCTION);
        return;
    }
    if (act === 'memory-clear') {
        if (!confirm('清除已导入的外部记忆？（角色状态不变，只是之后更新不再自动带上它）')) return;
        const st = getState();
        st.memoryText = '';
        st.memoryRaw = '';
        st.memoryAt = '';
        commit(st);
        memoryInfo = '';
        memoryDraft = '';
        toast('已清除');
        render();
        return;
    }

    /* ---- 日志筛选 ---- */
    if (act === 'log-filter') {
        logFilter = el.dataset.kind || 'worklog';
        render();
        return;
    }

    /* ---- 世界书条目 ---- */
    if (act === 'entries-refresh') { ensureEntriesLoaded(true); return; }
    if (act === 'entries-all' || act === 'entries-essentials' || act === 'entries-none') {
        const all = entryCache.entries;
        let uids = [];
        if (act === 'entries-all') uids = all.map((e) => e.uid);
        else if (act === 'entries-essentials') uids = all.filter((e) => e.isOverview).map((e) => e.uid);
        else uids = [];
        const st = getSettings();
        st.worldbook.selectedUids = uids;
        st.worldbook.selectionMade = true;   // 明确表达"挑过了"，这样"全不选"才留得住
        saveSettings();
        toast(act === 'entries-none'
            ? '已全不选：建档与更新都不会带世界书内容（仍可随时勾回来）'
            : `已选 ${uids.length} 条`);
        render();
        return;
    }
    if (act === 'entries-save') {
        const uids = Array.from(document.querySelectorAll('.we-entry-cb')).filter((cb) => cb.checked).map((cb) => cb.dataset.uid);
        const st = getSettings();
        st.worldbook.selectedUids = uids;
        st.worldbook.selectionMade = true;
        saveSettings();
        toast(`已保存：带入 ${uids.length} 条`);
        render();
        return;
    }

    if (act === 'eye') {
        const state = getState();
        toggleHidden(state, el.dataset.name);
        commit(state);
        render();
        return;
    }

    if (act === 'save-settings') {
        collectSettings();
        toast('设置已保存');
        render();
        return;
    }

    // 输入装配：三个预设 + 实时估算。
    // 预设的每一路都要显式写全 —— "某个键没提到"在旧实现里会留下上一次的值，
    // 用户点「全部关闭」却发现还有一路是开的，一定会以为按钮坏了。
    if (act === 'feed-all' || act === 'feed-min' || act === 'feed-none') {
        const prev = (getSettings().feed) || {};
        collectSettings();                       // 先把当前勾选落盘，避免覆盖用户刚点的
        const preset = act === 'feed-all'
            ? { chat: true, state: true, worldinfo: true, memory: true, notes: true, mustCover: true, scene: true, jump: true, names: true }
            : act === 'feed-min'
                ? { chat: true, state: true, worldinfo: false, memory: false, notes: false, mustCover: true, scene: true, jump: true, names: true }
                : { chat: false, state: false, worldinfo: false, memory: false, notes: false, mustCover: false, scene: false, jump: false, names: false };
        // 按"预设里有明确值的键"覆盖，其余保留原值（控制台已经写全，这里是双保险）
        const allFlags = ['chat', 'state', 'worldinfo', 'memory', 'notes', 'mustCover', 'scene', 'jump', 'names'];
        const next = {};
        allFlags.forEach((k) => { next[k] = preset[k] !== undefined ? preset[k] : (prev[k] !== false); });
        s.feed = Object.assign({}, s.feed, next);
        saveSettings();
        render();
        if (act === 'feed-none') {
            // 全关 = 模型只剩提示词本身，会开始凭空白编。给一句明确的警告而不是普通成功提示。
            toast('已全部关闭 —— 注意：模型现在只看到提示词，会开始凭空编造角色状态。只适合用来测「到底是多少字在拖慢它」', 'error');
        } else {
            const est = estimateFeedChars();
            toast(`${act === 'feed-all' ? '已全部开启' : '已精简为「世界状态 + 正文 + 必要上下文」'} ｜ 预估输入 ${est.total} 字`);
        }
        return;
    }
    if (act === 'feed-est') {
        collectSettings();
        const est = estimateFeedChars();
        toast(`本次演化输入约 ${est.total} 字（状态 ${est.state} / 正文 ${est.chat} / 世界书 ${est.worldinfo} / 记忆 ${est.memory} / 其他 ${est.other}）`);
        return;
    }

    if (act === 'save-prompts') {
        // 提示词输入框在「提示词」页签。如果用户是在设置页点了别的按钮，
        // 这里读不到 textarea 会返回空串 → 把三套自定义提示词全部清空。
        // 所以先确认这三个框在不在，不在就直接拒绝保存。
        const present = ['we-p-roster', 'we-p-organize', 'we-p-update']
            .filter((id) => document.getElementById(id)).length;
        if (!present) { toast('请切到「提示词」页签再保存', 'error'); return; }
        const same = (id, kind) => {
            const t = document.getElementById(id);
            if (!t) return undefined;          // 框不在 → 不动这一项（undefined 由下面过滤掉）
            const v = String(t.value);
            return v.trim() === defaultPrompt(kind).trim() ? '' : v;
        };
        s.prompts = s.prompts || {};
        const next = {
            roster: same('we-p-roster', 'roster'),
            organize: same('we-p-organize', 'organize'),
            update: same('we-p-update', 'update'),
        };
        Object.keys(next).forEach((k) => { if (next[k] !== undefined) s.prompts[k] = next[k]; });
        s.prompts.init = '';   // 清掉旧字段，避免和新字段打架
        saveSettings();
        toast('三套提示词已保存');
        render();
        return;
    }
    if (act === 'reset-roster') { resetPrompt('roster'); toast('已恢复默认①建档提示词'); render(); return; }
    if (act === 'reset-organize') { resetPrompt('organize'); toast('已恢复默认②整理提示词'); render(); return; }
    if (act === 'reset-update') { resetPrompt('update'); toast('已恢复默认③更新提示词'); render(); return; }

    if (act === 'save-edit') {
        const ta = document.getElementById('we-edit-text');
        const state = getState();
        const next = replaceFromText(state, ta ? ta.value : '', getChatLength());
        Object.keys(state).forEach((k) => { delete state[k]; });
        Object.assign(state, next);
        commit(state);
        toast('世界状态已覆盖保存');
        currentTab = 'state';
        render();
        return;
    }

    if (act === 'add-event') {
        const inp = document.getElementById('we-ev-text');
        if (inp && inp.value.trim()) {
            const state = getState();
            addManualEvent(state, '记录', '', inp.value.trim());
            commit(state);
            render();
        }
        return;
    }

    /* ---- 大事记：单条删除 / 整页清空（v2.3.11） ---- */
    if (act === 'event-del') {
        const st = getState();
        const i = Number(t.dataset.idx);
        if (!Number.isInteger(i) || i < 0 || i >= (st.events || []).length) return;
        st.events.splice(i, 1);
        commit(st);
        render();
        return;
    }
    if (act === 'events-clear') {
        const st = getState();
        const n = (st.events || []).length;
        if (!n) { toast('大事记已经是空的'); return; }
        if (!confirm(`清空大事记？共 ${n} 条，不可恢复。`)) return;
        st.events = [];
        commit(st);
        toast('大事记已清空');
        render();
        return;
    }

    if (act === 'copy') {
        const state = getState();
        const log = (state.logs || [])[Number(el.dataset.idx)];
        if (!log) return;
        const text = el.dataset.kind === 'response' ? (log.response || log.error || '') : (log.prompt || '');
        copyText(text);
        return;
    }

    if (act === 'refresh-profiles') {
        const n = listTavernProfiles().length;
        toast(n ? `找到 ${n} 个酒馆连接` : '没找到连接管理器预设（酒馆可能较旧，或用的是直接选 API 的方式）');
        render();
        return;
    }

    if (act === 'fetch-models') {
        const miss = collectSettings();
        // 独立 API 这一区在「接口」页签，可能还没渲染过 → 从设置页点拉模型时，
        // 输入框读不到会把 url/key 清成空。这里拦住并提示，别静默毁配置。
        if (miss && miss.length && !s.api.url) { toast('先切到「接口」页签填好地址，再回来拉模型', 'error'); return; }
        if (!s.api.url) { toast('先在下面填写独立 API 地址', 'error'); return; }
        toast('正在拉取模型列表…');
        try {
            const models = await fetchModelList(s.api.url, s.api.key);
            if (!models.length) { toast('没识别到模型，请手动填模型名', 'error'); return; }
            s.api.modelOptions = models;
            if (!models.includes(s.api.model)) s.api.model = models[0];
            saveSettings();
            toast(`拉到 ${models.length} 个模型，已选：${s.api.model}（可点下拉换）`);
            render();
        } catch (e) {
            toast(`拉取失败：${e.message}`, 'error');
        }
        return;
    }

    if (act === 'diagnose') {
        collectSettings();
        lastDiag = '正在自检…';
        render();
        setBusy(true, '自检');
        try {
            const { runDiagnostics } = await import('../core/diag.js');
            lastDiag = (await runDiagnostics()) + '\n\n（以上结果可全选复制给我，方便定位）';
        } catch (e) {
            lastDiag = `自检过程异常：${e.message}`;
        } finally {
            setBusy(false);
            render();
        }
        return;
    }

    if (act === 'test-api') {
        collectSettings();
        if (!apiReady() && !s.allowFallback && s.api.mode !== 'tavern' && s.api.mode !== 'auto') { toast('请先填写 API 地址/模型，或把通道改成“跟随酒馆主连接”', 'error'); return; }
        toast('正在测试…');
        try {
            const r = await callLLM([{ role: 'user', content: '回复两个字：正常' }]);
            toast(`连接成功：${String(r).slice(0, 40)}`);
        } catch (err) {
            toast(`连接失败：${err.message}`, 'error');
        }
        return;
    }

    if (act === 'probe-wb') {
        collectSettings();
        try {
            const r = await probeWorldBook();
            if (!r.total) {
                toast('没读到世界书条目：角色卡可能没绑世界书，可在上面手填世界书名');
            } else {
                toast(`世界书「${r.name || '未命名'}」：${r.total} 条，允许带入 ${r.usable} 条 / ${r.chars} 字${r.overview.length ? '；速览条目：' + r.overview.slice(0, 3).join('、') : '；没识别到「人物速览」条目'}`);
                console.log('[WorldEngine] 世界书识别结果', r);
            }
        } catch (err) { toast(`读取失败：${err.message}`, 'error'); }
        return;
    }

    if (act === 'build') {
        currentTab = 'build';
        // 运行期再点「一键建立」= 重跑第 1 步认人 + 全部第 2 步整理，要烧很多轮调用；
        // 日常想推的是「立即更新」，这里弹确认防止误触（v2.3.10）
        if (getState().phase === 'running'
            && !confirm('世界已经在运行。「一键建立」会重新跑第 1 步认人 + 全部第 2 步整理（要花很多轮调用、覆盖现有整理结果）。\n\n只是想让世界动一轮，请改用「立即更新」。\n\n确定要重新建立吗？')) return;
        await doBuild(false);
        return;
    }
    if (act === 'rebuild') {
        if (confirm('重建世界会清空当前世界状态与快照，重新读取世界书+剧情生成。确定？')) await doBuild(true);
        return;
    }
    if (act === 'update') { await doUpdate(true); return; }

    if (act === 'write') { doWriteToChat(); return; }
    if (act === 'clear-write') {
        if (removeDynamicsFromLatestFloor()) toast('已清除'); else toast('该楼层没有世界动态');
        return;
    }

    if (act === 'merge-dups') {
        const state = getState();
        const groups = sameNameGroups(state);
        if (!groups.length) { toast('没有重复挂载'); return; }
        const preview = groups.map(([k, l]) => `${k}（${l.length}处）`).join('、');
        if (!confirm(`把同名的人合并成一处？\n\n${preview}\n\n规则：保留顶层 / 有子分支 / 关系更亲密的那一处，其余副本并掉（子分支会自动搬过去）。`)) return;
        try {
            const r = mergeDuplicateMounts(state);
            commit(state);
            toast(r.removed ? `合并完成，并掉 ${r.removed} 处重复挂载` : '没有需要合并的');
            render();
        } catch (err) {
            toast(`合并失败：${err.message}`, 'error');
        }
        return;
    }

    if (act === 'merge-suspected') {
        const state = getState();
        const groups = suspectedGroups(state);
        if (!groups.length) { toast('没有疑似重复的名字'); return; }
        const preview = groups.map(([, l]) => l.map((n) => n.name).join('  /  ')).join('\n');
        if (!confirm(`这些名字疑似同一个人（关系词表没覆盖到的前缀），要合并吗？\n\n${preview}\n\n规则同「合并成一处」：保留顶层 / 有子分支的那一处，其余并掉（子分支自动搬过去）。\n判错了可以对那个角色点「编辑」手动改回来。`)) return;
        try {
            const r = mergeSuspected(state);
            commit(state);
            toast(r.removed ? `已合并 ${r.removed} 处疑似重复` : '没有需要合并的');
            render();
        } catch (err) {
            toast(`合并失败：${err.message}`, 'error');
        }
        return;
    }

    if (act === 'export-prompt') {
        const state = getState();
        const log = (state.logs || []).find((l) => l.promptFull);
        if (!log) { toast('没有可导出的完整提示词：先跑一次演化再来', 'error'); return; }
        const body = `时间：${log.at || ''}    类型：${log.type || ''}\n`
            + `提示词长度：${log.promptFull.length} 字（日志页显示的是截断到 14000 字后的版本）\n`
            + `${'='.repeat(60)}\n【完整提示词】\n${log.promptFull}\n`
            + `${'='.repeat(60)}\n【模型原始输出】\n${log.responseFull || log.response || ''}\n`;
        if (downloadText(`worldengine-prompt-${Date.now()}.txt`, body)) toast('已导出完整提示词');
        else toast('导出失败：浏览器不允许下载', 'error');
        return;
    }

    // 导出全部日志（v2.3.10）：日志页显示的版本被截断到 14000 字，
    // 导出成 txt 方便存档/看全（最新一条含不截断的完整版）
    if (act === 'logs-export') {
        const st = getState();
        const wl = st.worklogs || [];
        const ls = st.logs || [];
        if (!wl.length && !ls.length) { toast('没有日志可导出'); return; }
        const body = `WorldEngine 日志导出　${new Date().toLocaleString('zh-CN')}\n`
            + `工作小结 ${wl.length} 条 ｜ 调用记录 ${ls.length} 条\n\n`
            + `${'='.repeat(60)}\n【工作小结】\n`
            + (wl.map((w) => `#${w.n} [${kindLabel(w.kind)}] ${w.at}\n${w.summary}${w.note ? `\n${w.note}` : ''}`).join('\n\n') || '（无）')
            + `\n\n${'='.repeat(60)}\n【调用记录】\n`
            + (ls.map((l) => `\n---- ${logTypeLabel(l.type)}　${l.at || ''}${l.ms ? `　${l.ms}ms` : ''}${l.ok === false ? '　失败' : ''} ----\n`
                + `【提示词】\n${l.promptFull || l.prompt || '（空）'}\n【模型原始输出】\n${l.responseFull || l.response || l.error || '（空）'}\n`).join('') || '（无）');
        if (downloadText(`worldengine-logs-${Date.now()}.txt`, body)) toast('已导出全部日志');
        else toast('导出失败：浏览器不允许下载', 'error');
        return;
    }

    // 日志页单条删除（v2.3.11）：工作小结 / 调用记录各自一条一条删
    if (act === 'worklog-del') {
        const st = getState();
        const i = Number(t.dataset.idx);
        if (!Number.isInteger(i) || i < 0 || i >= (st.worklogs || []).length) return;
        st.worklogs.splice(i, 1);
        commit(st);
        render();
        return;
    }
    if (act === 'log-del') {
        const st = getState();
        const i = Number(t.dataset.idx);
        if (!Number.isInteger(i) || i < 0 || i >= (st.logs || []).length) return;
        st.logs.splice(i, 1);
        commit(st);
        render();
        return;
    }

    // 清空日志与小结（v2.3.10）：用户抱怨"存了一堆没用的日志删不掉"。
    // 工作小结清掉后不会再回流进提示词，确认框里说清楚。
    if (act === 'logs-clear') {
        const st = getState();
        const n = (st.logs || []).length;
        const m = (st.worklogs || []).length;
        if (!n && !m) { toast('日志已经是空的'); return; }
        if (!confirm(`清空日志页的全部内容？\n\n完整调用记录 ${n} 条 + 工作小结 ${m} 条。\n工作小结清掉后，下一轮更新不会再把它们带进提示词。\n\n确定清空？`)) return;
        st.logs = [];
        st.worklogs = [];
        commit(st);
        toast('日志已清空');
        render();
        return;
    }

    // 一键清空待审（v2.3.19）：给一条不依赖逐个点击的出路
    if (act === 'pending-clear') {
        const stx = getState();
        const n = (stx.pending || []).length;
        if (!n) { toast('没有待审角色'); return; }
        if (!confirm(`忽略全部 ${n} 个待审新角色？\n\n他们不会被建档，世界保持原样。只是清掉这份提名名单。`)) return;
        stx.pending = [];
        commit(stx);
        toast(`已忽略全部 ${n} 个待审角色`);
        render();
        return;
    }

    if (act === 'pending-approve' || act === 'pending-dismiss') {
        const name = t.dataset.name || '';
        // v2.3.19：以前这里写的是 `if (!name) return;` —— 名字取不到就**静默什么都不做**，
        // 用户看到的就是"按了没反应"，没有任何线索。现在明确告诉你出了什么事。
        if (!name) { toast('没取到这个提案的名字，无法处理。去「编辑」页看一下待审名单', 'error'); return; }
        const state = getState();
        if (act === 'pending-approve') {
            const node = approvePending(state, name);
            if (node) {
                commit(state);
                toast(`已建档：${node.name}（去世界书写她的条目，再回第 2 步勾选她 + 勾「只补性格」跑一次）`);
            } else {
                toast(`没找到提案：${name}`, 'error');
            }
        } else {
            dismissPending(state, name);
            commit(state);
            toast(`已忽略：${name}`);
        }
        render();
        return;
    }

    if (act === 'reset-ball') {
        resetBallPosition();
        render();
        return;
    }
    if (act === 'ball-diag') {
        const box = panelEl && panelEl.querySelector('#we-ball-diag');
        const info = ballDebugInfo();
        if (box) {
            box.style.display = 'block';
            box.textContent = info;
        }
        console.log('[WorldEngine] 悬浮球诊断\n' + info);
        toast('诊断结果已显示在下面');
        return;
    }
    if (act === 'export') {
        const state = getState();
        copyText(JSON.stringify(state, null, 2));
        return;
    }
}

/* ---------------- 动作 ---------------- */

export async function doBuild(rebuild) {
    if (busy) return;
    currentTab = 'build';
    render();
    setBusy(true, '建档');
    const prog = (t) => { buildStatus = t; render(); };
    try {
        const state = await initializeWorld({ rebuild, onProgress: prog });
        toast(`建立完成：${Object.keys(state.nodes).length} 个角色（可以点「立即更新」载入剧情了）`);
        buildStatus = '';
        render();
        maybeWriteToChat();
    } catch (err) {
        console.error(err);
        buildStatus = '';
        toast(`建档失败：${err.message}`, 'error');
    } finally {
        setBusy(false);
        render();
    }
}

/** 跑一个建档阶段 */
async function runStage(kind, fn, label = '处理中') {
    setBusy(true, '建档');
    buildStatus = label;
    render();
    try {
        const r = await fn((t) => { buildStatus = t; render(); });
        const state = r && r.state ? r.state : getState();
        if (kind === 'roster') {
            toast(`第 1 步完成：识别出 ${topNodes(state).length} 个角色（全部未出场，已定性格）`);
        } else if (kind === 'organize') {
            const blocked = (r && r.pending) || [];
            toast(`本批整理完成：累计 ${(state.built || []).length}/${topNodes(state).length}（草稿已存，可继续下一批）`
                + (blocked.length ? ` ｜ 拦下 ${blocked.length} 个名单外的新角色，去「世界状态」页裁决` : ''));
        } else {
            toast(`初始化完成，世界开始运行（${Object.keys(state.nodes || {}).length} 个角色）`);
        }
    } catch (e) {
        console.error(e);
        const stepName = kind === 'roster' ? '第1步（认人+性格）' : kind === 'organize' ? '第2步（批量整理）' : '汇总定稿';
        toast(`${stepName}失败：${e.message}`, 'error');
        const st = getState();
        pushLog(st, { type: `stage-${kind}`, prompt: '', response: '', ok: false, error: e.message });
        commit(st);
    } finally {
        buildStatus = '';
        setBusy(false);
        render();
    }
}

export async function doUpdate(manual) {
    if (busy) return;
    setBusy(true, '推演');
    showTopStatus(manual ? '世界推演中（手动）…' : '世界推演中…');
    try {
        const r = await updateWorld({ manual });
        const c = (r.res.added.length + r.res.updated.length + r.res.archived.length);
        const pendingTip = (r.res.pending || []).length ? ` ｜ 待审新角色 ${r.res.pending.length} 个` : '';
        toast(`世界演化完成：变动 ${c} 处${pendingTip}${r.summary ? ` ｜ ${r.summary}` : ''}`);
        flashBall('ok');
        showTopStatus(`世界演化完成：变动 ${c} 处${pendingTip}`);
        render();
        maybeWriteToChat([...(r.res.added || []), ...(r.res.updated || []), ...(r.res.migrated || [])]);
    } catch (err) {
        console.error(err);
        toast(`演化失败：${err.message}`, 'error');
        flashBall('err');
        showTopStatus(`世界演化失败：${err.message}`, true);
    } finally {
        setBusy(false);
    }
}

/** @param {string[]} [changed] 本轮有变化的角色名，写入正文时优先挑这些人 */
function maybeWriteToChat(changed) {
    const s = getSettings();
    if (!s.enabled || !s.writeToChat.enabled) return;
    const state = getState();
    const line = buildWorldDynamicsLine(state, s.writeToChat.categories, {
        topN: Number(s.writeToChat.topN) || 3,
        changed: changed || [],
    });
    if (!line) return;
    if (s.writeToChat.auto) {
        const r = writeDynamicsToLatestFloor(line);
        toast(r.ok ? `已写入正文：${r.msg}` : `写入失败：${r.msg}`, r.ok ? 'info' : 'error');
        return;
    }
    showConfirmBar('把最关键的几个角色动态写入最新楼层正文吗？', () => {
        const r = writeDynamicsToLatestFloor(line);
        toast(r.ok ? `已写入正文：${r.msg}` : `写入失败：${r.msg}`, r.ok ? 'info' : 'error');
    });
}

function doWriteToChat() {
    const s = getSettings();
    const state = getState();
    const line = buildWorldDynamicsLine(state, s.writeToChat.categories, {
        topN: Number(s.writeToChat.topN) || 3,
    });
    if (!line) { toast('没有可写入的内容（检查类别勾选）'); return; }
    const r = writeDynamicsToLatestFloor(line);
    toast(r.ok ? `已写入正文：${r.msg}` : `写入失败：${r.msg}`, r.ok ? 'info' : 'error');
}

/* ---------------- 底部确认条 ---------------- */

export function showConfirmBar(text, onOk) {
    const old = document.getElementById('we-confirm');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const bar = document.createElement('div');
    bar.id = 'we-confirm';
    bar.innerHTML = `<span>${escapeHtml(text)}</span><button class="we-ok">确认写入</button><button>取消</button>`;
    document.body.appendChild(bar);
    applyTheme(bar);
    const close = () => { if (bar.parentNode) bar.parentNode.removeChild(bar); };
    bar.querySelector('.we-ok').addEventListener('click', () => { close(); try { onOk && onOk(); } catch (e) { console.error(e); } });
    bar.querySelectorAll('button:not(.we-ok)').forEach((b) => b.addEventListener('click', close));
    setTimeout(close, 30000);
}

function copyText(text) {
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败', 'error'); }
        document.body.removeChild(ta);
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => toast('已复制到剪贴板'))
                .catch(() => fallback());
            return;
        }
    } catch (e) { /* ignore */ }
    fallback();
}
