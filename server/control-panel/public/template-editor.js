// Premium Jazz Lounge — Template Editor (Phase 4-C-2 v5: AudioMotion-analyzer)
// vanilla ES module. interact.js 는 글로벌 (CDN 으로 로드).
// AudioMotion-analyzer ESM 을 jsdelivr CDN 으로 import (오프라인이면 패키지 dist 로 교체).
import AudioMotionAnalyzer from 'https://cdn.jsdelivr.net/npm/audiomotion-analyzer@4/+esm';
import {
  ANIMATION_TYPES,
  createController as createNPController,
  applyStateToElement as applyNPState,
  runPreview as runNPPreview,
} from './now-playing-animations.js';
import { drawPlaylist } from './playlist-renderer.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const te = {
  templates: [],           // GET /api/templates
  components: [],          // 현재 캔버스 컴포넌트들
  bgUrl: null,             // 배경 이미지 URL
  selectedId: null,        // 선택된 컴포넌트 id
  editingTemplate: null,   // 현재 편집 기준 템플릿 (있으면 새 저장 시 dup, 없으면 fresh)
  initialized: false,
};

// ─── Toast (app.js 의 토스터 재사용) ─────────────────────────────
function toast(msg, type = 'info', durationMs = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toaster')?.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.2s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, durationMs);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

async function apiGet(path) {
  const res = await fetch(path);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ─── Component factories ────────────────────────────────────────
let _idCounter = 1;
function nextId() {
  _idCounter += 1;
  return `c${Date.now().toString(36)}_${_idCounter}`;
}

function defaultsFor(type) {
  const baseSize = { width: 600, height: 120 };
  const base = {
    id: nextId(),
    type,
    x: (CANVAS_W - baseSize.width) / 2,
    y: (CANVAS_H - baseSize.height) / 2,
    width: baseSize.width,
    height: baseSize.height,
    rotation: 0,
    opacity: 1.0,
  };
  switch (type) {
    case 'text':
      return {
        ...base,
        content: '{{trackTitle}}',
        fontSize: 72,
        fontFamily: 'Playfair Display, serif',
        color: '#FFFFFF',
        textAlign: 'center',
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        letterSpacing: 0,
        lineHeight: 1.2,
        textTransform: 'none',
        glowIntensity: 1.0,         // 0~2, textShadow 강도. 어두운 색이면 자동 비활성.
        autoWrap: true,             // true: 박스 폭 넘으면 자동 wrap, false: 고정 (overflow ellipsis)
      };
    case 'image':
      return { ...base, src: '', fit: 'contain', width: 400, height: 400 };
    case 'visualizer':
      // AudioMotion-analyzer 기반 (Phase 4-C-2 v5).
      // legacy (sensitivity/midBoost/highBoost/smoothing-old/centerCut/trimStart/barCount) 폐기.
      return {
        ...base,
        width: 1200, height: 240,
        x: (CANVAS_W - 1200) / 2, y: 760,
        // ── AudioMotion 옵션 ──
        mode: 3,                    // 1/8 octave / 80 bands (default)
        gradient: 'rainbow',        // classic / prism / rainbow / orangered / steelblue / ...
        mirror: 0,                  // -1 / 0 / 1
        radial: false,
        reflexRatio: 0,             // 0~1
        reflexAlpha: 1,             // 0~1
        showPeaks: true,
        ledBars: false,
        lumiBars: false,
        alphaBars: false,
        outlineBars: false,
        roundBars: false,
        minFreq: 30,                // Hz
        maxFreq: 20000,             // Hz
        minDecibels: -85,
        maxDecibels: -25,
        smoothing: 0.5,             // AudioMotion 자체 smoothing (0~1)
        weightingFilter: 'D',       // '' / A / B / C / D / 468
        frequencyScale: 'log',      // log / linear / bark / mel
        channelLayout: 'single',    // single / dual-horizontal / dual-vertical / dual-combined
        // ── 디자인 ──
        verticalMode: 'symmetric',  // 'symmetric' | 'up' | 'down' (편집기 미리보기 카드용 정적 표시)
        splitGap: 0,                // 카드 썸네일 정적 표시용
        glow: 20,                   // CSS drop-shadow px
        colorMode: 'solid',         // 'solid' | 'gradient' — 글로우 색 + 카드 썸네일
        color: '#D4AF37',
        gradientStops: [
          { position: 0,   color: '#FFFFFF' },
          { position: 50,  color: '#D4AF37' },
          { position: 100, color: '#A04000' },
        ],
      };
    case 'progress':
      return {
        ...base,
        width: 1600, height: 8,
        x: (CANVAS_W - 1600) / 2, y: 1020,
        style: 'melody',
        bgColor: 'rgba(255,255,255,0.1)',
        fillColor: '#D4AF37',
      };
    case 'nowplaying':
      // Phase 4-D-3-A — 곡 제목 자동 표시 + 5종 애니메이션. 한 영상에 1개만.
      return {
        ...base,
        width: 800, height: 80,
        x: (CANVAS_W - 800) / 2, y: 950,
        // 텍스트 디자인
        fontFamily: 'system-ui, sans-serif',
        fontSize: 48,
        bold: true,
        italic: false,
        underline: false,
        color: '#FFFFFF',
        textAlign: 'center',
        textTransform: 'none',
        letterSpacing: 0,
        // glow
        glow: 20,
        glowColor: '#D4AF37',
        // 애니메이션
        animation: 'fade',           // 'fade' | 'slide' | 'typewriter' | 'glow' | 'blur'
        animationDurationMs: 800,
        fadeOutMs: 500,
        // Editor 미리보기 텍스트
        previewText: 'Sample Track Title',
      };
    case 'playlist':
      // Phase 4-D-3-B — 곡 전체 목록 표시 + 현재 곡 강조. 한 영상에 1개만.
      return {
        ...base,
        width: 1600, height: 200,
        x: (CANVAS_W - 1600) / 2, y: 200,
        // 레이아웃
        layout: 'slash',  // 'numbered' | 'dot' | 'slash' | 'box' | 'timecode'
        // 텍스트 디자인
        fontFamily: 'system-ui, sans-serif',
        fontSize: 28,
        bold: false,
        italic: true,            // 형님 시그니처
        color: '#FFFFFF',
        textAlign: 'center',
        letterSpacing: 0,
        lineHeight: 1.5,
        glow: 10,
        glowColor: '#D4AF37',
        // 강조 (토글)
        highlightEnabled: true,
        highlightColor: '#D4AF37',
        highlightBold: true,
        highlightItalic: false,
        highlightUnderline: false,
        highlightFontSize: null,  // null = 동일 크기, 숫자면 그 크기
        // 미리보기 (Editor 만)
        previewTracks: [
          'Sample Track One',
          'Sample Track Two',
          'Sample Track Three',
          'Sample Track Four',
          'Sample Track Five',
          'Sample Track Six',
        ],
        previewCurrentIdx: 1,
      };
  }
  return base;
}

// 한 영상에 NowPlaying 1개 제약 — 추가 시 기존 존재 여부 검사.
function hasNowPlaying() {
  return te.components.some((c) => c.type === 'nowplaying');
}

// 한 영상에 Playlist 1개 제약. NowPlaying 과 별개 (둘 다 추가 가능).
function hasPlaylist() {
  return te.components.some((c) => c.type === 'playlist');
}

// ─── 색상 유틸 ───────────────────────────────────────────────
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  if (m.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

function rgbToCss(c) { return `rgb(${c.r},${c.g},${c.b})`; }

function lerp(a, b, t) { return a + (b - a) * t; }

function interpolateColor(hex1, hex2, t) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  return {
    r: Math.round(lerp(c1.r, c2.r, t)),
    g: Math.round(lerp(c1.g, c2.g, t)),
    b: Math.round(lerp(c1.b, c2.b, t)),
  };
}

// position 0~100 에서의 그라데이션 색을 RGB 객체로 반환.
function gradientColorAt(stops, pct) {
  if (!stops || !stops.length) return { r: 212, g: 175, b: 55 };
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (pct <= sorted[0].position) return hexToRgb(sorted[0].color);
  if (pct >= sorted[sorted.length - 1].position) return hexToRgb(sorted[sorted.length - 1].color);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (pct >= a.position && pct <= b.position) {
      const span = Math.max(0.0001, b.position - a.position);
      const t = (pct - a.position) / span;
      return interpolateColor(a.color, b.color, t);
    }
  }
  return hexToRgb(sorted[sorted.length - 1].color);
}

// 막대 인덱스(좌우 미러 인덱스, 0..N-1) 에 대한 색상.
function getBarColor(c, barIndex, totalBars) {
  if (c.colorMode !== 'gradient' || !c.gradientStops?.length) {
    return hexToRgb(c.color || '#D4AF37');
  }
  const pct = (barIndex / Math.max(1, totalBars - 1)) * 100;
  return gradientColorAt(c.gradientStops, pct);
}

// CSS 그라데이션 미리보기 문자열
function gradientCss(stops) {
  if (!stops || !stops.length) return '#D4AF37';
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  return `linear-gradient(90deg, ${sorted.map((s) => `${s.color} ${s.position}%`).join(', ')})`;
}

// ─── 어두운 텍스트 색상 → 그림자 자동 약화 ───────────────────
function isDarkColor(hex) {
  if (!hex || typeof hex !== 'string') return false;
  const m = hex.replace('#', '');
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  // perceived luminance (Rec. 709)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 110;
}

// ─── 옛 schema → 새 schema 어댑터 ─────────────────────────────
function loadConfigToCanvas(cfg) {
  // 새 형식: components[] 가 있으면 그대로
  if (Array.isArray(cfg?.components)) {
    return cfg.components.map((c) => ({ ...c, id: c.id || nextId() }));
  }
  // 옛 형식 → 변환
  const result = [];
  if (cfg?.title) {
    result.push({
      id: nextId(),
      type: 'text',
      x: (CANVAS_W - 1200) / 2,
      y: 480,
      width: 1200, height: 160,
      rotation: 0, opacity: 1.0,
      content: cfg.title.text || '{{trackTitle}}',
      fontSize: cfg.title.fontSize ?? 72,
      fontFamily: cfg.title.fontFamily || 'Playfair Display, serif',
      color: cfg.title.color || '#FFFFFF',
      textAlign: 'center',
      bold: false, italic: false, underline: false, strikethrough: false,
      letterSpacing: 0, lineHeight: 1.2, textTransform: 'none',
      glowIntensity: 1.0, autoWrap: true,
    });
  }
  if (cfg?.visualizer) {
    const v = cfg.visualizer;
    const w = v.width ?? 1200;
    const h = v.height ?? 240;
    const vmMap = ['symmetric', 'up', 'down'];
    const verticalMode = typeof v.vMirror === 'number'
      ? (vmMap[v.vMirror] || 'symmetric')
      : (v.verticalMode || 'symmetric');
    // AudioMotion 기본값으로 채움 (legacy sensitivity/midBoost/etc. 무시).
    result.push({
      id: nextId(),
      type: 'visualizer',
      x: (v.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (v.position?.y ?? 880) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      mode: v.mode ?? 3,
      gradient: v.gradient ?? 'rainbow',
      mirror: v.mirror ?? 0,
      radial: v.radial ?? false,
      reflexRatio: v.reflexRatio ?? 0,
      reflexAlpha: v.reflexAlpha ?? 1,
      showPeaks: v.showPeaks ?? true,
      ledBars: v.ledBars ?? false,
      lumiBars: v.lumiBars ?? false,
      alphaBars: v.alphaBars ?? false,
      outlineBars: v.outlineBars ?? false,
      roundBars: v.roundBars ?? false,
      minFreq: v.minFreq ?? 30,
      maxFreq: v.maxFreq ?? 20000,
      minDecibels: v.minDecibels ?? -85,
      maxDecibels: v.maxDecibels ?? -25,
      smoothing: v.smoothing ?? 0.5,
      weightingFilter: v.weightingFilter ?? 'D',
      frequencyScale: v.frequencyScale ?? 'log',
      channelLayout: v.channelLayout ?? 'single',
      verticalMode,
      splitGap: v.splitGap ?? 0,
      glow: v.glow ?? (typeof v.glowIntensity === 'number' ? Math.round(v.glowIntensity * 30) : 20),
      colorMode: v.colorMode || 'solid',
      color: v.color || '#D4AF37',
      gradientStops: v.gradientStops,
    });
  }
  if (cfg?.progressBar) {
    const p = cfg.progressBar;
    const w = p.width ?? 1600;
    const h = p.height ?? 8;
    result.push({
      id: nextId(),
      type: 'progress',
      x: (p.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (p.position?.y ?? 1020) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      style: p.style || 'melody',
      bgColor: p.bgColor || 'rgba(255,255,255,0.1)',
      fillColor: p.fillColor || '#D4AF37',
    });
  }
  return result;
}

// ─── Render ─────────────────────────────────────────────────────
function getScale() {
  const frame = $('#teCanvasFrame');
  if (!frame) return 1;
  return frame.clientWidth / CANVAS_W;
}

function placeholderText(content) {
  if (!content) return '';
  return String(content)
    .replace(/\{\{trackTitle\}\}/g, 'Track Title (preview)')
    .replace(/\{\{trackNumber\}\}/g, '1')
    .replace(/\{\{totalTracks\}\}/g, '14');
}

// Visualizer 컴포넌트의 inner — AudioMotion 이 자체 canvas 를 만들어 넣음.
// 우리는 빈 컨테이너만 제공. 실제 attach/destroy 는 attachVisualizerInstance 에서.
function renderBars(c) {
  return `<div class="te-vis-am-container" data-vis-am-id="${c.id}" style="width:100%;height:100%;position:relative;overflow:hidden;"></div>`;
}

// ─── Audio preview (shared MediaElementSource) ────────────────────
// AudioMotion-analyzer 가 자체적으로 FFT/AnalyserNode 를 관리.
// 우리는 single MediaElementAudioSourceNode 만 공유 — 모든 visualizer 가 이걸 source 로 사용.
const audio = {
  context: null,
  element: null,
  source: null,           // MediaElementAudioSourceNode
  trackId: null,
  duration: 0,
  cachedTracks: null,     // [{ id, label }]
};

// AudioMotion 옵션 추출 — comp 의 schema 필드를 AudioMotion options 로 매핑.
function audioMotionOptions(c) {
  return {
    mode: c.mode ?? 3,
    gradient: c.gradient ?? 'rainbow',
    mirror: c.mirror ?? 0,
    radial: !!c.radial,
    reflexRatio: c.reflexRatio ?? 0,
    reflexAlpha: c.reflexAlpha ?? 1,
    showPeaks: c.showPeaks ?? true,
    showBgColor: false,             // 우리 컨테이너에 배경 따로 둠
    overlay: true,                  // 투명
    ledBars: !!c.ledBars,
    lumiBars: !!c.lumiBars,
    alphaBars: !!c.alphaBars,
    outlineBars: !!c.outlineBars,
    roundBars: !!c.roundBars,
    minFreq: c.minFreq ?? 30,
    maxFreq: c.maxFreq ?? 20000,
    minDecibels: c.minDecibels ?? -85,
    maxDecibels: c.maxDecibels ?? -25,
    smoothing: c.smoothing ?? 0.5,
    weightingFilter: c.weightingFilter ?? 'D',
    frequencyScale: c.frequencyScale ?? 'log',
    channelLayout: c.channelLayout ?? 'single',
    useCanvas: true,
  };
}

function applyVisualizerGlow(container, c) {
  if (!container) return;
  const glow = Math.max(0, c.glow ?? 0);
  if (glow > 0) {
    const glowColor = c.colorMode === 'gradient' ? '#D4AF37' : (c.color || '#D4AF37');
    container.style.filter = `drop-shadow(0 0 ${glow}px ${glowColor})`;
  } else {
    container.style.filter = 'none';
  }
}

// 컴포넌트의 AudioMotion 인스턴스를 (없으면) 새로 만들고, (있으면) 옵션만 갱신.
function attachVisualizerInstance(c) {
  if (c.type !== 'visualizer') return;
  const container = document.querySelector(`#teCanvasInner [data-id="${c.id}"] [data-vis-am-id="${c.id}"]`);
  if (!container) return;
  applyVisualizerGlow(container, c);

  if (c._audioMotion && !c._audioMotion.isDestroyed) {
    try { c._audioMotion.setOptions(audioMotionOptions(c)); } catch {}
    // source 는 audio.source 가 있으면 한번만 connect (idempotent 체크).
    if (audio.source) {
      try {
        const connected = c._audioMotion.connectedSources || [];
        const has = connected.indexOf(audio.source) >= 0;
        if (!has) c._audioMotion.connectInput(audio.source);
      } catch {}
    }
    return;
  }

  // 신규 인스턴스 — audio.context 가 있으면 share, 아니면 AudioMotion 이 자체 생성.
  try {
    c._audioMotion = new AudioMotionAnalyzer(container, {
      ...audioMotionOptions(c),
      audioCtx: audio.context || undefined,
      source: audio.source || undefined,
      connectSpeakers: false,    // 스피커 연결은 우리가 한 번만 함 (loadPreviewTrack)
    });
  } catch (e) {
    console.error('[AudioMotion] 생성 실패:', e);
  }
}

function destroyVisualizerInstance(c) {
  if (c?._audioMotion) {
    try { c._audioMotion.destroy(); } catch {}
    delete c._audioMotion;
  }
}

// 모든 visualizer 인스턴스를 새 audio.source 에 다시 연결.
function reattachAllVisualizerSources() {
  for (const c of te.components) {
    if (c.type !== 'visualizer' || !c._audioMotion) continue;
    try { c._audioMotion.disconnectInput(null, false); } catch {}
    if (audio.source) {
      try { c._audioMotion.connectInput(audio.source); } catch (e) {
        console.warn('[AudioMotion] connectInput 실패:', e.message);
      }
    }
  }
}

// 50ms 마다 디버그 패널만 갱신 (AudioMotion 본체는 자체 RAF 로 동작).
let _visTickerStarted = false;
function startVisualizerTicker() {
  if (_visTickerStarted) return;
  _visTickerStarted = true;
  setInterval(() => {
    if (!te.initialized) return;
    updateDebugSpectrumPanel();
  }, 200);
}

function updateDebugSpectrumPanel() {
  const cb = document.getElementById('teDebugSpectrum');
  const panel = document.getElementById('teDebugSpectrumPanel');
  if (!cb || !panel) return;
  if (!cb.checked) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  const visComps = te.components.filter((c) => c.type === 'visualizer');
  if (!visComps.length) {
    panel.textContent = '(visualizer 컴포넌트 없음)';
    return;
  }
  const c = visComps[0];
  const am = c._audioMotion;
  if (!am) {
    panel.textContent = '(AudioMotion 인스턴스 미생성)';
    return;
  }
  const playing = audio.element && !audio.element.paused;
  const bars = am.getBars?.() || [];
  let mx = 0, sum = 0;
  for (const b of bars) {
    const v = Array.isArray(b.value) ? b.value[0] : b.value;
    if (v > mx) mx = v;
    sum += v;
  }
  const avg = bars.length ? sum / bars.length : 0;
  const fmt = (v) => Number(v).toFixed(3);
  panel.textContent = [
    `state: ${playing ? '▶ playing' : '⏸ stopped'}    bars: ${bars.length}    max: ${fmt(mx)}  avg: ${fmt(avg)}`,
    `mode: ${am.mode}  gradient: ${am.gradient}  freqScale: ${am.frequencyScale}`,
    `freq: ${am.minFreq}~${am.maxFreq} Hz   dB: ${am.minDecibels}~${am.maxDecibels}`,
    `smoothing: ${am.smoothing}  weighting: ${am.weightingFilter}`,
    `bass energy: ${fmt(am.getEnergy?.('bass') ?? 0)}  mid: ${fmt(am.getEnergy?.('mid') ?? 0)}  treble: ${fmt(am.getEnergy?.('treble') ?? 0)}`,
  ].join('\n');
}

// roundedRect — 카드 썸네일/progress 에서 사용.
function roundedRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}

function renderProgress(c) {
  return `<div class="te-progress-track" style="background:${c.bgColor || 'rgba(255,255,255,0.1)'};">
    <div class="te-progress-fill" style="background:${c.fillColor || '#D4AF37'};"></div>
  </div>`;
}

function buildTextShadow(c) {
  if (isDarkColor(c.color)) return 'none';
  const intensity = c.glowIntensity ?? 1.0;
  if (intensity <= 0) return 'none';
  const blur = Math.round(20 * intensity);
  const alpha = Math.min(1, 0.5 + intensity * 0.3);
  return `0 0 ${blur}px rgba(212,175,55,${alpha.toFixed(2)})`;
}

function buildTextDecoration(c) {
  const parts = [];
  if (c.underline) parts.push('underline');
  if (c.strikethrough) parts.push('line-through');
  return parts.length ? parts.join(' ') : 'none';
}

function renderTextInner(c) {
  const shadow = buildTextShadow(c);
  // autoWrap=true:  pre-line  → 형님 입력 \n 만 줄바꿈, 박스 폭 넘으면 자동 wrap
  // autoWrap=false: pre       → \n 만 줄바꿈, 박스 폭 넘으면 hidden + ellipsis
  const autoWrap = c.autoWrap !== false; // default true
  const whiteSpace = autoWrap ? 'pre-line' : 'pre';
  const overflow = autoWrap ? 'visible' : 'hidden';
  const wordWrap = autoWrap ? 'break-word' : 'normal';
  return `<div class="text-render" style="
    color: ${c.color || '#FFFFFF'};
    font-size: ${c.fontSize || 72}px;
    font-family: ${c.fontFamily || 'Playfair Display, serif'};
    text-align: ${c.textAlign || 'center'};
    text-shadow: ${shadow};
    line-height: ${c.lineHeight ?? 1.2};
    font-weight: ${c.bold ? 700 : 400};
    font-style: ${c.italic ? 'italic' : 'normal'};
    text-decoration: ${buildTextDecoration(c)};
    letter-spacing: ${c.letterSpacing ?? 0}px;
    text-transform: ${c.textTransform || 'none'};
    white-space: ${whiteSpace};
    overflow: ${overflow};
    word-wrap: ${wordWrap};
    width: 100%;
  ">${escapeHtml(placeholderText(c.content || ''))}</div>`;
}

function renderImageInner(c) {
  if (!c.src) {
    return `<div style="color:var(--text-muted);font-size:11px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(255,255,255,0.04);border:1px dashed var(--border-strong);">(이미지 없음)</div>`;
  }
  const fit = c.fit || 'contain';
  return `<img src="${escapeHtml(c.src)}" style="object-fit:${fit};width:100%;height:100%;" />`;
}

function renderComponentInner(c) {
  switch (c.type) {
    case 'text':       return renderTextInner(c);
    case 'image':      return renderImageInner(c);
    case 'visualizer': return renderBars(c);
    case 'progress':   return renderProgress(c);
    case 'nowplaying': return renderNowPlayingInner(c);
    case 'playlist':   return renderPlaylistInner(c);
  }
  return '';
}

// Playlist inner — Editor 도 canvas 로 그림 (Studio 의 미리보기 = 녹화 일치 보장 패턴 동일).
// 컴포넌트 div 안에 canvas 하나. comp.width × comp.height (real px). CSS 로 100% 채움.
function renderPlaylistInner(c) {
  return `<canvas
    class="te-playlist-canvas"
    data-playlist-id="${c.id}"
    width="${Math.round(c.width)}"
    height="${Math.round(c.height)}"
    style="width:100%;height:100%;pointer-events:none;display:block;"
  ></canvas>`;
}

// 컴포넌트가 캔버스에 attach 된 후 호출 — 한 번 그리기 (정적 미리보기).
// 속성 변경 / 리사이즈 후엔 다시 호출 필요.
function renderPlaylistOnCanvas(c) {
  const cv = document.querySelector(`canvas[data-playlist-id="${c.id}"]`);
  if (!cv) return;
  // resize 시 width/height 속성도 갱신 (CSS 만으론 cv 픽셀 해상도 안 바뀜)
  if (cv.width !== Math.round(c.width)) cv.width = Math.round(c.width);
  if (cv.height !== Math.round(c.height)) cv.height = Math.round(c.height);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  // playlist-renderer 는 comp.x/y 를 absolute world 로 다룸. Editor 의 컴포넌트 canvas 는
  // 자체 origin (0,0) 기준 → comp 의 x/y 를 0,0 으로 임시 치환해 전달.
  // opacity 는 parent .te-comp div 가 CSS 로 이미 적용 → canvas 안에선 1 로 (이중 적용 방지).
  const localComp = { ...c, x: 0, y: 0, opacity: 1 };
  const tracks = (c.previewTracks || []).map((t) => {
    if (typeof t === 'string') return { title: t, durationSec: 180 };
    return { title: t.title || '', durationSec: t.durationSec || 180 };
  });
  const curIdx = Math.min(
    Math.max(0, c.previewCurrentIdx ?? 0),
    Math.max(0, tracks.length - 1)
  );
  drawPlaylist(ctx, localComp, tracks, curIdx);
}

// NowPlaying inner — Editor 미리보기는 plain div. 애니메이션 미리보기 시 inline style 갱신.
function renderNowPlayingInner(c) {
  const align = c.textAlign || 'center';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const fs = `${c.italic ? 'italic ' : ''}${c.bold ? '700 ' : '400 '}${c.fontSize || 48}px ${c.fontFamily || 'system-ui, sans-serif'}`;
  const color = c.color || '#FFFFFF';
  const glow = Math.max(0, c.glow ?? 0);
  const glowColor = c.glowColor || '#D4AF37';
  const shadow = glow > 0 ? `0 0 ${glow}px ${glowColor}, 0 0 ${glow * 2}px ${glowColor}` : 'none';
  return `<div class="te-np-text" data-np-id="${c.id}" style="
    width:100%;height:100%;display:flex;align-items:center;justify-content:${justify};
    font:${fs};color:${color};text-shadow:${shadow};
    text-transform:${c.textTransform || 'none'};
    text-decoration:${c.underline ? 'underline' : 'none'};
    letter-spacing:${c.letterSpacing ?? 0}px;
    white-space:nowrap;overflow:visible;
    pointer-events:none;user-select:none;
  ">${escapeHtml(c.previewText || 'Sample Track Title')}</div>`;
}

function applyComponentTransform(el, c) {
  const s = getScale();
  el.style.left = `${c.x * s}px`;
  el.style.top = `${c.y * s}px`;
  el.style.width = `${c.width * s}px`;
  el.style.height = `${c.height * s}px`;
  el.style.opacity = String(c.opacity ?? 1);
  el.dataset.x = String(c.x);
  el.dataset.y = String(c.y);
  el.dataset.w = String(c.width);
  el.dataset.h = String(c.height);

  // Text/visualizer 의 fontSize 등 내부 비주얼 요소도 scale 반영
  if (c.type === 'text') {
    const tr = el.querySelector('.text-render');
    if (tr) tr.style.fontSize = `${(c.fontSize || 72) * s}px`;
  }
}

function renderCanvas() {
  const inner = $('#teCanvasInner');
  if (!inner) return;
  // 기존 visualizer 인스턴스 destroy (DOM 이 사라질 거니까)
  for (const c of te.components) {
    if (c.type === 'visualizer') destroyVisualizerInstance(c);
  }
  inner.innerHTML = '';
  for (const c of te.components) {
    const el = document.createElement('div');
    el.className = `te-comp te-comp-${c.type}`;
    el.dataset.id = c.id;
    if (c.id === te.selectedId) el.classList.add('selected');
    el.innerHTML = `
      ${renderComponentInner(c)}
      <button class="te-del" type="button" title="삭제">✕</button>
      <div class="te-handle"></div>
      <div class="te-opacity">
        <input type="range" min="0" max="100" value="${Math.round((c.opacity ?? 1) * 100)}" />
      </div>
    `;
    applyComponentTransform(el, c);
    inner.appendChild(el);
    bindComponentInteractions(el, c);
  }
  // visualizer 들 attach (DOM 이 들어간 다음에)
  for (const c of te.components) {
    if (c.type === 'visualizer') attachVisualizerInstance(c);
  }
  // playlist 캔버스 그리기 (DOM 이 들어간 다음에)
  for (const c of te.components) {
    if (c.type === 'playlist') renderPlaylistOnCanvas(c);
  }
  $('#teCompCount').textContent = String(te.components.length);
  renderBg();
  renderProps();
  updateAddNowPlayingBtn();
  updateAddPlaylistBtn();
}

function renderBg() {
  const bgEl = $('#teCanvasBg');
  if (!bgEl) return;
  if (te.bgUrl) {
    bgEl.classList.remove('empty');
    bgEl.style.backgroundImage = `url("${te.bgUrl}")`;
  } else {
    bgEl.classList.add('empty');
    bgEl.style.backgroundImage = '';
  }
}

// ─── interact.js bindings ─────────────────────────────────────
function bindComponentInteractions(el, c) {
  const scale = () => getScale();

  // 클릭 시 선택
  el.addEventListener('mousedown', (ev) => {
    if (ev.target.classList.contains('te-del')) return;
    if (ev.target.closest('.te-opacity')) return;
    selectComponent(c.id);
  });

  // 삭제 버튼
  el.querySelector('.te-del').addEventListener('click', (ev) => {
    ev.stopPropagation();
    removeComponent(c.id);
  });

  // 투명도 슬라이더
  const opIn = el.querySelector('.te-opacity input');
  opIn.addEventListener('input', (ev) => {
    ev.stopPropagation();
    const v = parseInt(opIn.value, 10) / 100;
    updateComponent(c.id, { opacity: v });
    el.style.opacity = String(v);
    if (te.selectedId === c.id) renderProps();
  });
  opIn.addEventListener('mousedown', (ev) => ev.stopPropagation());

  if (typeof window.interact !== 'function') return;

  // 드래그 (본체)
  window.interact(el).draggable({
    inertia: false,
    listeners: {
      move(ev) {
        if (ev.target.classList.contains('te-handle')) return;
        const cur = te.components.find((x) => x.id === c.id);
        if (!cur) return;
        const s = scale();
        const nx = cur.x + ev.dx / s;
        const ny = cur.y + ev.dy / s;
        cur.x = Math.round(nx);
        cur.y = Math.round(ny);
        applyComponentTransform(el, cur);
        if (te.selectedId === cur.id) renderProps();
      },
    },
    allowFrom: '.te-comp',
    ignoreFrom: '.te-handle, .te-del, .te-opacity',
  });

  // 리사이즈 (우하단 핸들)
  // ⚠ Text 의 fontSize 스케일링은 drag start 시점의 width/fontSize 기준으로
  //   누적 ratio 를 계산해야 함. 매 move 마다 round 하면 좁힘→넓힘 round-trip 시
  //   fontSize 가 원본으로 정확히 복귀 안 되어 wrap 이 미세하게 남는 버그.
  let _dragStart = null;
  window.interact(el).resizable({
    edges: { right: '.te-handle', bottom: '.te-handle' },
    listeners: {
      start() {
        const cur = te.components.find((x) => x.id === c.id);
        _dragStart = cur ? { width: cur.width, height: cur.height, fontSize: cur.fontSize || 72 } : null;
      },
      end() {
        _dragStart = null;
      },
      move(ev) {
        const cur = te.components.find((x) => x.id === c.id);
        if (!cur) return;
        const s = scale();
        cur.width = Math.max(20, Math.round(cur.width + ev.deltaRect.width / s));
        cur.height = Math.max(10, Math.round(cur.height + ev.deltaRect.height / s));
        // Text 는 폭에 비례해 폰트 크기 함께 스케일.
        // drag start 시점 기준 누적 ratio (per-frame round 누적 X).
        if ((cur.type === 'text' || cur.type === 'nowplaying') && _dragStart && _dragStart.width > 0) {
          const factor = cur.width / _dragStart.width;
          cur.fontSize = Math.max(8, Math.round(_dragStart.fontSize * factor));
        }
        applyComponentTransform(el, cur);
        // 비주얼라이저: AudioMotion 의 canvas 는 컨테이너 크기 따라 자체 ResizeObserver 로 갱신.
        //                재렌더 X — 인스턴스 보존.
        if (cur.type === 'visualizer') {
          applyVisualizerGlow(
            el.querySelector(`[data-vis-am-id="${cur.id}"]`),
            cur
          );
        } else if (cur.type === 'progress' || cur.type === 'image' || cur.type === 'text' || cur.type === 'nowplaying') {
          // 강제 재렌더 — 본체만 교체
          const newInner = document.createElement('div');
          newInner.style.width = '100%'; newInner.style.height = '100%';
          newInner.innerHTML = renderComponentInner(cur);
          [...el.children].forEach((ch) => {
            if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
              ch.remove();
            }
          });
          while (newInner.firstChild) {
            el.insertBefore(newInner.firstChild, el.firstChild);
          }
          applyComponentTransform(el, cur);
        } else if (cur.type === 'playlist') {
          // canvas 픽셀 해상도 갱신 + 재그리기 (HTML 교체 X — canvas 보존).
          renderPlaylistOnCanvas(cur);
          applyComponentTransform(el, cur);
        }
        if (te.selectedId === cur.id) renderProps();
      },
    },
  });
}

// 윈도우 리사이즈 시 컴포넌트 transform 다시 적용 (scale 변경)
window.addEventListener('resize', () => {
  if (!te.initialized) return;
  const inner = $('#teCanvasInner');
  if (!inner) return;
  for (const c of te.components) {
    const el = inner.querySelector(`[data-id="${c.id}"]`);
    if (el) applyComponentTransform(el, c);
  }
});

// ─── State mutators ─────────────────────────────────────────────
function selectComponent(id) {
  te.selectedId = id;
  // 선택 표시만 갱신 (전체 re-render 하면 interact 핸들러 다시 바인딩되어 비싸짐)
  $$('#teCanvasInner .te-comp').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderProps();
}


function updateComponent(id, patch) {
  const idx = te.components.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const prev = te.components[idx];
  // _audioMotion 인스턴스 ref 는 spread 로 보존됨 (own 속성).
  te.components[idx] = { ...prev, ...patch };
  const cur = te.components[idx];
  const el = $(`#teCanvasInner [data-id="${id}"]`);
  if (!el) return;

  if (cur.type === 'visualizer') {
    // visualizer: AudioMotion 인스턴스 유지하고 setOptions 만 호출.
    // 단, 컨테이너 크기/위치/glow 도 transform + glow 함수로 갱신.
    applyComponentTransform(el, cur);
    attachVisualizerInstance(cur);
    return;
  }

  // 비-visualizer — inner 다시 그리기 (control 들 보존)
  [...el.children].forEach((ch) => {
    if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
      ch.remove();
    }
  });
  const inner = document.createElement('div');
  inner.style.width = '100%'; inner.style.height = '100%';
  inner.innerHTML = renderComponentInner(cur);
  while (inner.firstChild) {
    el.insertBefore(inner.firstChild, el.firstChild);
  }
  applyComponentTransform(el, cur);
  if (cur.type === 'playlist') renderPlaylistOnCanvas(cur);
}

