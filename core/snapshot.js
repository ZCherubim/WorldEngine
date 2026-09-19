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

/**
 * 恢复某份快照文本。
 * 保留策略：日志 / 工作小结 / 记忆 / 草稿 / 待审 / 时间线 / 归档名单 / 隐藏名单
 * 这些"操作层"字段全部沿用当前状态（回退的只是世界树本身，不是操作历史）；
 * 节点 / 世界时间 / 隐藏名单 由快照协议文本恢复。
 */
export function restoreFromText(state, text, opts = {}) {
    const next = emptyState();
    // 从当前状态原样保留的字段（回退不清除操作历史、不丢记忆）
    next.seq = state.seq || 0;
    next.logs = state.logs || [];
    next.worklogs = state.worklogs || [];
    next.drafts = state.drafts || [];
    next.pending = state.pending || [];
    next.built = state.built || [];
    next.lastCovered = state.lastCovered || [];
    next.archived = state.archived || [];
    next.hidden = state.hidden || [];
    next.memoryText = state.memoryText || '';
    next.memoryRaw = state.memoryRaw || '';
    next.memoryAt = state.memoryAt || '';
    next.events = state.events || [];
    next.timeline = state.timeline || [];
    next.phase = state.phase || 'empty';
    next.worldMinutes = state.worldMinutes;
    next.version = state.version || 2;
    next.updatedAt = state.updatedAt || '';
    // 快照文本恢复的字段
    const parsed = parseLines(text);
    next.worldTime = parsed.worldTime || '';
    if (parsed.hide && parsed.hide.length) next.hidden = parsed.hide;
    applyOps(next, parsed.ops, '~', 0);
    // opts 里传入的覆盖项（由 rollbackToFloor 决定留多少快照/事件/时间线）
    if (opts.snapshots) next.snapshots = opts.snapshots;
    if (opts.events !== undefined) next.events = opts.events;
    if (opts.timeline !== undefined) next.timeline = opts.timeline;
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
