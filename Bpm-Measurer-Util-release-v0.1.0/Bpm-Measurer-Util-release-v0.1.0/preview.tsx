// ===== 独立预览窗口的渲染入口 =====
//
// 这个页面只由主进程 open-preview-window 加载（frameless BrowserWindow，见 main.ts）。
// 它自己不解析谱面、不读音频：谱面与 timing 卡片由主窗口通过 BroadcastChannel 推过来
// （utils/previewBridge.ts），播放头也是主窗口每帧推 tick。
// 好处：预览的视觉效果与内嵌小窗**完全同一份代码**，不存在"独立窗口画得不一样"。
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import BeatmapPreview from './components/BeatmapPreview';
import type { OsuDocument } from './utils/osuBeatmap';
import type { PatchPoint } from './utils/osuPatch';
import type { PreviewCommand } from './utils/previewBridge';
import { PREVIEW_CHANNEL } from './utils/previewBridge';
import type { HostToPreview, PreviewRecSetting } from './utils/previewBridge';
import './index.css';

const api = () => (window as any).electronAPI;
/** 窗口位置尺寸（和主窗口共享同一个 file:// 源的 localStorage） */
const BOUNDS_KEY = 'bpm.preview.detach.win.v1';

interface Bounds { x: number; y: number; w: number; h: number }

function loadBounds(): Bounds | null {
  try {
    const b = JSON.parse(localStorage.getItem(BOUNDS_KEY) || 'null');
    if (b && Number.isFinite(b.w) && Number.isFinite(b.h)) return b as Bounds;
  } catch { /* ignore */ }
  return null;
}

const DetachedPreview: React.FC = () => {
  const [doc, setDoc] = useState<OsuDocument | null>(null);
  const [points, setPoints] = useState<PatchPoint[]>([]);
  const [fps, setFps] = useState<{ vsync: boolean; limit: number }>({ vsync: true, limit: 60 });
  /** 录制参数：由主窗口随 init 推过来（独立窗口读不到设置对象的实时值） */
  const [rec, setRec] = useState<PreviewRecSetting | undefined>(undefined);
  /** 节拍器是否混进录制音轨（同样是主窗口的设置，改动要回传主窗口落盘） */
  const [recMetronome, setRecMetronome] = useState(false);
  /** 主窗口的播放状态：暂停时预览要立刻锁死画面（否则显示时钟会多外推一帧） */
  const [playing, setPlaying] = useState(false);
  /** 音频总时长（毫秒）：完整录制到曲尾用，避免只录到「最后音符 + 2s」切掉音乐尾巴 */
  const [audioMs, setAudioMs] = useState<number | undefined>(undefined);
  const [hint, setHint] = useState('正在连接主窗口…');
  const chRef = useRef<BroadcastChannel | null>(null);
  const timeRef = useRef(0);

  // ---- 与主窗口建立通道 ----
  useEffect(() => {
    let alive = true;
    let ch: BroadcastChannel;
    try {
      ch = new BroadcastChannel(PREVIEW_CHANNEL);
    } catch (e) {
      setHint(`无法建立窗口通道：${String(e)}`);
      return;
    }
    chRef.current = ch;
    ch.onmessage = (ev: MessageEvent<HostToPreview>) => {
      if (!alive) return;
      const m = ev.data;
      if (!m) return;
      if (m.type === 'init') {
        setDoc(m.doc);
        setPoints(m.points || []);
        if (m.fps) setFps(m.fps);
        if (m.rec) setRec(m.rec);
        if (typeof m.recMetronome === 'boolean') setRecMetronome(m.recMetronome);
        if (typeof m.playing === 'boolean') setPlaying(m.playing);
        if (typeof m.audioMs === 'number') setAudioMs(m.audioMs);
        timeRef.current = m.t ?? 0;
        setHint('');
      } else if (m.type === 'tick') {
        timeRef.current = m.t;
      } else if (m.type === 'state') {
        setPlaying(m.playing);
      } else if (m.type === 'fps') {
        if (m.fps) setFps(m.fps);
      }
    };
    ch.postMessage({ type: 'ready' });
    // 8 秒还没拿到谱面：说明主窗口没把预览弹出来 / 通道没连上，给一句可读的提示
    const timer = window.setTimeout(() => {
      if (alive && !chRef.current) return;
      setHint(prev => (prev === '' ? '' : '还没收到谱面（请在主窗口重新打开预览）'));
    }, 8000);
    return () => { alive = false; window.clearTimeout(timer); ch.close(); chRef.current = null; };
  }, []);

  // ---- 窗口位置尺寸：打开时套用上次的，拖动/缩放结束后记住 ----
  useEffect(() => {
    const a = api();
    const saved = loadBounds();
    if (saved && a?.setPreviewWindowBounds) a.setPreviewWindowBounds(saved);
    let tmr = 0;
    const persist = () => {
      window.clearTimeout(tmr);
      tmr = window.setTimeout(() => {
        const b: Bounds = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
        try { localStorage.setItem(BOUNDS_KEY, JSON.stringify(b)); } catch { /* ignore */ }
      }, 400);
    };
    const flush = () => {
      const b: Bounds = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
      try { localStorage.setItem(BOUNDS_KEY, JSON.stringify(b)); } catch { /* ignore */ }
    };
    // 拖动窗口不会触发 resize 事件 → 定时比对位置，变了才写（便宜且不漏）
    let lastKey = `${window.screenX},${window.screenY},${window.outerWidth},${window.outerHeight}`;
    const tick = window.setInterval(() => {
      const k = `${window.screenX},${window.screenY},${window.outerWidth},${window.outerHeight}`;
      if (k === lastKey) return;
      lastKey = k;
      flush();
    }, 1200);
    window.addEventListener('resize', persist);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.clearTimeout(tmr);
      window.clearInterval(tick);
      window.removeEventListener('resize', persist);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  const sendCmd = (cmd: PreviewCommand) => {
    chRef.current?.postMessage({ type: 'cmd', cmd });
  };

  /** 工具条上切「节拍器入录」：消息回传主窗口，由它写进设置（音图在主窗口那边） */
  const changeRecMetronome = (v: boolean) => {
    setRecMetronome(v); // 先就地生效，界面不必等一个来回
    chRef.current?.postMessage({ type: 'setting', recMetronome: v });
  };

  /** 录制开始/结束：告诉主窗口关掉/恢复「跟随播放头」 */
  const recordingChanged = (on: boolean) => {
    chRef.current?.postMessage({ type: 'recording', on });
  };

  if (!doc) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#8282a0', fontSize: 12, fontFamily: 'sans-serif', textAlign: 'center', padding: 16,
                    WebkitAppRegion: 'drag' } as React.CSSProperties}>
        {hint}
      </div>
    );
  }

  return (
    <BeatmapPreview
      detached
      doc={doc}
      points={points}
      getPlayheadTime={() => timeRef.current}
      fps={fps}
      recHeight={rec?.height}
      recFps={rec?.fps}
      recKbps={rec?.kbps}
      playing={playing}
      audioMs={audioMs}
      recordMetronome={recMetronome}
      onRecordMetronomeChange={changeRecMetronome}
      onRecordingChange={recordingChanged}
      onCommand={sendCmd}
      onClose={() => { api()?.closePreviewWindow?.(); }}
    />
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DetachedPreview />
  </React.StrictMode>
);
