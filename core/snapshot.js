/**
 * 快照与删楼回退
 * 每次更新存一份全量快照（含楼层号）；删楼时回退到该楼层之前最近的快照
 */
import { serialize, emptyState, parseLines, applyOps } from './protocol.js';

export function pushSnapshot(state, floor, limit = 10) {
    state.snapshots = state.snapshots || [];
    state.snapshots.push({
        floor,
        at: new Date().toLocaleString('zh-CN'),
        text: serialize(state),
        eventsLen: (state.events || []).length,
    });
    const max = Number(limit) > 0 ? Number(limit) : 10;
    while (state.snapshots.length > max) state.snapshots.shift();
}

export function snapshotText(state) {
    return serialize(state);
}

/** 恢复某份快照文本（保留日志与设置类字段） */
export function restoreFromText(state, text, opts = {}) {
    const keepLogs = state.logs || [];
    const keepHidden = state.hidden || [];
    const next = emptyState();
    next.seq = state.seq || 0;
    next.hidden = keepHidden;
    next.logs = keepLogs;
    next.archived = state.archived || [];
    const parsed = parseLines(text);
    next.worldTime = parsed.worldTime || '';
    if (parsed.hide.length) next.hidden = parsed.hide;
    applyOps(next, parsed.ops, '~', 0);
    if (opts.snapshots) next.snapshots = opts.snapshots;
    if (opts.events) next.events = opts.events;
    if (opts.timeline) next.timeline = opts.timeline;
    return next;
}

/**
 * 删楼回退：保留 floor <= 当前楼层 的最后一份快照
 * @returns {{restored:boolean, floor:number, msg:string}}
 */
export function rollbackToFloor(state, floor) {
    const snaps = state.snapshots || [];
    if (!snaps.length) return { restored: false, floor, msg: '没有可用快照' };
    const valid = snaps.filter((s) => s.floor <= floor);
    if (!valid.length) {
        // 全部快照都比当前楼层新 → 用最早的一份
        const first = snaps[0];
        const next = restoreFromText(state, first.text, { snapshots: [first] });
        Object.assign(state, next);
        return { restored: true, floor, msg: `已回退到第 ${first.floor} 层的世界状态` };
    }
    const target = valid[valid.length - 1];
    const kept = snaps.filter((s) => s.floor <= floor);
    const keptEvents = (state.events || []).slice(0, target.eventsLen || 0);
    const next = restoreFromText(state, target.text, { snapshots: kept, events: keptEvents });
    Object.assign(state, next);
    return { restored: true, floor, msg: `已回退到第 ${target.floor} 层的世界状态（并清理之后的快照与大事记）` };
}