function removeComponent(id) {
  const c = te.components.find((x) => x.id === id);
  if (c?.type === 'visualizer') destroyVisualizerInstance(c);
  te.components = te.components.filter((c) => c.id !== id);
  if (te.selectedId === id) te.selectedId = null;
  renderCanvas();
}

function addComponent(type) {
  // NowPlaying 은 한 영상에 1개만
  if (type === 'nowplaying' && hasNowPlaying()) {
    toast('NowPlaying 컴포넌트는 한 영상에 1개만 추가할 수 있습니다', 'info');
    return;
  }
  // Playlist 도 한 영상에 1개만 (NowPlaying 과는 별개 — 둘 다 추가 가능)
  if (type === 'playlist' && hasPlaylist()) {
    toast('Playlist 컴포넌트는 한 영상에 1개만 추가할 수 있습니다', 'info');
    return;
  }
  const c = defaultsFor(type);
  if (type === 'image') {
    // 이미지는 src 가 있어야 의미 있음 — 업로드 dialog 띄우기
    promptImageUpload((url) => {
      c.src = url;
      te.components.push(c);
      te.selectedId = c.id;
      renderCanvas();
    });
    return;
  }
  te.components.push(c);
  te.selectedId = c.id;
  renderCanvas();
  updateAddNowPlayingBtn();
  updateAddPlaylistBtn();
}

