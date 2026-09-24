/**
 * 世界时间线：时间跳跃记录（最近10条）+ 时段氛围
 */

export function extractHour(text) {
    if (!text) return null;
    const m1 = String(text).match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (m1) return Number(m1[1]);
    const m2 = String(text).match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|夜里)\s*(\d{1,2})\s*点/);
    if (m2) {
        const map = { 凌晨: 0, 早上: 0, 上午: 0, 中午: 12, 下午: 12, 傍晚: 12, 晚上: 12, 夜里: 12, 深夜: 12 };
        let h = Number(m2[2]) + (map[m2[1]] || 0);
        if (m2[1] === '下午' || m2[1] === '傍晚' || m2[1] === '晚上' || m2[1] === '深夜' || m2[1] === '夜里') {
            if (Number(m2[2]) < 12) h += 12;
        }
        return h % 24;
    }
    return null;
}

export function timeOfDay(hour) {
    if (hour == null) return { key: 'night', label: '夜晚' };
    const h = hour;
    if (h >= 0 && h < 5) return { key: 'midnight', label: '深夜' };
    if (h < 8) return { key: 'dawn', label: '清晨' };
    if (h < 11) return { key: 'morning', label: '上午' };
    if (h < 13) return { key: 'noon', label: '正午' };
    if (h < 17) return { key: 'afternoon', label: '午后' };
    if (h < 19) return { key: 'dusk', label: '黄昏' };
    if (h < 23) return { key: 'night', label: '夜晚' };
    return { key: 'midnight', label: '深夜' };
}

/** 记录一次时间跳跃 */
export function recordJump(state, from, to) {
    if (!from || !to || from === to) return;
    state.timeline = state.timeline || [];
    state.timeline.push({ from, to, at: new Date().toLocaleString('zh-CN') });
    if (state.timeline.length > 10) state.timeline.shift();
}

/** 生成给模型看的时间推进说明 */
export function describeJump(from, to) {
    if (!from) return `当前剧情时间已推进到：${to}。请据此推演世界。`;
    const fh = extractHour(from);
    const th = extractHour(to);
    let gap = '';
    if (fh != null && th != null) {
        let d = th - fh;
        if (d < 0) d += 24;
        gap = `（约 ${d} 小时）`;
    }
    return `世界时间：${from} → ${to} ${gap}。中间这段时间各角色照常生活，请一并推演。`;
}
