// ============================================================================
// 定时备份模块
//
// 规则（按需求）：
//   · 默认每 2 分钟备份一次正在编辑的 .osu（intervalMinutes 可改）
//   · 默认保留 60 份，超出后删最旧的（keepCount 可改）
//   · 文件名 = 年-月-日-时-分，例：2026-9-21-0-35.osu
//   · 多张谱面分开存 → backups\<谱面标识>\年-月-日-时-分.osu
//   · 内容没变则跳过（onlyWhenChanged），避免刷一堆一模一样的
//   · 每次「写回谱面」之前强制备份一次（backupBeforeWrite）= 安全网
//
// 安全约束（重要）：
//   · 删除时**只删**备份目录内、文件名严格匹配 时间戳 模式的 .osu
//   · 绝不递归删目录、绝不删备份目录本身、绝不动备份目录以外的任何文件
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, getBackupDir } from './config.mjs';
import { sha1 } from './osuFile.mjs';

/** 严格的时间戳文件名模式：年-月-日-时-分（允许 -序号 去重后缀） */
const BACKUP_NAME_RE = /^\d{1,4}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,2}(?:-\d+)?\.osu$/i;

/** 把谱面标识转成安全的文件夹名 */
function safeFolderName(name) {
    return (name || 'unknown')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\.+$/, '')
        .trim()
        .slice(0, 80) || 'unknown';
}

/** 年-月-日-时-分（无补零，按需求） */
export function stampName(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

export function createBackupManager({ getSource, getLabel, onLog } = {}) {
    let timer = null;
    let lastRunAt = 0;
    let lastHash = '';
    let lastBackupPath = '';
    let lastError = '';
    let stats = { total: 0, skipped: 0, failed: 0 };

    const log = (msg) => {
        if (typeof onLog === 'function') onLog(msg);
    };

    /** 当前谱面的备份目录 */
    function dirFor(label) {
        const root = getBackupDir();
        const sub = safeFolderName(label);
        const dir = path.join(root, sub);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** 列出某个谱面的备份（按时间新→旧） */
    function listBackups(label) {
        // 没有谱面标识就不要碰磁盘：dirFor() 里有 fs.mkdirSync()，
        // 空标识会顺着 safeFolderName() 的兜底值在 backups\ 下建出一个
        // 名为 unknown 的空文件夹 —— 而 status() 每次状态快照都会调本函数。
        if (!label) return [];
        let dir;
        try {
            dir = dirFor(label);
        } catch {
            return [];
        }
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        return names
            .filter((n) => BACKUP_NAME_RE.test(n)) // 只认自己生成的
            .map((n) => {
                const full = path.join(dir, n);
                let st = null;
                try {
                    st = fs.statSync(full);
                } catch {
                    return null;
                }
                return { name: n, path: full, size: st.size, mtime: st.mtimeMs };
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
    }

    /**
     * 清理超出保留数的旧备份。
     * 只删 listBackups() 的结果（已严格过滤），且只删文件不删目录。
     */
    function prune(label) {
        const cfg = loadConfig();
        const keep = Math.max(1, Number(cfg.backup.keepCount) || 60);
        const all = listBackups(label);
        const remove = all.slice(keep);
        let removed = 0;
        for (const f of remove) {
            try {
                fs.unlinkSync(f.path); // 仅删除单个已核验的文件
                removed++;
            } catch (e) {
                lastError = `清理失败 ${f.name}: ${e.message}`;
                log(lastError);
            }
        }
        return { kept: Math.min(all.length, keep), removed };
    }

    /**
     * 立刻备份一次。
     * @param {string} reason 'timer' | 'before-write' | 'manual'
     */
    function backupNow(reason = 'manual') {
        const cfg = loadConfig();
        if (!cfg.backup.enabled && reason === 'timer') return { ok: false, reason: 'disabled' };

        const source = typeof getSource === 'function' ? getSource() : '';
        if (!source || !fs.existsSync(source)) {
            return { ok: false, reason: 'no-source' };
        }

        const label = typeof getLabel === 'function' ? getLabel() : path.basename(source);

        let content;
        try {
            content = fs.readFileSync(source, 'utf8');
        } catch (e) {
            lastError = '读取源文件失败: ' + e.message;
            stats.failed++;
            return { ok: false, reason: 'read-failed', error: lastError };
        }

        const hash = sha1(content);
        if (cfg.backup.onlyWhenChanged && reason === 'timer' && hash === lastHash) {
            stats.skipped++;
            return { ok: false, reason: 'unchanged' };
        }

        const dir = dirFor(label);
        let name = `${stampName()}.osu`;
        let target = path.join(dir, name);
        // 同一分钟内重复备份 → 加 -2 / -3 去重
        let n = 1;
        while (fs.existsSync(target)) {
            n++;
            name = `${stampName()}-${n}.osu`;
            target = path.join(dir, name);
        }

        try {
            fs.writeFileSync(target, content, 'utf8');
        } catch (e) {
            lastError = '写备份失败: ' + e.message;
            stats.failed++;
            return { ok: false, reason: 'write-failed', error: lastError };
        }

        lastHash = hash;
        lastBackupPath = target;
        lastRunAt = Date.now();
        stats.total++;
        lastError = '';

        const pr = prune(label);
        log(`备份完成 [${reason}] → ${target}（保留 ${pr.kept} 份，清理 ${pr.removed} 份）`);
        return { ok: true, path: target, name, pruned: pr.removed, kept: pr.kept };
    }

    /** 定时器心跳：每 15 秒检查一次是否到了备份间隔 */
    function tick() {
        const cfg = loadConfig();
        if (!cfg.backup.enabled) return;
        const intervalMs = Math.max(1, Number(cfg.backup.intervalMinutes) || 2) * 60 * 1000;
        if (Date.now() - lastRunAt >= intervalMs) {
            backupNow('timer');
        }
    }

    function start() {
        if (timer) return;
        lastRunAt = Date.now(); // 启动后先等一个完整间隔，不立刻备份
        timer = setInterval(tick, 15 * 1000);
        if (timer.unref) timer.unref();
        log('备份调度已启动');
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return {
        start,
        stop,
        backupNow,
        listBackups,
        prune,
        /** 供外部查询：下次备份还有多久 */
        status(label) {
            const cfg = loadConfig();
            const intervalMs = Math.max(1, Number(cfg.backup.intervalMinutes) || 2) * 60 * 1000;
            const list = label ? listBackups(label) : [];
            return {
                enabled: !!cfg.backup.enabled,
                intervalMinutes: Number(cfg.backup.intervalMinutes) || 2,
                keepCount: Number(cfg.backup.keepCount) || 60,
                dir: getBackupDir(),
                lastRunAt,
                nextRunAt: lastRunAt ? lastRunAt + intervalMs : Date.now() + intervalMs,
                lastBackupPath,
                lastError,
                stats: { ...stats },
                count: list.length,
                latest: list.slice(0, 5).map((f) => ({ name: f.name, size: f.size, mtime: f.mtime })),
                usageBytes: list.reduce((s, f) => s + f.size, 0)
            };
        },
        /** 重置变更检测（比如切换谱面后，允许下一次立刻备份） */
        resetHistory() {
            lastHash = '';
            lastRunAt = 0;
        }
    };
}
