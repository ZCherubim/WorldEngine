/**
 * 大事记：登场 / 激活 / 迁移 / 进入剧情 / 转冷却 / 归档
 * 只记录，不注入正文
 */
import { parseLines, applyOps, emptyState } from './protocol.js';
import { pushEvent } from './state.js';

function indexByName(state) {
    const map = new Map();
    Object.values(state.nodes || {}).forEach((n) => {
        if (!map.has(n.name)) map.set(n.name, n);
    });
    return map;
}

function stateFromText(text) {
    const tmp = emptyState();
    const parsed = parseLines(text || '');
    applyOps(tmp, parsed.ops, '~', 0);
    tmp.archivedNames = parsed.ops.filter((o) => o.op === '-').map((o) => o.path[o.path.length - 1]);
    tmp.hidden = parsed.hide || [];
    return tmp;
}

/**
 * 对比更新前后的世界状态，写大事记
 * @param {object} state 当前（已更新后的）世界状态
 * @param {string} beforeText 更新前的序列化文本
 */
export function diffAndRecord(state, beforeText, reason = '') {
    const before = stateFromText(beforeText || '');
    const beforeMap = indexByName(before);
    const afterMap = indexByName(state);
    const archivedSet = new Set(before.archivedNames || []);
    const stateArchived = new Set(state.archived || []);

    for (const [name, node] of afterMap.entries()) {
        if (state.hidden.includes(name)) continue;
        const prev = beforeMap.get(name);
        if (!prev) {
            if (archivedSet.has(name) || stateArchived.has(name)) {
                pushEvent(state, { type: '激活', name, text: `${name}：归档后重新出现，回到剧情中` });
            } else {
                pushEvent(state, { type: '登场', name, text: `${name}：新角色出现${reason ? '（' + reason + '）' : ''}` });
            }
            continue;
        }
        if (prev.parent !== node.parent) {
            const pn = prev.parent ? prev.parent.split('>').pop() : '顶层';
            const nn = node.parent ? node.parent.split('>').pop() : '顶层';
            pushEvent(state, { type: '迁移', name, text: `${name}：挂载点 ${pn} → ${nn}` });
        }
        // v2.3.18：攻防档已删除。档位变化只记"进/出剧情视野"，不再记"攻略/降温"——
        // 那是感情烈度，属于状态行文本，不属于分类学。
        if (prev.category !== 'interaction' && node.category === 'interaction') {
            pushEvent(state, { type: '进入剧情', name, text: `${name}：进入交互档${reason ? '（' + reason + '）' : ''}` });
        }
        if (prev.category === 'interaction' && node.category !== 'interaction') {
            pushEvent(state, { type: '转冷却', name, text: `${name}：退出交互档，转为${node.category === 'cooldown' ? '冷却' : '未出场'}` });
        }
    }

    for (const name of state.archived || []) {
        if (!afterMap.has(name)) {
            pushEvent(state, { type: '归档', name, text: `${name}：短期退场，数据保留` });
        }
    }
}

export function addManualEvent(state, type, name, text) {
    pushEvent(state, { type: type || '记录', name: name || '', text: text || '' });
}