function updateAddNowPlayingBtn() {
  const btn = document.getElementById('teAddNowPlayingBtn');
  if (!btn) return;
  const exists = hasNowPlaying();
  btn.disabled = exists;
  btn.title = exists
    ? '한 영상에 1개만 추가 가능 (이미 추가됨)'
    : '곡 제목 자동 표시 (한 영상에 1개)';
}

function updateAddPlaylistBtn() {
  const btn = document.getElementById('teAddPlaylistBtn');
  if (!btn) return;
  const exists = hasPlaylist();
  btn.disabled = exists;
  btn.title = exists
    ? '한 영상에 1개만 추가 가능 (이미 추가됨)'
    : '전체 곡 목록 + 현재 곡 강조 (한 영상에 1개)';
}

// ─── Properties panel ─────────────────────────────────────────
function renderProps() {
  const wrap = $('#teProps');
  if (!wrap) return;
  const c = te.components.find((x) => x.id === te.selectedId);
  if (!c) {
    wrap.classList.add('empty');
    wrap.innerHTML = '컴포넌트를 클릭하면 여기서 속성을 편집합니다.';
    return;
  }
  wrap.classList.remove('empty');
  let typeFields = '';
  if (c.type === 'text') {
    const slider = (key, label, min, max, step, val, suffix = '') => `
      <div class="slider-row">
        <label>${label}</label>
        <input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${val}" />
        <span class="val" data-val-for="${key}">${val}${suffix}</span>
      </div>
    `;
    typeFields = `
      <div class="te-prop full">
        <label>Content (변수: {{trackTitle}}, {{trackNumber}}, {{totalTracks}})</label>
        <textarea data-prop="content" rows="3" style="resize:vertical;font-family:inherit;">${escapeHtml(c.content || '')}</textarea>
      </div>
      <div class="te-prop"><label>Font Size</label><input type="number" data-prop="fontSize" value="${c.fontSize || 72}" min="8" max="500" /></div>
      <div class="te-prop"><label>Font Family</label>
        <select data-prop="fontFamily">
          <option ${c.fontFamily?.startsWith('Playfair') ? 'selected' : ''} value="Playfair Display, serif">Playfair Display</option>
          <option ${c.fontFamily?.startsWith('Inter') ? 'selected' : ''} value="Inter, sans-serif">Inter</option>
          <option ${c.fontFamily?.startsWith('Georgia') ? 'selected' : ''} value="Georgia, serif">Georgia</option>
          <option ${c.fontFamily?.startsWith('Cinzel') ? 'selected' : ''} value="Cinzel, serif">Cinzel</option>
          <option ${c.fontFamily?.includes('monospace') ? 'selected' : ''} value="SF Mono, Menlo, monospace">Mono</option>
        </select>
      </div>
      <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#FFFFFF'}" /></div>
      <div class="te-prop">
        <label>Style</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.bold ? 'active' : ''}" data-toggle="bold" style="font-weight:700;">B</button>
          <button type="button" class="te-toggle-btn ${c.italic ? 'active' : ''}" data-toggle="italic" style="font-style:italic;">I</button>
          <button type="button" class="te-toggle-btn ${c.underline ? 'active' : ''}" data-toggle="underline" style="text-decoration:underline;">U</button>
          <button type="button" class="te-toggle-btn ${c.strikethrough ? 'active' : ''}" data-toggle="strikethrough" style="text-decoration:line-through;">S</button>
        </div>
      </div>
      <div class="te-prop">
        <label>Align</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.textAlign === 'left' ? 'active' : ''}" data-align="left">≡ L</button>
          <button type="button" class="te-toggle-btn ${(!c.textAlign || c.textAlign === 'center') ? 'active' : ''}" data-align="center">≡ C</button>
          <button type="button" class="te-toggle-btn ${c.textAlign === 'right' ? 'active' : ''}" data-align="right">≡ R</button>
        </div>
      </div>
      <div class="te-prop">
        <label>Transform</label>
        <select data-prop="textTransform">
          <option value="none" ${(!c.textTransform || c.textTransform === 'none') ? 'selected' : ''}>None</option>
          <option value="uppercase" ${c.textTransform === 'uppercase' ? 'selected' : ''}>UPPER</option>
          <option value="lowercase" ${c.textTransform === 'lowercase' ? 'selected' : ''}>lower</option>
          <option value="capitalize" ${c.textTransform === 'capitalize' ? 'selected' : ''}>Capitalize</option>
        </select>
      </div>
      <div class="te-prop">
        <label>Auto Wrap</label>
        <label class="vocal-check" style="font-size:12px; cursor:pointer;">
          <input type="checkbox" data-prop-bool="autoWrap" ${c.autoWrap !== false ? 'checked' : ''} />
          박스 폭 넘으면 자동 줄바꿈
        </label>
      </div>
      ${slider('letterSpacing', 'Letter Spacing', -5, 20, 0.5, c.letterSpacing ?? 0, 'px')}
      ${slider('lineHeight', 'Line Height', 0.8, 3.0, 0.05, c.lineHeight ?? 1.2, '')}
      ${slider('glowIntensity', 'Glow', 0, 2, 0.05, c.glowIntensity ?? 1.0, '')}
      ${isDarkColor(c.color) ? `<div class="te-prop-warn">⚠ 어두운 텍스트 컬러 — 그림자 자동 비활성. 밝은 색을 권장합니다.</div>` : ''}
    `;
  } else if (c.type === 'image') {
    typeFields = `
      <div class="te-prop" style="grid-column: 1 / -1;">
        <label>이미지 URL</label>
        <input type="text" data-prop="src" value="${escapeHtml(c.src || '')}" />
      </div>
      <div class="te-prop">
        <label>Fit</label>
        <select data-prop="fit">
          <option value="contain" ${c.fit === 'contain' ? 'selected' : ''}>Contain</option>
          <option value="cover" ${c.fit === 'cover' ? 'selected' : ''}>Cover</option>
          <option value="fill" ${c.fit === 'fill' ? 'selected' : ''}>Fill</option>
        </select>
      </div>
      <div class="te-prop">
        <label>&nbsp;</label>
        <button class="te-btn" id="teReuploadImg" type="button">📂 재업로드</button>
      </div>
    `;
  } else if (c.type === 'visualizer') {
    const slider = (key, label, min, max, step, val, suffix = '') => `
      <div class="slider-row">
        <label>${label}</label>
        <input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${val}" />
        <span class="val" data-val-for="${key}">${val}${suffix}</span>
      </div>
    `;
    const stops = Array.isArray(c.gradientStops) && c.gradientStops.length
      ? c.gradientStops
      : [{ position: 0, color: '#FFFFFF' }, { position: 100, color: '#D4AF37' }];
    const colorBlock = c.colorMode === 'gradient'
      ? `
        <div class="te-prop full">
          <div class="te-radio-row" style="margin-bottom:6px;">
            <label><input type="radio" name="vmcolor" data-mode="solid" /> Solid</label>
            <label><input type="radio" name="vmcolor" data-mode="gradient" checked /> Gradient</label>
          </div>
          <div class="te-gradient-preview" style="background:${gradientCss(stops)};"></div>
          <div id="teGradientStops">
            ${stops.map((s, i) => `
              <div class="te-stop-row" data-stop-idx="${i}">
                <input type="number" min="0" max="100" step="1" value="${s.position}" data-stop-pos />
                <input type="color" value="${s.color}" data-stop-color />
                <span class="stop-text">${s.color.toUpperCase()} @ ${s.position}%</span>
                <button type="button" class="te-btn danger" data-stop-del title="삭제">✕</button>
              </div>
            `).join('')}
          </div>
          <button type="button" class="te-btn" id="teGradientAddBtn" style="margin-top:4px;">+ Add Stop</button>
        </div>
      `
      : `
        <div class="te-prop">
          <label>Color Mode</label>
          <div class="te-radio-row">
            <label><input type="radio" name="vmcolor" data-mode="solid" checked /> Solid</label>
            <label><input type="radio" name="vmcolor" data-mode="gradient" /> Gradient</label>
          </div>
        </div>
        <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#D4AF37'}" /></div>
      `;
    const modeOpts = [
      [0, 'Discrete frequencies'],
      [1, '1/24 octave (240 bands)'],
      [2, '1/12 octave (120 bands)'],
      [3, '1/8 octave (80 bands) ← default'],
      [4, '1/6 octave (60 bands)'],
      [5, '1/4 octave (40 bands)'],
      [6, '1/3 octave (30 bands)'],
      [7, '1/2 octave (20 bands)'],
      [8, 'Full octave (10 bands)'],
      [10, 'Line / Area graph'],
    ];
    const gradientOpts = ['classic','prism','rainbow','orangered','steelblue'];
    const freqScales = ['log','linear','bark','mel'];
    const weightingFilters = ['','A','B','C','D','468'];
    const channelLayouts = ['single','dual-horizontal','dual-vertical','dual-combined'];
    const checkbox = (key, label, val) => `
      <div class="te-prop">
        <label class="vocal-check" style="font-size:12px;cursor:pointer;">
          <input type="checkbox" data-prop-bool="${key}" ${val ? 'checked' : ''} />
          ${label}
        </label>
      </div>
    `;
    typeFields = `
      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 디스플레이 —</label>
      </div>
      <div class="te-prop">
        <label>Mode</label>
        <select data-prop="mode" data-coerce="int">
          ${modeOpts.map(([v, lab]) => `<option value="${v}" ${(c.mode ?? 3) === v ? 'selected' : ''}>${v}: ${lab}</option>`).join('')}
        </select>
      </div>
      <div class="te-prop">
        <label>Gradient</label>
        <select data-prop="gradient">
          ${gradientOpts.map((g) => `<option value="${g}" ${(c.gradient ?? 'rainbow') === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </div>
      <div class="te-prop">
        <label>Mirror</label>
        <select data-prop="mirror" data-coerce="int">
          <option value="-1" ${(c.mirror ?? 0) === -1 ? 'selected' : ''}>← Left</option>
          <option value="0"  ${(c.mirror ?? 0) === 0 ? 'selected' : ''}>none</option>
          <option value="1"  ${(c.mirror ?? 0) === 1 ? 'selected' : ''}>Right →</option>
        </select>
      </div>
      <div class="te-prop">
        <label>Channel Layout</label>
        <select data-prop="channelLayout">
          ${channelLayouts.map((l) => `<option value="${l}" ${(c.channelLayout || 'single') === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${checkbox('radial', '⭕ Radial', c.radial)}
      ${checkbox('showPeaks', '🔝 Show Peaks', c.showPeaks ?? true)}
      ${checkbox('ledBars', '💡 LED Bars', c.ledBars)}
      ${checkbox('lumiBars', '✨ Lumi Bars', c.lumiBars)}
      ${checkbox('alphaBars', '🌫 Alpha Bars', c.alphaBars)}
      ${checkbox('outlineBars', '⬜ Outline Bars', c.outlineBars)}
      ${checkbox('roundBars', '⚪ Round Bars', c.roundBars)}
      ${slider('reflexRatio', 'Reflex Ratio', 0, 1, 0.01, c.reflexRatio ?? 0, '')}
      ${slider('reflexAlpha', 'Reflex Alpha', 0, 1, 0.01, c.reflexAlpha ?? 1, '')}

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 주파수 —</label>
      </div>
      ${slider('minFreq', 'Min Freq (Hz)', 20, 500, 1, c.minFreq ?? 30, 'Hz')}
      ${slider('maxFreq', 'Max Freq (Hz)', 5000, 22000, 100, c.maxFreq ?? 20000, 'Hz')}
      <div class="te-prop">
        <label>Frequency Scale</label>
        <select data-prop="frequencyScale">
          ${freqScales.map((s) => `<option value="${s}" ${(c.frequencyScale || 'log') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 감도 —</label>
      </div>
      ${slider('minDecibels', 'Min dB', -120, -60, 1, c.minDecibels ?? -85, 'dB')}
      ${slider('maxDecibels', 'Max dB', -50, 0, 1, c.maxDecibels ?? -25, 'dB')}
      ${slider('smoothing', 'Smoothing', 0, 1, 0.01, c.smoothing ?? 0.5, '')}
      <div class="te-prop">
        <label>Weighting Filter</label>
        <select data-prop="weightingFilter">
          ${weightingFilters.map((w) => `<option value="${w}" ${(c.weightingFilter ?? 'D') === w ? 'selected' : ''}>${w || '(none)'}</option>`).join('')}
        </select>
      </div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 디자인 —</label>
      </div>
      ${colorBlock}
      ${slider('glow', 'Glow', 0, 80, 1, c.glow ?? 20, 'px')}

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--text-muted);font-size:10px;">⚠ verticalMode/splitGap 은 카드 썸네일 정적 표시용 (실시간 비주얼라이저는 AudioMotion 옵션 사용)</label>
      </div>
      <div class="te-prop">
        <label>Card Mode</label>
        <select data-prop="verticalMode">
          <option value="symmetric" ${c.verticalMode === 'symmetric' ? 'selected' : ''}>↕ Symmetric</option>
          <option value="up" ${c.verticalMode === 'up' ? 'selected' : ''}>↑ Up only</option>
          <option value="down" ${c.verticalMode === 'down' ? 'selected' : ''}>↓ Down only</option>
        </select>
      </div>
      ${slider('splitGap', 'Card Split Gap', 0, 200, 1, c.splitGap ?? 0, 'px')}
    `;
  } else if (c.type === 'progress') {
    typeFields = `
      <div class="te-prop"><label>Style</label>
        <select data-prop="style">
          <option value="melody" selected>Melody</option>
        </select>
      </div>
      <div class="te-prop"><label>BG Color</label><input type="text" data-prop="bgColor" value="${escapeHtml(c.bgColor || 'rgba(255,255,255,0.1)')}" /></div>
      <div class="te-prop"><label>Fill Color</label><input type="color" data-prop="fillColor" value="${c.fillColor || '#D4AF37'}" /></div>
    `;
  } else if (c.type === 'nowplaying') {
    const slider = (key, label, min, max, step, val, suffix = '') => `
      <div class="slider-row">
        <label>${label}</label>
        <input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${val}" />
        <span class="val" data-val-for="${key}">${val}${suffix}</span>
      </div>
    `;
    typeFields = `
      <div class="te-prop full" style="background:var(--bg-input);padding:8px;border-radius:4px;border-left:3px solid var(--jazz-gold);">
        <div style="font-size:10px;color:var(--jazz-gold);font-weight:700;margin-bottom:4px;">📺 NOW PLAYING — 자동 표시</div>
        <div style="font-size:10px;color:var(--text-muted);line-height:1.5;">곡 바뀔 때마다 자동으로 곡 제목 갱신 + 애니메이션. 한 영상에 1개만.</div>
      </div>

      <div class="te-prop full">
        <label>미리보기 텍스트 (Editor 만)</label>
        <input type="text" data-prop="previewText" value="${escapeHtml(c.previewText || 'Sample Track Title')}" />
      </div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 텍스트 —</label>
      </div>
      <div class="te-prop"><label>Font Family</label>
        <select data-prop="fontFamily">
          <option ${c.fontFamily === 'system-ui, sans-serif' ? 'selected' : ''} value="system-ui, sans-serif">System</option>
          <option ${c.fontFamily?.startsWith('Playfair') ? 'selected' : ''} value="Playfair Display, serif">Playfair Display</option>
          <option ${c.fontFamily?.startsWith('Inter') ? 'selected' : ''} value="Inter, sans-serif">Inter</option>
          <option ${c.fontFamily?.startsWith('Georgia') ? 'selected' : ''} value="Georgia, serif">Georgia</option>
          <option ${c.fontFamily?.startsWith('Cinzel') ? 'selected' : ''} value="Cinzel, serif">Cinzel</option>
          <option ${c.fontFamily?.includes('monospace') ? 'selected' : ''} value="SF Mono, Menlo, monospace">Mono</option>
        </select>
      </div>
      <div class="te-prop"><label>Font Size</label><input type="number" data-prop="fontSize" value="${c.fontSize || 48}" min="8" max="200" /></div>
      <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#FFFFFF'}" /></div>
      <div class="te-prop">
        <label>Style</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.bold ? 'active' : ''}" data-toggle="bold" style="font-weight:700;">B</button>
          <button type="button" class="te-toggle-btn ${c.italic ? 'active' : ''}" data-toggle="italic" style="font-style:italic;">I</button>
          <button type="button" class="te-toggle-btn ${c.underline ? 'active' : ''}" data-toggle="underline" style="text-decoration:underline;">U</button>
        </div>
      </div>
      <div class="te-prop">
        <label>Align</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.textAlign === 'left' ? 'active' : ''}" data-align="left">≡ L</button>
          <button type="button" class="te-toggle-btn ${(!c.textAlign || c.textAlign === 'center') ? 'active' : ''}" data-align="center">≡ C</button>
          <button type="button" class="te-toggle-btn ${c.textAlign === 'right' ? 'active' : ''}" data-align="right">≡ R</button>
        </div>
      </div>
      <div class="te-prop">
        <label>Transform</label>
        <select data-prop="textTransform">
          <option value="none" ${(!c.textTransform || c.textTransform === 'none') ? 'selected' : ''}>None</option>
          <option value="uppercase" ${c.textTransform === 'uppercase' ? 'selected' : ''}>UPPER</option>
          <option value="lowercase" ${c.textTransform === 'lowercase' ? 'selected' : ''}>lower</option>
          <option value="capitalize" ${c.textTransform === 'capitalize' ? 'selected' : ''}>Capitalize</option>
        </select>
      </div>
      ${slider('letterSpacing', 'Letter Spacing', -5, 20, 0.5, c.letterSpacing ?? 0, 'px')}

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— Glow —</label>
      </div>
      ${slider('glow', 'Glow', 0, 80, 1, c.glow ?? 20, 'px')}
      <div class="te-prop"><label>Glow Color</label><input type="color" data-prop="glowColor" value="${c.glowColor || '#D4AF37'}" /></div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 애니메이션 —</label>
      </div>
      <div class="te-prop full">
        <label>종류</label>
        <select data-prop="animation">
          <option value="fade" ${c.animation === 'fade' ? 'selected' : ''}>Fade</option>
          <option value="slide" ${c.animation === 'slide' ? 'selected' : ''}>Slide (위로)</option>
          <option value="typewriter" ${c.animation === 'typewriter' ? 'selected' : ''}>Typewriter</option>
          <option value="glow" ${c.animation === 'glow' ? 'selected' : ''}>Glow Pulse</option>
          <option value="blur" ${c.animation === 'blur' ? 'selected' : ''}>Blur Reveal</option>
        </select>
      </div>
      ${slider('animationDurationMs', 'Duration', 200, 2000, 50, c.animationDurationMs ?? 800, 'ms')}
      ${slider('fadeOutMs', 'Fade Out', 0, 1500, 50, c.fadeOutMs ?? 500, 'ms')}

      <div class="te-prop full" style="margin-top:8px;">
        <button type="button" id="teNpPreviewBtn" class="te-btn gold" style="width:100%;height:36px;">▶ 애니메이션 미리보기</button>
      </div>
    `;
  } else if (c.type === 'playlist') {
    const slider = (key, label, min, max, step, val, suffix = '') => `
      <div class="slider-row">
        <label>${label}</label>
        <input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${val}" />
        <span class="val" data-val-for="${key}">${val}${suffix}</span>
      </div>
    `;
    const previewMax = Math.max(0, (c.previewTracks?.length || 1) - 1);
    const previewIdx = Math.min(c.previewCurrentIdx ?? 0, previewMax);
    const previewTracksText = (c.previewTracks || []).join('\n');
    typeFields = `
      <div class="te-prop full" style="background:var(--bg-input);padding:8px;border-radius:4px;border-left:3px solid var(--jazz-gold);">
        <div style="font-size:10px;color:var(--jazz-gold);font-weight:700;margin-bottom:4px;">📋 PLAYLIST — 자동 표시</div>
        <div style="font-size:10px;color:var(--text-muted);line-height:1.5;">전체 곡 목록 자동 채움 + 현재 곡 강조. 한 영상에 1개만.</div>
      </div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 레이아웃 —</label>
      </div>
      <div class="te-prop full">
        <label>Layout</label>
        <select data-prop="layout">
          <option value="numbered" ${c.layout === 'numbered' ? 'selected' : ''}>Numbered (1. Track)</option>
          <option value="dot" ${c.layout === 'dot' ? 'selected' : ''}>Dot (Track · Track)</option>
          <option value="slash" ${(!c.layout || c.layout === 'slash') ? 'selected' : ''}>Slash (Track | Track)</option>
          <option value="box" ${c.layout === 'box' ? 'selected' : ''}>Box (current centered)</option>
          <option value="timecode" ${c.layout === 'timecode' ? 'selected' : ''}>Timecode (00:00 - Track)</option>
        </select>
      </div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 텍스트 —</label>
      </div>
      <div class="te-prop"><label>Font Family</label>
        <select data-prop="fontFamily">
          <option ${c.fontFamily === 'system-ui, sans-serif' ? 'selected' : ''} value="system-ui, sans-serif">System</option>
          <option ${c.fontFamily?.startsWith('Playfair') ? 'selected' : ''} value="Playfair Display, serif">Playfair Display</option>
          <option ${c.fontFamily?.startsWith('Inter') ? 'selected' : ''} value="Inter, sans-serif">Inter</option>
          <option ${c.fontFamily?.startsWith('Georgia') ? 'selected' : ''} value="Georgia, serif">Georgia</option>
          <option ${c.fontFamily?.startsWith('Cinzel') ? 'selected' : ''} value="Cinzel, serif">Cinzel</option>
          <option ${c.fontFamily?.includes('monospace') ? 'selected' : ''} value="SF Mono, Menlo, monospace">Mono</option>
        </select>
      </div>
      <div class="te-prop"><label>Font Size</label><input type="number" data-prop="fontSize" value="${c.fontSize || 28}" min="10" max="120" /></div>
      <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#FFFFFF'}" /></div>
      <div class="te-prop">
        <label>Style</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.bold ? 'active' : ''}" data-toggle="bold" style="font-weight:700;">B</button>
          <button type="button" class="te-toggle-btn ${c.italic ? 'active' : ''}" data-toggle="italic" style="font-style:italic;">I</button>
        </div>
      </div>
      <div class="te-prop">
        <label>Align</label>
        <div class="te-toggle-group">
          <button type="button" class="te-toggle-btn ${c.textAlign === 'left' ? 'active' : ''}" data-align="left">≡ L</button>
          <button type="button" class="te-toggle-btn ${(!c.textAlign || c.textAlign === 'center') ? 'active' : ''}" data-align="center">≡ C</button>
          <button type="button" class="te-toggle-btn ${c.textAlign === 'right' ? 'active' : ''}" data-align="right">≡ R</button>
        </div>
      </div>
      ${slider('letterSpacing', 'Letter Spacing', -5, 20, 0.5, c.letterSpacing ?? 0, 'px')}
      ${slider('lineHeight', 'Line Height', 1.0, 2.5, 0.05, c.lineHeight ?? 1.5, '')}

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— Glow —</label>
      </div>
      ${slider('glow', 'Glow', 0, 50, 1, c.glow ?? 10, 'px')}
      <div class="te-prop"><label>Glow Color</label><input type="color" data-prop="glowColor" value="${c.glowColor || '#D4AF37'}" /></div>

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 현재 곡 강조 —</label>
      </div>
      <div class="te-prop full">
        <label class="vocal-check" style="font-size:12px;">
          <input type="checkbox" data-prop-bool="highlightEnabled" ${c.highlightEnabled !== false ? 'checked' : ''} />
          Enable Highlight (현재 재생곡 강조)
        </label>
      </div>
      ${c.highlightEnabled !== false ? `
        <div class="te-prop"><label>HL Color</label><input type="color" data-prop="highlightColor" value="${c.highlightColor || '#D4AF37'}" /></div>
        <div class="te-prop">
          <label>HL Style</label>
          <div class="te-toggle-group">
            <button type="button" class="te-toggle-btn ${c.highlightBold ? 'active' : ''}" data-toggle="highlightBold" style="font-weight:700;">B</button>
            <button type="button" class="te-toggle-btn ${c.highlightItalic ? 'active' : ''}" data-toggle="highlightItalic" style="font-style:italic;">I</button>
            <button type="button" class="te-toggle-btn ${c.highlightUnderline ? 'active' : ''}" data-toggle="highlightUnderline" style="text-decoration:underline;">U</button>
          </div>
        </div>
        <div class="te-prop full">
          <label class="vocal-check" style="font-size:12px;">
            <input type="checkbox" id="teHlFontSizeEnable" ${c.highlightFontSize ? 'checked' : ''} />
            Override Font Size
          </label>
        </div>
        ${c.highlightFontSize ? `
          <div class="te-prop"><label>HL Size</label><input type="number" data-prop="highlightFontSize" value="${c.highlightFontSize}" min="10" max="200" /></div>
        ` : ''}
      ` : ''}

      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 미리보기 —</label>
      </div>
      <div class="te-prop full">
        <label>Preview Tracks (한 줄에 1곡)</label>
        <textarea id="tePlaylistPreviewTracks" rows="6" style="width:100%;font-family:inherit;font-size:12px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:6px;border-radius:4px;">${escapeHtml(previewTracksText)}</textarea>
      </div>
      ${slider('previewCurrentIdx', 'Preview Current', 0, previewMax, 1, previewIdx, '')}
    `;
  }

  wrap.innerHTML = `
    <h3>${c.type.toUpperCase()} ${c.id.slice(-6)}</h3>
    <div class="te-prop-grid">
      <div class="te-prop"><label>X</label><input type="number" data-prop="x" value="${Math.round(c.x)}" /></div>
      <div class="te-prop"><label>Y</label><input type="number" data-prop="y" value="${Math.round(c.y)}" /></div>
      <div class="te-prop"><label>Width</label><input type="number" data-prop="width" value="${Math.round(c.width)}" /></div>
      <div class="te-prop"><label>Height</label><input type="number" data-prop="height" value="${Math.round(c.height)}" /></div>
      <div class="te-prop"><label>Opacity</label><input type="number" step="0.05" data-prop="opacity" value="${(c.opacity ?? 1).toFixed(2)}" min="0" max="1" /></div>
      ${typeFields}
    </div>
  `;
  // 핸들러
  wrap.querySelectorAll('[data-prop]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const prop = inp.dataset.prop;
      let val = inp.value;
      const numericInput = inp.type === 'number' || inp.type === 'range';
      if (numericInput) val = parseFloat(val);
      else if (inp.dataset.coerce === 'int') val = parseInt(val, 10);
      else if (inp.dataset.coerce === 'float') val = parseFloat(val);
      if ((numericInput || inp.dataset.coerce) && Number.isNaN(val)) return;
      // 슬라이더 값 표시 갱신
      const valEl = wrap.querySelector(`[data-val-for="${prop}"]`);
      if (valEl) {
        const suffix = valEl.textContent.replace(/^[\d.\-]+/, '') || '';
        valEl.textContent = `${val}${suffix}`;
      }
      updateComponent(c.id, { [prop]: val });
    });
  });
  // Boolean 체크박스 (Auto Wrap 등)
  wrap.querySelectorAll('[data-prop-bool]').forEach((inp) => {
    inp.addEventListener('change', () => {
      updateComponent(c.id, { [inp.dataset.propBool]: inp.checked });
      // highlightEnabled 토글 시 강조 sub-옵션 show/hide 위해 props 다시 그리기.
      if (inp.dataset.propBool === 'highlightEnabled') renderProps();
    });
  });

  // Playlist — Preview Tracks textarea (각 줄 = 1 곡)
  const pTracksEl = wrap.querySelector('#tePlaylistPreviewTracks');
  if (pTracksEl && c.type === 'playlist') {
    pTracksEl.addEventListener('input', () => {
      const arr = pTracksEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      // previewCurrentIdx 가 새 길이를 초과하면 보정
      const maxIdx = Math.max(0, arr.length - 1);
      const newIdx = Math.min(cur.previewCurrentIdx ?? 0, maxIdx);
      updateComponent(cur.id, { previewTracks: arr, previewCurrentIdx: newIdx });
    });
    // textarea 안에서는 props 다시 그리지 않음 — 커서 위치 유지 위해.
    // 단, 길이가 줄어 슬라이더 max 가 갱신되어야 할 때는 어쩔 수 없이 재렌더 필요 →
    // change (blur) 시 재렌더.
    pTracksEl.addEventListener('change', () => {
      renderProps();
    });
  }

  // Playlist — HL Font Size override 체크박스
  const hlSizeEnable = wrap.querySelector('#teHlFontSizeEnable');
  if (hlSizeEnable && c.type === 'playlist') {
    hlSizeEnable.addEventListener('change', () => {
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      const next = hlSizeEnable.checked ? Math.round((cur.fontSize || 28) * 1.3) : null;
      updateComponent(cur.id, { highlightFontSize: next });
      renderProps();
    });
  }
  // 이미지 재업로드 버튼
  const reup = wrap.querySelector('#teReuploadImg');
  if (reup) {
    reup.addEventListener('click', () => {
      promptImageUpload((url) => {
        updateComponent(c.id, { src: url });
        renderProps();
      });
    });
  }

  // Text — Bold / Italic / Underline / Strikethrough 토글
  wrap.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      updateComponent(cur.id, { [key]: !cur[key] });
      renderProps();
    });
  });
  // Text — Align 토글
  wrap.querySelectorAll('[data-align]').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateComponent(c.id, { textAlign: btn.dataset.align });
      renderProps();
    });
  });

  // Visualizer — Color Mode 라디오
  wrap.querySelectorAll('input[name="vmcolor"][data-mode]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      const mode = r.dataset.mode;
      const patch = { colorMode: mode };
      // gradient 로 첫 전환 시 기본 stops 보장
      if (mode === 'gradient' && (!cur.gradientStops || cur.gradientStops.length < 2)) {
        patch.gradientStops = [
          { position: 0, color: '#FFFFFF' },
          { position: 50, color: cur.color || '#D4AF37' },
          { position: 100, color: '#A04000' },
        ];
      }
      updateComponent(cur.id, patch);
      renderProps();
    });
  });

  // Visualizer — Gradient stop 편집
  wrap.querySelectorAll('.te-stop-row').forEach((row) => {
    const idx = parseInt(row.dataset.stopIdx, 10);
    const posIn = row.querySelector('[data-stop-pos]');
    const colIn = row.querySelector('[data-stop-color]');
    const delBtn = row.querySelector('[data-stop-del]');
    const updateStop = (patch) => {
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      const stops = [...(cur.gradientStops || [])];
      if (idx < 0 || idx >= stops.length) return;
      stops[idx] = { ...stops[idx], ...patch };
      updateComponent(cur.id, { gradientStops: stops });
      renderProps();
    };
    posIn?.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, parseInt(posIn.value, 10) || 0));
      updateStop({ position: v });
    });
    colIn?.addEventListener('input', () => updateStop({ color: colIn.value }));
    delBtn?.addEventListener('click', () => {
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      const stops = [...(cur.gradientStops || [])];
      if (stops.length <= 2) {
        toast('Gradient stop 은 최소 2개는 유지해야 합니다', 'info');
        return;
      }
      stops.splice(idx, 1);
      updateComponent(cur.id, { gradientStops: stops });
      renderProps();
    });
  });

  // Visualizer — Add Stop
  const addStopBtn = wrap.querySelector('#teGradientAddBtn');
  if (addStopBtn) {
    addStopBtn.addEventListener('click', () => {
      const cur = te.components.find((x) => x.id === c.id);
      if (!cur) return;
      const stops = [...(cur.gradientStops || [])].sort((a, b) => a.position - b.position);
      // 가장 큰 gap 의 가운데에 새 stop 삽입
      let bestGap = 0, bestPos = 50, bestColor = '#FFFFFF';
      for (let i = 0; i < stops.length - 1; i++) {
        const gap = stops[i + 1].position - stops[i].position;
        if (gap > bestGap) {
          bestGap = gap;
          bestPos = Math.round((stops[i].position + stops[i + 1].position) / 2);
          // 두 색의 중간
          const c1 = hexToRgb(stops[i].color), c2 = hexToRgb(stops[i + 1].color);
          const r = Math.round((c1.r + c2.r) / 2);
          const g = Math.round((c1.g + c2.g) / 2);
          const b = Math.round((c1.b + c2.b) / 2);
          bestColor = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        }
      }
      stops.push({ position: bestPos, color: bestColor });
      updateComponent(cur.id, { gradientStops: stops });
      renderProps();
    });
  }

  // NowPlaying — 미리보기 버튼
  const npBtn = wrap.querySelector('#teNpPreviewBtn');
  if (npBtn && c.type === 'nowplaying') {
    npBtn.addEventListener('click', () => playNowPlayingPreview(c.id));
  }
}

// NowPlaying 미리보기 — 캔버스 위에 임시 overlay div 띄워 애니메이션 1회 시연.
const _npPreviewState = new Map();   // compId → { ctrl, rafId, host }
function playNowPlayingPreview(compId) {
  const cur = te.components.find((x) => x.id === compId);
  if (!cur) return;
  // 기존 RAF 정지
  const prev = _npPreviewState.get(compId);
  if (prev?.rafId) cancelAnimationFrame(prev.rafId);
  if (prev?.host) prev.host.remove();

  // 컴포넌트 인너의 div 자체를 사용 — 임시로 inline style 갱신해 애니메이션
  const compEl = document.querySelector(`#teCanvasInner [data-id="${compId}"] [data-np-id="${compId}"]`);
  if (!compEl) return;

  const ctrl = createNPController(cur);
  ctrl.startIn(cur.previewText || 'Sample Track Title');

  const tick = () => {
    const state = ctrl.stateAt();
    applyNPState(compEl, state, cur);
    if (ctrl.phase === 'in') {
      const rafId = requestAnimationFrame(tick);
      _npPreviewState.set(compId, { ctrl, rafId, host: null });
    } else {
      // hold — 끝까지 표시. 추가 RAF 불필요.
      _npPreviewState.set(compId, { ctrl, rafId: null, host: null });
    }
  };
  tick();
}

// ─── Background upload ────────────────────────────────────────
$('#teBgUploadBtn')?.addEventListener('click', () => $('#teBgFile').click());
$('#teBgFile')?.addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  $('#teBgStatus').textContent = `업로드 중: ${f.name}…`;
  try {
    const fd = new FormData();
    fd.append('file', f, f.name);
    const res = await fetch('/api/templates/upload-background', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    te.bgUrl = j.url;
    $('#teBgStatus').textContent = `${f.name} (${(j.bytes / 1024).toFixed(0)} KB)`;
    renderBg();
    toast('배경 업로드 완료', 'success');
  } catch (e) {
    $('#teBgStatus').textContent = `(실패: ${e.message})`;
    toast(`배경 업로드 실패: ${e.message}`, 'error');
  }
});
$('#teBgClearBtn')?.addEventListener('click', () => {
  te.bgUrl = null;
  $('#teBgStatus').textContent = '(배경 없음)';
  renderBg();
});

