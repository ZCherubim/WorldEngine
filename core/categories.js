/**
 * 分类治理：数量上限降级、冷却阈值、初始化兜底
 *
 * v2.3.18：攻防档已删除，只剩 交互 / 冷却 / 未出场 三档。
 * 档位现在只回答一个问题 ——「这个人现在和剧情有没有关系」：
 *   交互 = 出现过（在场，或状态线正撞主线）
 *   冷却 = 出现过，但很久没交集了
 *   未出场 = 世界书里有，剧情还没激活
 * 「这段关系激不激烈」不再进分类学，写进状态行文本。
 */
import { pushEvent } from './state.js';

const RANK = { interaction: 0, cooldown: 1, unseen: 2 };

function tops(state) {
    return Object.values(state.nodes).filter((n) => !n.parent && !n.archived);
}

/** 交互超上限自动降级（上限为 0 = 不限） */
export function enforceCaps(state, settings) {
    const t = settings.tracking || {};
    const interactionLimit = Number(t.interactionLimit || 0);
    if (interactionLimit > 0) {
        const inter = Object.values(state.nodes).filter((n) => n.category === 'interaction' && !n.archived)
            .sort((a, b) => (b.floor || 0) - (a.floor || 0) || (a.seq || 0) - (b.seq || 0));
        for (let i = interactionLimit; i < inter.length; i++) {
            if (state.hidden.includes(inter[i].name)) continue;
            inter[i].category = 'cooldown';
        }
    }
}

/** 距上次变动超过 N 层的交互角色转冷却 */
export function applyCooldown(state, settings, floor) {
    const threshold = Number((settings.tracking || {}).cooldownThreshold || 0);
    if (threshold <= 0) return;
    Object.values(state.nodes).forEach((n) => {
        if (n.archived) return;
        if (n.category !== 'interaction') return;
        if (state.hidden.includes(n.name)) return;
        if (floor - (n.floor || 0) > threshold) {
            n.category = 'cooldown';
            pushEvent(state, { type: '冷却', name: n.name, text: `${n.name}：超过 ${threshold} 层未参与剧情，转入冷却` });
        }
    });
}

/** 初始化兜底：全被标成冷却/未出场时，正文里出现过的→交互
 *  默认关闭（用户要求"没人就是 0，都待在未出场"，只有开了 tracking.autoFallback 才兜底）
 */
export function fallbackInit(state, recentChatText, settings) {
    const enabled = settings && settings.tracking ? !!settings.tracking.autoFallback : false;
    if (!enabled) return;
    const list = tops(state);
    if (!list.length) return;
    const allIdle = list.every((n) => n.category === 'cooldown' || n.category === 'unseen');
    if (!allIdle) return;
    list.forEach((n) => {
        const inScene = recentChatText && n.name && recentChatText.includes(n.name);
        if (inScene) n.category = 'interaction';
        else n.category = 'unseen';
    });
    pushEvent(state, { type: '兜底', name: '系统', text: '初始化分类异常，已按"在正文里出现过→交互"自动兜底' });
}

/** 子分支排序：情感类永远排最前（渲染时按 seq 排序已处理，这里保证数据一致） */
export function normalizeOrder(state) {
    const ids = Object.values(state.nodes).filter((n) => !n.parent).map((n) => n.id);
    state.order = ids;
    return state;
}

export function categoryRank(c) { return RANK[c] === undefined ? 9 : RANK[c]; }
