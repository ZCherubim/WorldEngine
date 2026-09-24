/**
 * 自检：一条命令检查环境、存档、事件、世界书、模型通道，方便定位报错
 */
import { getContext, getChatMetadata, persistChat, getRequestHeaders, getGenerationApi } from './st.js';
import { getState } from './state.js';
import { callLLM, currentChannel, apiReady, tavernApiInfo, listTavernProfiles, activeProfileId, hasConnectionManagerService, hasChatCompletionService } from '../api/llm.js';
import { getSettings } from '../config.js';
import { loadWorldBook, selectedEntries, selectionMade, getWorldBookName, overviewEntries, clearWorldBookCache } from './worldbook.js';

export async function runDiagnostics() {
    const lines = [];
    const put = (label, cond, extra = '') => {
        lines.push(`${cond ? '[正常]' : '[异常]'} ${label}${extra ? ' — ' + extra : ''}`);
    };

    const c = getContext();
    put('获取到酒馆上下文', !!c);
    if (!c) {
        lines.push('插件没拿到 SillyTavern.getContext()，通常是插件没被正常加载，检查文件夹是否放在 third-party 下并强刷过页面。');
        return lines.join('\n');
    }

    put('聊天数组可读', Array.isArray(c.chat), `当前 ${(c.chat || []).length} 层`);
    put('聊天元数据可读', !!getChatMetadata(), getChatMetadata() ? '' : '拿不到 chatMetadata，世界状态无法保存');

    try {
        const meta = getChatMetadata();
        if (meta) meta.__we_probe = Date.now();
        await persistChat();
        put('存档接口可用', true);
    } catch (e) {
        put('存档接口可用', false, e.message);
    }

    const gen = getGenerationApi();
    const profiles = listTavernProfiles();
    const pid = activeProfileId();
    const active = profiles.find((p) => p.id === pid);
    put('酒馆连接管理器预设', profiles.length > 0,
        profiles.length ? `${profiles.length} 个${active ? `，当前用：${active.name}${active.model ? ' · ' + active.model : ''}` : (pid ? `（选中的 ${pid} 未找到）` : '，未选中任何连接')}` : '没找到（酒馆可能较旧，将用其他接口）');
    put('连接管理器接口 ConnectionManagerRequestService', hasConnectionManagerService(),
        hasConnectionManagerService() ? '（首选通道）' : '没有 → 会退回 generateRaw / 服务端接口');
    put('内置生成接口 ChatCompletionService', hasChatCompletionService());
    put('生成接口 generateRaw（备用）', !!gen.generateRaw);

    put('事件源可用', !!c.eventSource && !!c.event_types);
    const et = c.event_types || {};
    put('注入事件 CHAT_COMPLETION_PROMPT_READY', !!et.CHAT_COMPLETION_PROMPT_READY,
        et.CHAT_COMPLETION_PROMPT_READY ? '' : '没有这个事件名，上下文注入可能失效');
    put('新消息事件 MESSAGE_RECEIVED / GENERATION_ENDED', !!(et.MESSAGE_RECEIVED || et.GENERATION_ENDED),
        et.MESSAGE_RECEIVED || et.GENERATION_ENDED ? '' : '没有可用事件，自动演化不会触发，只能手动点更新');
    put('请求头接口', typeof getRequestHeaders === 'function');

    const state = getState();
    put('当前聊天的世界状态', true, `${Object.keys(state.nodes || {}).length} 个角色`);
    const allNodes = Object.values(state.nodes || {});
    put('主基调性格', true, `${allNodes.filter((n) => n.persona && Object.keys(n.persona).length).length}/${allNodes.length} 个角色已有性格（性格是锁死的，更新改不动）`);
    put('整理草稿', true, `${(state.drafts || []).length} 份（第 2 步分批整理留下的，汇总定稿后会自动清空）`);
    put('工作小结', true, `${(state.worklogs || []).length} 条（每轮"我干了什么"，会回流进提示词）`);
    put('外部剧情记忆', !!state.memoryText, state.memoryText ? `${state.memoryText.length} 字${state.memoryAt ? `（${state.memoryAt}）` : ''}` : '未导入');

    const s = getSettings();
    try {
        clearWorldBookCache();
        const entries = await loadWorldBook(true, s.worldbook.name);
        const usable = selectedEntries(entries);
        const ov = overviewEntries(usable);
        put('世界书读取', entries.length > 0,
            entries.length
                ? `「${getWorldBookName() || '未命名'}」共 ${entries.length} 条，允许带入 ${usable.length} 条 / ${usable.reduce((a, e) => a + e.length, 0)} 字`
                : '没读到条目（角色卡可能没绑世界书，可在设置里手填世界书名）');
        if (entries.length) {
            const picked = Array.isArray(s.worldbook.selectedUids) ? s.worldbook.selectedUids : [];
            put('条目挑选', true, selectionMade()
                ? (picked.length ? `已挑 ${picked.length} 条` : '一条都不带入（建档/更新不带世界书）')
                : '还没挑过 → 全部可用');
            put('识别到「人物速览」条目', ov.length > 0, ov.length ? ov.map((e) => e.title).slice(0, 5).join('、') : '没有，已退化为"所有条目标题清单"来识别角色');
            const nsfw = entries.filter((e) => e.isNsfw).length;
            put('条目分类', true, `速览 ${ov.length} ｜ NSFW ${nsfw} ｜ 角色 ${entries.filter((e) => e.kind === 'character').length} ｜ 其他 ${entries.filter((e) => e.kind === 'other').length}`);
        }
    } catch (e) {
        put('世界书读取', false, e.message);
    }

    lines.push(`———— 通道 ——\n模式：${s.api.mode}　${currentChannel()}`);
    lines.push(`可用生成接口：${tavernApiInfo()}`);
    lines.push(`独立 API 已配置：${apiReady() ? '是' : '否（将跟随酒馆主连接）'}`);

    lines.push('———— 实际调用测试 ——');
    const t0 = Date.now();
    try {
        const r = await callLLM([{ role: 'user', content: '请只回复两个字：正常' }], { timeoutMs: 90000 });
        put('模型调用', true, `${Date.now() - t0}ms，返回：${String(r).slice(0, 60)}`);
    } catch (e) {
        put('模型调用', false, e.message);
        lines.push('提示：① 先确认酒馆自己点「生成」能正常出内容；');
        lines.push('　　　② 跟随主连接时用的是官方 generateRaw 接口，与你在酒馆「API 连接」里选的连接一致；');
        lines.push('　　　③ 若仍不行，可在插件里改填独立 API（地址 / 密钥 / 模型）；');
        lines.push('　　　④ 地址填 http://127.0.0.1:端口/v1（插件会自动补 /chat/completions）。');
    }

    return lines.join('\n');
}