// ─── Image upload (컴포넌트 src) ─────────────────────────────
function promptImageUpload(onUrl) {
  // 임시 input file 띄우기 → 같은 endpoint 재사용 (이미지면 원본 그대로 저장됨)
  const f = document.createElement('input');
  f.type = 'file';
  f.accept = 'image/*';
  f.style.display = 'none';
  document.body.appendChild(f);
  f.addEventListener('change', async () => {
    const file = f.files?.[0];
    if (!file) { f.remove(); return; }
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/templates/upload-background', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onUrl(j.url);
      toast('이미지 업로드 완료', 'success');
    } catch (e) {
      toast(`이미지 업로드 실패: ${e.message}`, 'error');
    } finally {
      f.remove();
    }
  });
  f.click();
}

// ─── Component add buttons ────────────────────────────────────
$$('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => addComponent(btn.dataset.add));
});

// ─── Save flow ────────────────────────────────────────────────
$('#teSaveBtn')?.addEventListener('click', async () => {
  const name = $('#teSaveName').value.trim();
  if (!name) {
    toast('템플릿 이름을 입력하세요', 'error');
    $('#teSaveName').focus();
    return;
  }
  if (!te.components.length && !te.bgUrl) {
    if (!confirm('컴포넌트도 배경도 없습니다. 그래도 빈 템플릿을 저장할까요?')) return;
  }
  const isFav = $('#teSaveFav').checked;
  const config_json = {
    canvas: { width: CANVAS_W, height: CANVAS_H },
    components: te.components.map((c) => ({ ...c })), // 깊은 복사 X (단순 객체)
  };
  try {
    const j = await apiPost('/api/templates', {
      name,
      description: te.editingTemplate ? `Based on ${te.editingTemplate.name}` : null,
      is_default: false,
      is_favorite: isFav,
      background_image_url: te.bgUrl,
      config_json,
    });
    toast(`저장 완료: ${j.template.name}`, 'success');
    $('#teSaveName').value = '';
    $('#teSaveFav').checked = false;
    await refreshTemplateList();
  } catch (e) {
    toast(`저장 실패: ${e.message}`, 'error');
  }
});

