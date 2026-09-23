// ============================================================================
// tosu 客户端 —— 通过 tosu 的本地 HTTP API 读取 osu!stable 的实时状态
//
// 【重要认知】tosu 不是"注入"工具：
//   · 它是独立进程，用 OpenProcess + ReadProcessMemory 只读 osu!.exe 的内存
//   · 它不做 DLL 注入、不写内存、不修改游戏（tsprocess 只导出 read*/scan*，没有 write）
//   · 它扫的是 AOB 特征码，而这些特征码是 .NET JIT **运行时**编译出来的原生码，
//     所以只能扫活进程内存（磁盘上的 osu!.exe 是 IL，扫不到——已实测 0 命中）
//
// 我们用 tosu 当数据源，而不是自己重写一遍特征码扫描：
//   ① 零逆向成本、不随 osu! 更新失效（tosu 社区在维护签名）
//   ② tosu 已经在跑（本机 PID 实测在跑），直接用
//   ③ 只需要 24050 一个本地端口，权限最小
//
// 取数端点：GET /json/sc（StreamCompanion 兼容格式）——一次拿全：
//   time            → 实时播放位置（秒）  ← 编辑器里的音频进度
//   rawStatus       → GameState 枚举      ← 判断是否在制谱器
//   mapTimingPoints → [{startTime, beatLength}]  ← 红线 timing
//   osuFileLocation → "文件夹/xxx.osu"     ← 当前谱面文件
//   totalAudioTime  → mp3 总时长
// ============================================================================

/** GameState 枚举（顺序严格对应 tosu packages/common/enums/osu.ts） */
export const GameState = {
    0: 'menu',
    1: 'edit',
    2: 'play',
    3: 'exit',
    4: 'selectEdit',
    5: 'selectPlay',
    6: 'selectDrawings',
    7: 'resultScreen',
    8: 'update',
    9: 'busy',
    10: 'unknown',
    11: 'lobby',
    12: 'matchSetup',
    13: 'selectMulti',
    14: 'rankingVs',
    15: 'onlineSelection',
    16: 'optionsOffsetWizard',
    17: 'rankingTagCoop',
    18: 'rankingTeam',
    19: 'beatmapImport'
};

/** 制谱器相关状态 */
export const EDITOR_STATES = new Set(['edit', 'selectEdit', 'selectDrawings']);

export function createTosuClient({ host = '127.0.0.1', port = 24050, timeoutMs = 1200 } = {}) {
    let base = `http://${host}:${port}`;

    /** 带超时的 GET（返回 JSON 或 null） */
    async function getJson(pathname) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${base}${pathname}`, { signal: ctrl.signal });
            const text = await res.text();
            if (!text) return null;
            const json = JSON.parse(text);
            // tosu 在 osu! 未运行时返回 { error: 'osu is not ready/running' }
            if (json && json.error) return null;
            return json;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * tosu 服务本身是否在监听（不要求 osu! 在跑）。
     * 注意：osu! 没开时 tosu 会返回 HTTP 500 + {"error":"osu is not ready/running"}，
     * 这依然是"tosu 活着"的证据，不能当成连不上。
     */
    async function isTosuUp() {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${base}/json/sc`, { signal: ctrl.signal });
            await res.text();
            // 收到任何 HTTP 响应（含 500）都说明端口后面是活的 tosu
            return res.status > 0;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    /** 拉一次完整状态；osu! 未就绪返回 null */
    async function getSc() {
        return getJson('/json/sc');
    }

    /**
     * 归一化成一个好用的状态对象。
     * @returns {null | {
     *   osuRunning:boolean, state:string, isEditor:boolean, time:number,
     *   timingPoints:{time:number,beatLength:number,bpm:number,uninherited:boolean,sv:number}[],
     *   fileLocation:string, fileName:string, audioName:string, audioLength:number,
     *   bpmRange:string, title:string, artist:string, difficulty:string, md5:string
     * }}
     */
    async function getState() {
        const sc = await getSc();
        if (!sc) return null;

        const state = GameState[sc.rawStatus] ?? 'unknown';

        // mapTimingPoints：红线 beatLength>0；绿线 beatLength<0（osu 约定）
        const timingPoints = (sc.mapTimingPoints || [])
            .map((r) => {
                const beatLength = r.beatLength;
                const uninherited = beatLength > 0;
                return {
                    time: Math.round(r.startTime), // 毫秒
                    beatLength,
                    bpm: uninherited ? round(60000 / beatLength, 4) : 0,
                    uninherited,
                    // 绿线：SV 倍率 = -100 / beatLength
                    sv: uninherited ? 1 : round(-100 / beatLength, 4)
                };
            })
            .sort((a, b) => a.time - b.time);

        return {
            osuRunning: sc.osuIsRunning === 1,
            state,
            isEditor: EDITOR_STATES.has(state),
            time: Number(sc.time) || 0, // 秒
            timingPoints,
            redCount: timingPoints.filter((p) => p.uninherited).length,
            greenCount: timingPoints.filter((p) => !p.uninherited).length,
            fileLocation: sc.osuFileLocation || '',
            fileName: sc.osuFileName || '',
            audioName: sc.mp3Name || '',
            audioLength: Number(sc.totalAudioTime) || 0,
            bpmRange: sc.mBpm || '',
            title: sc.title || '',
            artist: sc.artist || '',
            difficulty: sc.difficulty || '',
            md5: sc.md5 || '',
            folder: sc.dir || ''
        };
    }

    return {
        get base() {
            return base;
        },
        setPort(p) {
            port = p;
            base = `http://${host}:${port}`;
        },
        isTosuUp,
        getSc,
        getState
    };
}

function round(v, digits) {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
}

/** 找 tosu 监听端口（配置里没有或连不上时，扫一遍常见端口） */
export async function detectTosuPort(preferred = 24050) {
    const candidates = [preferred, 24050, 24051, 24052, 24053];
    for (const p of candidates) {
        const client = createTosuClient({ port: p, timeoutMs: 500 });
        if (await client.isTosuUp()) return p;
    }
    return null;
}
