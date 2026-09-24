import { getSettings, saveSettings } from '../config.js';
import { DEFAULT_ROSTER_PROMPT } from '../prompts/rosterPrompt.js';
import { DEFAULT_ORGANIZE_PROMPT } from '../prompts/organizePrompt.js';
import { DEFAULT_UPDATE_PROMPT } from '../prompts/updatePrompt.js';

/** 三套提示词的默认值 */
export const DEFAULT_PROMPTS = {
    roster: DEFAULT_ROSTER_PROMPT,
    organize: DEFAULT_ORGANIZE_PROMPT,
    update: DEFAULT_UPDATE_PROMPT,
};

export function defaultPrompt(kind) {
    return DEFAULT_PROMPTS[kind] || DEFAULT_UPDATE_PROMPT;
}

export function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (m, key) => (
        vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
    ));
}

/**
 * 取当前生效的提示词
 * kind: 'roster'（第1步 认人+性格） / 'organize'（第2步 分批整理） / 'update'（第3步 载入剧情）
 */
export function getPrompt(kind) {
    const s = getSettings();
    const p = s.prompts || {};
    const pick = (v) => (v && String(v).trim() ? String(v) : '');
    if (kind === 'roster') return pick(p.roster) || pick(p.init) || DEFAULT_ROSTER_PROMPT; // p.init 是旧版字段，兼容
    if (kind === 'organize') return pick(p.organize) || DEFAULT_ORGANIZE_PROMPT;
    if (kind === 'update') return pick(p.update) || DEFAULT_UPDATE_PROMPT;
    return '';
}

/** 是不是用户自定义过的（用于界面提示） */
export function isCustomPrompt(kind) {
    const s = getSettings();
    const p = s.prompts || {};
    if (kind === 'roster') return !!(p.roster || p.init);
    return !!p[kind];
}

export function resetPrompt(kind) {
    const s = getSettings();
    s.prompts = s.prompts || {};
    if (kind === 'roster') {
        s.prompts.roster = '';
        s.prompts.init = ''; // 一并清掉旧字段
    } else {
        s.prompts[kind] = '';
    }
    saveSettings();
}

/**
 * 推理/思考块：整体丢弃（连同内容）—— 那是思考过程，不是世界状态。
 */
const REASON_BLOCK_RE = /<(?:thinking|think|reasoning|thought|analysis|分析|思考|思维链|cot)\b[^>]*>[\s\S]*?<\/(?:thinking|think|reasoning|thought|analysis|分析|思考|思维链|cot)>/gi;

/** 包裹类标签：只剥壳，内容保留（预设常要求"用 <content> 包住正文"） */
const WRAP_TAG_RE = /<\/?(?:content|response|output|result|answer|reply|text|正文|输出|回答|结果|世界动态)\b[^>]*>/gi;

/** 纯分隔线（整行只有分隔符才删，别误伤 "## 小结"） */
const DIVIDER_RE = /^\s*(?:[-=*_#]{3,}|【(?:正文|输出|回答)(?:开始|结束)】)\s*$/gm;

/**
 * 清理模型输出：去掉代码块围栏、推理块、包装标签、分隔线、开头客套话。
 *
 * 为什么要剥标签（v2.3.7）：预设常要求「用 <content> 包住正文」「先 <thinking> 再输出」。
 * 演化请求一旦带上这些预设，标签和正文就会混进协议文本 ——
 * 而正文里以 - / + 开头的行会被 parseLines 当成归档/新增操作，凭空改动世界树。
 * 所以这里先剥一层，parseLines 那边还有第二道门槛（见 parseLines 的 dropped）。
 */
export function cleanOutput(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    t = t.replace(/^\s*(好的|明白|以下是|下面是|Okay|Sure)[^\n]*\n/i, '');
    t = t.replace(REASON_BLOCK_RE, '');
    t = t.replace(WRAP_TAG_RE, '');
    t = t.replace(DIVIDER_RE, '');
    return t.trim();
}