// ─── Template list (좌측) ─────────────────────────────────────
async function refreshTemplateList() {
  try {
    const j = await apiGet('/api/templates');
    te.templates = j.templates || [];
    renderTemplateList();
  } catch (e) {
    toast(`템플릿 로드 실패: ${e.message}`, 'error');
  }
}

// ─── 갤러리 / 리스트 모드 ────────────────────────────────────
const VIEW_MODE_KEY = 'pjl.te.viewMode';
const BG_MODE_KEY = 'pjl.te.galleryBgMode';

const gallery = {
  mode: localStorage.getItem(VIEW_MODE_KEY) || 'list',
  bgMode: localStorage.getItem(BG_MODE_KEY) || 'image',  // 'image' | 'dark' | 'light'
  imgCache: new Map(),       // url → { img: Image, ready: bool }
  observer: null,            // IntersectionObserver — 화면 진입 시점에만 카드 그리기
  drawnTids: new Set(),      // 이미 그린 카드 id (캐싱)
};

function applyModeToggleUI() {
  const wrap = $('#teModeToggle');
  if (wrap) {
    wrap.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === gallery.mode);
    });
  }
  // 배경 토글은 갤러리 모드에서만 표시
  const bgWrap = $('#teGalleryBgToggle');
  if (bgWrap) {
    bgWrap.hidden = gallery.mode !== 'gallery';
    bgWrap.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.bgmode === gallery.bgMode);
    });
  }
}

function bindModeToggle() {
  $('#teModeToggle')?.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      gallery.mode = b.dataset.mode;
      localStorage.setItem(VIEW_MODE_KEY, gallery.mode);
      applyModeToggleUI();
      renderTemplateList();
    });
  });
  $('#teGalleryBgToggle')?.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      gallery.bgMode = b.dataset.bgmode;
      localStorage.setItem(BG_MODE_KEY, gallery.bgMode);
      applyModeToggleUI();
      // 모든 카드 썸네일 재드로우 (캐시 무효화)
      gallery.drawnTids.clear();
      renderTemplateList();
    });
  });
}

function renderTemplateList() {
  applyModeToggleUI();
  if (gallery.mode === 'gallery') {
    renderTemplateGallery();
    return;
  }
  // 리스트 모드 (기존)
  const ul = $('#teList');
  if (!ul) return;
  // observer 정리 — 리스트 모드에선 lazy load 불필요
  if (gallery.observer) { gallery.observer.disconnect(); gallery.observer = null; }
  gallery.drawnTids.clear();

  ul.className = 'te-list';
  ul.innerHTML = '';
  if (!te.templates.length) {
    ul.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:8px;">(저장된 템플릿 없음)</div>`;
    return;
  }
  for (const t of te.templates) {
    const isCur = te.editingTemplate?.id === t.id;
    const star = t.is_favorite ? '★' : '☆';
    const row = document.createElement('div');
    row.className = `te-list-item${isCur ? ' active' : ''}`;
    row.innerHTML = `
      <span class="star ${t.is_favorite ? 'fav' : ''}" data-id="${t.id}" title="즐겨찾기 토글">${star}</span>
      <span class="name" data-load="${t.id}" title="${escapeHtml(t.description || t.name)}">${escapeHtml(t.name)}${t.is_default ? ' <span style="color:var(--jazz-gold);font-size:10px;">★default</span>' : ''}</span>
      <span class="actions">
        <button data-load="${t.id}" type="button" title="편집">편집</button>
        <button data-dup="${t.id}" type="button" title="복제">복제</button>
        <button class="danger" data-del="${t.id}" type="button" title="삭제">✕</button>
      </span>
    `;
    ul.appendChild(row);
  }
  bindTemplateActions(ul);
}

function renderTemplateGallery() {
  const wrap = $('#teList');
  if (!wrap) return;
  wrap.className = 'te-card-grid';
  wrap.innerHTML = '';

  if (!te.templates.length) {
    wrap.className = 'te-list';
    wrap.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:8px;">(저장된 템플릿 없음)</div>`;
    return;
  }

  // 카드 DOM 생성 (썸네일은 placeholder, IntersectionObserver 가 보일 때 draw)
  for (const t of te.templates) {
    const isCur = te.editingTemplate?.id === t.id;
    const card = document.createElement('div');
    card.className = `te-tcard${isCur ? ' active' : ''}`;
    card.dataset.tid = t.id;
    card.innerHTML = `
      <button class="te-tcard-fav ${t.is_favorite ? 'fav' : ''}" data-fav-id="${t.id}" title="즐겨찾기 토글">${t.is_favorite ? '★' : '☆'}</button>
      <button class="te-tcard-del" data-del-id="${t.id}" title="삭제">✕</button>
      <canvas class="te-tcard-thumb" data-load-id="${t.id}" width="320" height="180" title="${escapeHtml(t.name)} — 클릭해서 편집"></canvas>
      ${t.is_default ? `<span class="te-tcard-default">DEFAULT</span>` : ''}
      <div class="te-tcard-name" data-load-id="${t.id}" title="${escapeHtml(t.description || t.name)}">${escapeHtml(t.name)}</div>
      <div class="te-tcard-actions">
        <button data-load-id="${t.id}" type="button">편집</button>
        <button data-dup-id="${t.id}" type="button">복제</button>
      </div>
    `;
    wrap.appendChild(card);
  }

  bindTemplateActions(wrap);
  setupGalleryObserver(wrap);
}

function bindTemplateActions(scope) {
  // 리스트 모드 ([data-load], [data-dup], [data-del], .star)
  scope.querySelectorAll('.star').forEach((s) =>
    s.addEventListener('click', () => toggleFavorite(parseInt(s.dataset.id, 10)))
  );
  scope.querySelectorAll('[data-load]').forEach((b) =>
    b.addEventListener('click', () => loadTemplate(parseInt(b.dataset.load, 10)))
  );
  scope.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', () => duplicateTemplate(parseInt(b.dataset.dup, 10)))
  );
  scope.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteTemplate(parseInt(b.dataset.del, 10)))
  );
  // 갤러리 모드 (data-{action}-id)
  scope.querySelectorAll('[data-fav-id]').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFavorite(parseInt(b.dataset.favId, 10));
    })
  );
  scope.querySelectorAll('[data-del-id]').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteTemplate(parseInt(b.dataset.delId, 10));
    })
  );
  scope.querySelectorAll('[data-load-id]').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      loadTemplate(parseInt(b.dataset.loadId, 10));
    })
  );
  scope.querySelectorAll('[data-dup-id]').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      duplicateTemplate(parseInt(b.dataset.dupId, 10));
    })
  );
}

function setupGalleryObserver(wrap) {
  if (gallery.observer) gallery.observer.disconnect();
  gallery.drawnTids.clear();
  gallery.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      const tid = parseInt(card.dataset.tid, 10);
      if (gallery.drawnTids.has(tid)) continue;
      const tmpl = te.templates.find((x) => x.id === tid);
      const cv = card.querySelector('canvas.te-tcard-thumb');
      if (tmpl && cv) {
        drawCardThumbnail(cv, tmpl);
        gallery.drawnTids.add(tid);
      }
      gallery.observer.unobserve(card);
    }
  }, { root: null, rootMargin: '100px', threshold: 0.05 });
  wrap.querySelectorAll('.te-tcard').forEach((card) => gallery.observer.observe(card));
}

// ─── 카드 썸네일 그리기 ───────────────────────────────────────
function loadGalleryImage(url, onReady) {
  if (!url) return null;
  const cached = gallery.imgCache.get(url);
  if (cached && cached.ready) return cached.img;
  if (cached) return null; // 로딩 중
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const slot = { img, ready: false };
  gallery.imgCache.set(url, slot);
  img.onload = () => {
    slot.ready = true;
    if (onReady) onReady();
  };
  img.onerror = () => {
    // 로드 실패해도 이미 그린 placeholder 그대로 둠.
    slot.ready = false;
  };
  img.src = url;
  return null;
}

function drawCardThumbnail(canvas, template) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // 배경 — gallery.bgMode 분기
  if (gallery.bgMode === 'dark') {
    ctx.fillStyle = '#0A0A0A';
    ctx.fillRect(0, 0, W, H);
  } else if (gallery.bgMode === 'light') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);
  } else {
    // image 모드 — 템플릿의 배경 이미지 사용
    ctx.fillStyle = '#0A0A0A';
    ctx.fillRect(0, 0, W, H);
    if (template.background_image_url) {
      const img = loadGalleryImage(template.background_image_url, () => {
        const card = document.querySelector(`.te-tcard[data-tid="${template.id}"]`);
        if (card) {
          const cv = card.querySelector('canvas.te-tcard-thumb');
          if (cv) drawCardThumbnail(cv, template);
        }
      });
      if (img) {
        const ar = img.naturalWidth / img.naturalHeight;
        const target = W / H;
        let dw = W, dh = H, dx = 0, dy = 0;
        if (ar > target) { dw = H * ar; dx = (W - dw) / 2; }
        else { dh = W / ar; dy = (H - dh) / 2; }
        ctx.drawImage(img, dx, dy, dw, dh);
      } else {
        // 로딩 중 — 체크 패턴
        ctx.fillStyle = '#161616';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#0E0E0E';
        const cs = 8;
        for (let y = 0; y < H; y += cs) {
          for (let x = (y / cs) % 2 === 0 ? 0 : cs; x < W; x += cs * 2) {
            ctx.fillRect(x, y, cs, cs);
          }
        }
      }
    }
  }

  // 컴포넌트
  const cfg = template.config_json || {};
  const components = Array.isArray(cfg.components)
    ? cfg.components
    : loadConfigToCanvas(cfg);
  const sx = W / CANVAS_W;
  const sy = H / CANVAS_H;
  for (const c of components) {
    drawCardComponent(ctx, c, template, sx, sy);
  }
}

function drawCardComponent(ctx, c, template, sx, sy) {
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  if (c.type === 'text') drawCardText(ctx, c, sx, sy);
  else if (c.type === 'image') drawCardImage(ctx, c, template, sx, sy);
  else if (c.type === 'visualizer') drawCardVisualizer(ctx, c, sx, sy);
  else if (c.type === 'progress') drawCardProgress(ctx, c, sx, sy);
  ctx.restore();
}

function drawCardText(ctx, c, sx, sy) {
  const x = c.x * sx, y = c.y * sy;
  const w = c.width * sx, h = c.height * sy;
  const fs = (c.fontSize || 72) * sx;
  if (fs < 3) return; // 너무 작으면 스킵 (무의미)
  let weight = c.bold ? 700 : 400;
  let style = c.italic ? 'italic ' : '';
  ctx.font = `${style}${weight} ${fs}px ${c.fontFamily || 'Playfair Display, serif'}`;
  ctx.fillStyle = c.color || '#FFFFFF';
  ctx.textBaseline = 'middle';
  const align = c.textAlign || 'center';
  ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';

  // textTransform 적용
  let txt = String(c.content || '')
    .replace(/\{\{trackTitle\}\}/g, 'Track Title')
    .replace(/\{\{trackNumber\}\}/g, '1')
    .replace(/\{\{totalTracks\}\}/g, '14');
  if (c.textTransform === 'uppercase') txt = txt.toUpperCase();
  else if (c.textTransform === 'lowercase') txt = txt.toLowerCase();
  else if (c.textTransform === 'capitalize') txt = txt.replace(/\b\w/g, (m) => m.toUpperCase());

  // 글로우 (밝은 색일 때만)
  if (!isDarkColor(c.color) && (c.glowIntensity ?? 1.0) > 0) {
    ctx.shadowColor = 'rgba(212,175,55,0.7)';
    ctx.shadowBlur = 6 * (c.glowIntensity ?? 1.0);
  }

  // 다중 라인 — \n 분리
  const lines = txt.split('\n');
  const lineH = fs * (c.lineHeight ?? 1.2);
  const totalH = lineH * lines.length;
  const startY = y + h / 2 - totalH / 2 + lineH / 2;
  let drawX = x + w / 2;
  if (align === 'left') drawX = x;
  else if (align === 'right') drawX = x + w;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], drawX, startY + i * lineH);
  }
}

function drawCardImage(ctx, c, template, sx, sy) {
  const x = c.x * sx, y = c.y * sy;
  const w = c.width * sx, h = c.height * sy;
  if (!c.src) {
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.strokeRect(x, y, w, h);
    return;
  }
  const img = loadGalleryImage(c.src, () => {
    const card = document.querySelector(`.te-tcard[data-tid="${template.id}"]`);
    if (card) {
      const cv = card.querySelector('canvas.te-tcard-thumb');
      if (cv) drawCardThumbnail(cv, template);
    }
  });
  if (!img) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(x, y, w, h);
    return;
  }
  ctx.drawImage(img, x, y, w, h);
}

function drawCardVisualizer(ctx, c, sx, sy) {
  // static pseudo-spectrum (deterministic, no animation)
  const x = c.x * sx, y = c.y * sy;
  const w = c.width * sx, h = c.height * sy;
  const N = c.barCount || 80;
  const barWidth = Math.max(1, (c.barWidth || 6) * sx);
  const barGap = (c.barGap || 2) * sx;
  const ew = barWidth + barGap;
  const halfBars = Math.min(N, Math.max(1, Math.floor((w / 2) / ew)));
  const splitGap = (c.splitGap || 0) * sy;
  const halfSplit = splitGap / 2;
  const ox = x + w / 2;
  const oy = y + h / 2;
  const isGradient = c.colorMode === 'gradient' && Array.isArray(c.gradientStops) && c.gradientStops.length >= 2;

  // glow
  if ((c.glow ?? 20) > 0) {
    ctx.shadowBlur = (c.glow / 4) * sx; // 카드 스케일에 맞춤
    ctx.shadowColor = isGradient ? '#D4AF37' : (c.color || '#D4AF37');
  }

  const heightCap = h * 0.85;
  for (let i = 0; i < halfBars; i++) {
    // deterministic pseudo height: sin 합성 (시드)
    const seed = (Math.sin(i * 0.92 + 1.7) * 43758.5453 + 1) % 1;
    const seed2 = Math.sin(i * 0.31 + 0.6);
    const norm = Math.max(0.15, Math.min(1, 0.4 + 0.35 * seed2 + 0.15 * seed));
    const barH = norm * heightCap;
    const halfH = barH / 2;

    if (isGradient) {
      const rgb = gradientColorAt(c.gradientStops, (i / Math.max(1, halfBars - 1)) * 100);
      ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
      ctx.shadowColor = ctx.fillStyle;
    } else {
      ctx.fillStyle = c.color || '#D4AF37';
    }

    if (c.verticalMode === 'symmetric' && (c.splitGap || 0) === 0) {
      ctx.fillRect(ox + i * ew, oy - halfH, barWidth, barH);
      ctx.fillRect(ox - (i + 1) * ew, oy - halfH, barWidth, barH);
    } else {
      if (c.verticalMode !== 'down') {
        ctx.fillRect(ox + i * ew, oy - halfSplit - halfH, barWidth, halfH);
        ctx.fillRect(ox - (i + 1) * ew, oy - halfSplit - halfH, barWidth, halfH);
      }
      if (c.verticalMode !== 'up') {
        ctx.fillRect(ox + i * ew, oy + halfSplit, barWidth, halfH);
        ctx.fillRect(ox - (i + 1) * ew, oy + halfSplit, barWidth, halfH);
      }
    }
  }
  ctx.shadowBlur = 0;
}

function drawCardProgress(ctx, c, sx, sy) {
  const x = c.x * sx, y = c.y * sy;
  const w = c.width * sx, h = c.height * sy;
  const r = h / 2;
  // bg
  ctx.fillStyle = c.bgColor || 'rgba(255,255,255,0.1)';
  roundedRect(ctx, x, y, w, h, r);
  // fill 50%
  ctx.fillStyle = c.fillColor || '#D4AF37';
  roundedRect(ctx, x, y, w * 0.5, h, r);
}

async function toggleFavorite(id) {
  const t = te.templates.find((x) => x.id === id);
  if (!t) return;
  try {
    await apiPost(`/api/templates/${id}/favorite`, { is_favorite: !t.is_favorite });
    await refreshTemplateList();
  } catch (e) {
    toast(`즐겨찾기 실패: ${e.message}`, 'error');
  }
}

async function loadTemplate(id) {
  try {
    const j = await apiGet(`/api/templates/${id}`);
    te.editingTemplate = j.template;
    te.components = loadConfigToCanvas(j.template.config_json || {});
    te.bgUrl = j.template.background_image_url || null;
    te.selectedId = null;
    $('#teEditingName').textContent = j.template.name;
    $('#teBgStatus').textContent = te.bgUrl ? '(편집 중인 템플릿의 배경)' : '(배경 없음)';
    renderCanvas();
    renderTemplateList();
    toast(`로드: ${j.template.name}`, 'info', 1500);
  } catch (e) {
    toast(`템플릿 로드 실패: ${e.message}`, 'error');
  }
}

async function duplicateTemplate(id) {
  try {
    const j = await apiPost(`/api/templates/${id}/duplicate`, {});
    toast(`복제: ${j.template.name}`, 'success');
    await refreshTemplateList();
  } catch (e) {
    toast(`복제 실패: ${e.message}`, 'error');
  }
}

async function deleteTemplate(id) {
  const t = te.templates.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`템플릿 "${t.name}" 을(를) 삭제합니다. 되돌릴 수 없습니다.\n계속?`)) return;
  try {
    await apiDelete(`/api/templates/${id}`);
    toast(`삭제됨: ${t.name}`, 'success');
    if (te.editingTemplate?.id === id) {
      te.editingTemplate = null;
      $('#teEditingName').textContent = '(새 템플릿)';
    }
    await refreshTemplateList();
  } catch (e) {
    toast(`삭제 실패: ${e.message}`, 'error');
  }
}

// ─── Tab onEnter ─────────────────────────────────────────────
async function templatesOnEnter() {
  if (!te.initialized) {
    te.initialized = true;
    // AudioContext 를 미리 만들어둠 — AudioMotion 인스턴스가 이 context 를 공유해야
    // 나중에 audio.source (같은 context) 를 connect 할 수 있음. 자동재생 정책 때문에
    // 처음엔 suspended 상태로 시작 — 사용자 ▶ 클릭 시 resume.
    ensureAudioContext();
    await Promise.all([refreshTemplateList(), refreshPreviewTracks()]);
    renderCanvas();
    startVisualizerTicker();
    bindPreviewControls();
    bindModeToggle();
    applyModeToggleUI();
  } else {
    refreshTemplateList();
    // preview 곡 리스트 — 새 곡 업로드 가능성 → 리프레시
    refreshPreviewTracks();
  }
}

// ─── Audio preview controls ─────────────────────────────────
async function refreshPreviewTracks() {
  try {
    const j = await apiGet('/api/tracks?limit=100&orderBy=newest');
    audio.cachedTracks = (j.tracks || []).map((t) => ({
      id: t.id,
      label: t.title?.title_en || t.original_filename || `Track #${t.id}`,
    }));
    const sel = $('#tePreviewTrack');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— 곡 선택 (없으면 가짜 데이터) —</option>';
    for (const t of audio.cachedTracks) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = t.label;
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  } catch (e) {
    console.warn('preview tracks 로드 실패:', e.message);
  }
}

function ensureAudioContext() {
  if (audio.context) return;
  audio.context = new (window.AudioContext || window.webkitAudioContext)();
}

function disposePreview() {
  if (audio.element) {
    try { audio.element.pause(); } catch {}
    try { audio.element.removeAttribute('src'); audio.element.load(); } catch {}
    audio.element = null;
  }
  if (audio.source) {
    try { audio.source.disconnect(); } catch {}
    audio.source = null;
  }
  audio.trackId = null;
  audio.duration = 0;
  // 모든 visualizer 의 source 도 끊기
  reattachAllVisualizerSources();
  setPreviewUiState({ ready: false, playing: false, time: 0, duration: 0 });
}

async function loadPreviewTrack(trackId) {
  try {
    setPreviewStatus(`signed URL 발급 중…`);
    const r = await fetch(`/api/tracks/${trackId}/audio-url`);
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);

    disposePreview();
    ensureAudioContext();

    const el = new Audio();
    el.crossOrigin = 'anonymous';   // 반드시 src 전에 set (CORS)
    el.preload = 'auto';
    el.src = j.url;
    audio.element = el;
    audio.trackId = trackId;

    // mediaElementSource 는 audio element 마다 1회만.
    // AudioMotion 이 자체 분석을 하므로 우리 쪽 AnalyserNode 는 제거.
    // 스피커 출력은 source → destination 직결.
    audio.source = audio.context.createMediaElementSource(el);
    audio.source.connect(audio.context.destination);

    // 모든 visualizer 가 새 source 사용하도록 다시 연결
    reattachAllVisualizerSources();

    el.addEventListener('loadedmetadata', () => {
      audio.duration = el.duration || 0;
      setPreviewUiState({ ready: true, playing: false, time: 0, duration: audio.duration });
      setPreviewStatus(`${j.title || ''} (${fmtTime(audio.duration)})`.trim() || '로드 완료');
    });
    el.addEventListener('timeupdate', () => {
      setPreviewUiState({ ready: true, playing: !el.paused, time: el.currentTime, duration: audio.duration });
    });
    el.addEventListener('ended', () => {
      setPreviewUiState({ ready: true, playing: false, time: el.duration || 0, duration: audio.duration });
    });
    el.addEventListener('error', () => {
      setPreviewStatus(`오디오 로드 실패 — Storage CORS 확인 필요 (Supabase Dashboard → Storage → Settings → CORS)`);
      toast('오디오 로드 실패. CORS 설정 확인.', 'error', 6000);
    });
  } catch (e) {
    setPreviewStatus(`로드 실패: ${e.message}`);
    toast(`미리듣기 로드 실패: ${e.message}`, 'error');
  }
}

function fmtTime(sec) {
  if (!sec || !Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function setPreviewUiState({ ready, playing, time, duration }) {
  $('#tePreviewPlay').disabled = !ready || playing;
  $('#tePreviewPause').disabled = !ready || !playing;
  $('#tePreviewStop').disabled = !ready;
  $('#tePreviewTime').textContent = `${fmtTime(time)} / ${fmtTime(duration)}`;
  const pct = duration > 0 ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0;
  $('#tePreviewProgress').style.width = `${pct}%`;
}

function setPreviewStatus(msg) {
  const el = $('#tePreviewStatus');
  if (el) el.textContent = msg;
}

function bindPreviewControls() {
  $('#tePreviewTrack')?.addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (!v) {
      disposePreview();
      setPreviewStatus('(선택 안 됨 → 가짜 스펙트럼)');
      return;
    }
    loadPreviewTrack(parseInt(v, 10));
  });
  $('#tePreviewPlay')?.addEventListener('click', async () => {
    if (!audio.element) return;
    try {
      if (audio.context.state === 'suspended') await audio.context.resume();
      await audio.element.play();
      setPreviewUiState({ ready: true, playing: true, time: audio.element.currentTime, duration: audio.duration });
    } catch (e) {
      toast(`재생 실패: ${e.message}`, 'error');
    }
  });
  $('#tePreviewPause')?.addEventListener('click', () => {
    if (!audio.element) return;
    audio.element.pause();
    setPreviewUiState({ ready: true, playing: false, time: audio.element.currentTime, duration: audio.duration });
  });
  $('#tePreviewStop')?.addEventListener('click', () => {
    if (!audio.element) return;
    audio.element.pause();
    audio.element.currentTime = 0;
    setPreviewUiState({ ready: true, playing: false, time: 0, duration: audio.duration });
  });
}

// 페이지 언로드 시 정리
window.addEventListener('beforeunload', () => disposePreview());

// app.js 의 switchTab 이 hook 하는 전역
window.templatesOnEnter = templatesOnEnter;
