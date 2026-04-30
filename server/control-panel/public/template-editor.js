// Premium Jazz Lounge — Template Editor (Phase 4-C-1-A)
// vanilla ES module. interact.js 는 글로벌 (CDN 으로 로드).

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
      // Legacy 13 옵션 (기본값은 legacy original) + color mode (solid / gradient).
      return {
        ...base,
        width: 1200, height: 240,
        x: (CANVAS_W - 1200) / 2, y: 760,
        verticalMode: 'symmetric',  // 'symmetric' | 'up' | 'down' (legacy vMirror 0/1/2)
        barWidth: 6,
        barGap: 2,
        barCount: 80,
        sensitivity: 0.15,          // legacy barGain
        smoothing: 0.85,
        midBoost: 1.5,
        highBoost: 0.8,
        centerCut: 0,               // Low Cut — FFT bin offset
        splitGap: 0,                // 위/아래 미러 사이 수직 gap (px)
        trimStart: 3,               // FFT bin trim
        glow: 20,
        // 색상
        colorMode: 'solid',         // 'solid' | 'gradient'
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
  }
  return base;
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
    // legacy vMirror 0/1/2 → verticalMode 'symmetric'/'up'/'down'
    const vmMap = ['symmetric', 'up', 'down'];
    const verticalMode = typeof v.vMirror === 'number'
      ? (vmMap[v.vMirror] || 'symmetric')
      : (v.verticalMode || 'symmetric');
    result.push({
      id: nextId(),
      type: 'visualizer',
      x: (v.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (v.position?.y ?? 880) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      verticalMode,
      barWidth: v.barWidth ?? 6,
      barGap: v.barGap ?? 2,
      barCount: v.barCount ?? 80,
      sensitivity: v.sensitivity ?? v.barGain ?? 0.15,
      smoothing: v.smoothing ?? 0.85,
      midBoost: v.midBoost ?? 1.5,
      highBoost: v.highBoost ?? 0.8,
      centerCut: v.centerCut ?? 0,
      splitGap: v.splitGap ?? 0,
      trimStart: v.trimStart ?? 3,
      glow: v.glow ?? (typeof v.glowIntensity === 'number' ? Math.round(v.glowIntensity * 30) : 20),
      color: v.color || '#D4AF37',
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

// Visualizer 는 canvas 로 그림. inner HTML 은 빈 캔버스만 — 실제 그리기는 tickVisualizers.
function renderBars(c) {
  return `<canvas class="te-vis-canvas" data-vis-id="${c.id}" style="width:100%;height:100%;display:block;"></canvas>`;
}

// ─── Audio preview (real spectrum tap) ──────────────────────
// Editor 미리듣기 곡 — Web Audio API 의 AnalyserNode 로 실제 주파수 데이터 추출.
// 곡 미선택 시 fake spectrum 으로 fallback.
const audio = {
  context: null,
  analyser: null,
  element: null,
  source: null,
  bytes: null,            // Uint8Array (fftBinCount)
  trackId: null,
  duration: 0,
  cachedTracks: null,     // [{ id, label }]
};

const FFT_SIZE = 4096;    // legacy 와 동일

function audioHasRealData() {
  return !!(audio.analyser && audio.element && audio.bytes && !audio.element.paused);
}

function getRealSpectrum() {
  if (!audioHasRealData()) return null;
  audio.analyser.getByteFrequencyData(audio.bytes);
  return audio.bytes;
}

// 컴포넌트별 smoothing 상태. barCount 변경 시 길이 다시 맞춤.
const visState = new Map(); // id → { lastData: Float32Array, raw: Float32Array, len: number }

function getVisState(c) {
  const need = Math.max(1, c.barCount | 0);
  let s = visState.get(c.id);
  if (!s || s.len !== need) {
    s = { lastData: new Float32Array(need), raw: new Float32Array(need), len: need };
    visState.set(c.id, s);
  }
  return s;
}

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

function drawVisualizer(canvas, c, time) {
  // canvas 의 백킹 픽셀 크기 = 컴포넌트 박스 크기 (DPR 무시 — Editor 미리보기 우선)
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const state = getVisState(c);
  const N = state.len;

  // 1) Spectrum 채우기 — 실제 오디오면 AnalyserNode 의 byte data 를 legacy 의
  //    log mapping (centerCut + trimStart + pow(percent, 2)) 으로 N 개 막대 amplitude 로 변환.
  //    아니면 fake (sine + 랜덤).
  const real = getRealSpectrum();
  if (real) {
    // legacy 매핑: percent → pow(2) → rawIdx (FFT bin) + adaptive range (3~7 bin).
    // 저음(percent~0): 윈도우 좁게 (3 bin) — 저음 영역은 bin 자체가 빽빽하니 좁게.
    // 고음(percent~1): 윈도우 넓게 (7 bin) — 고음 영역은 bin 이 듬성하니 넓게.
    const fftSize = audio.analyser.fftSize;
    const binCount = real.length;
    const ccLocal = Math.max(0, c.centerCut | 0);
    const tsLocal = Math.max(0, c.trimStart | 0);
    for (let i = 0; i < N; i++) {
      const denom = N + ccLocal - 1;
      const percent = denom > 0 ? (i + ccLocal) / denom : 0;
      const logIndex = Math.pow(percent, 2.0);
      const rawIdx = Math.floor(tsLocal + logIndex * (fftSize / 5));
      const range = 2 + Math.floor(percent * 4);   // legacy: 3~7 bins
      let sum = 0, cnt = 0;
      for (let k = 0; k <= range; k++) {
        const idx = rawIdx + k;
        if (idx >= 0 && idx < binCount) {
          sum += real[idx];
          cnt++;
        }
      }
      state.raw[i] = cnt > 0 ? (sum / cnt) / 255 : 0;
    }
  } else {
    const t = time * 0.001;
    for (let i = 0; i < N; i++) {
      const base = 0.45 + 0.35 * Math.sin(i * 0.28 + t * 1.2);
      const wave2 = 0.20 * Math.sin(i * 0.7 + t * 0.7);
      const noise = (Math.random() - 0.5) * 0.18;
      state.raw[i] = Math.max(0.05, Math.min(1, base + wave2 + noise));
    }
  }

  // 2) Legacy 그리기 setup
  ctx.save();
  ctx.shadowBlur = Math.max(0, c.glow ?? 20);
  // solid 모드면 전역 stroke/shadow 색 한 번만, gradient 모드면 막대마다 갱신.
  const isGradient = c.colorMode === 'gradient' && Array.isArray(c.gradientStops) && c.gradientStops.length >= 2;
  if (!isGradient) {
    const rgb = hexToRgb(c.color || '#D4AF37');
    ctx.fillStyle = rgbToCss(rgb);
    ctx.shadowColor = rgbToCss(rgb);
  }

  const barWidth = Math.max(1, c.barWidth | 0 || 6);
  const barGap = Math.max(0, c.barGap | 0 || 0);
  const ew = barWidth + barGap;
  const splitGap = Math.max(0, c.splitGap | 0 || 0);
  const halfSplit = splitGap / 2;
  const ox = w / 2;
  const oy = h / 2;

  const sensitivity = Math.max(0, c.sensitivity ?? 0.15);
  const smoothing = Math.max(0, Math.min(0.999, c.smoothing ?? 0.85));
  const midBoost = c.midBoost ?? 1.5;
  const highBoost = c.highBoost ?? 0.8;
  const centerCut = Math.max(0, c.centerCut | 0);
  // 한쪽(반쪽) 에 들어갈 수 있는 max 막대 수
  const maxHalfBars = Math.max(1, Math.floor((w / 2) / Math.max(1, ew)));
  const drawCount = Math.min(N, maxHalfBars);

  // 영상 막대 max 높이 — legacy 는 (sum/count)*2000*barGain*eq 식.
  // Editor 에선 raw 를 0~1 로 만들고 동일 식 사용. height 는 컴포넌트 height 의 80% 클램프.
  const heightCap = h * 0.8;

  for (let i = 0; i < drawCount; i++) {
    const denom = c.barCount + centerCut - 1;
    const percent = denom > 0 ? (i + centerCut) / denom : 0;
    const eq = midBoost * (1 - percent) + highBoost * percent;
    // state.raw[i] 가 이미 i-th 막대의 amplitude (real: bin-mapped, fake: 직접).
    // trimStart/centerCut 은 real 일 때 fillRawSpectrum 에서 적용됐고, fake 는 무관.
    const adjusted = state.raw[i] * 2000 * sensitivity * eq;

    // smoothing — legacy: rising 은 빠르게 (prev*0.3 + raw*0.7), 떨어질 때만 smoothing
    const prev = state.lastData[i];
    state.lastData[i] = adjusted > prev
      ? prev * 0.3 + adjusted * 0.7
      : prev * smoothing + adjusted * (1 - smoothing);

    let barH = Math.min(state.lastData[i], heightCap);
    if (barH < 2) barH = 2;
    const halfH = barH / 2;
    const r = barWidth / 2;

    // gradient: 좌우 대칭이라 양쪽이 같은 인덱스 i. 가운데에서 가장자리로 갈수록 i 가 커짐.
    // 좌우를 합친 시각적 mapping 으로는 i=0 이 가운데, i=drawCount-1 이 가장자리.
    // 가장자리(좌우)~가운데 방향 그라데이션을 원하니 stop 0% = 가운데, 100% = 가장자리.
    if (isGradient) {
      const rgb = getBarColor(c, i, drawCount);
      ctx.fillStyle = rgbToCss(rgb);
      ctx.shadowColor = rgbToCss(rgb);
    }

    if (c.verticalMode === 'symmetric' && splitGap === 0) {
      // 단일 블록 — 좌우 대칭, 가운데 oy 기준 위/아래 동시
      roundedRect(ctx, ox + i * ew, oy - halfH, barWidth, barH, r);
      roundedRect(ctx, ox - (i + 1) * ew, oy - halfH, barWidth, barH, r);
    } else {
      // splitGap>0 또는 vMirror up/down → 위/아래 분리
      if (c.verticalMode !== 'down') {
        roundedRect(ctx, ox + i * ew, oy - halfSplit - halfH, barWidth, halfH, r);
        roundedRect(ctx, ox - (i + 1) * ew, oy - halfSplit - halfH, barWidth, halfH, r);
      }
      if (c.verticalMode !== 'up') {
        roundedRect(ctx, ox + i * ew, oy + halfSplit, barWidth, halfH, r);
        roundedRect(ctx, ox - (i + 1) * ew, oy + halfSplit, barWidth, halfH, r);
      }
    }
  }
  ctx.restore();
}

// 50ms 마다 모든 visualizer 를 갱신.
let _visTickerStarted = false;
function startVisualizerTicker() {
  if (_visTickerStarted) return;
  _visTickerStarted = true;
  let debugCounter = 0;
  setInterval(() => {
    if (!te.initialized) return;
    const now = performance.now();
    for (const c of te.components) {
      if (c.type !== 'visualizer') continue;
      const cv = document.querySelector(`#teCanvasInner [data-id="${c.id}"] canvas[data-vis-id="${c.id}"]`);
      if (cv) drawVisualizer(cv, c, now);
    }
    // 디버그 패널 — 200ms 마다 (4 tick) 갱신
    debugCounter++;
    if (debugCounter % 4 === 0) updateDebugSpectrumPanel();
  }, 50);
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
  const state = visState.get(c.id);
  if (!state) {
    panel.textContent = '(state 없음)';
    return;
  }
  const real = audioHasRealData() ? '✅ REAL' : '❌ FAKE';
  const N = state.len;
  let min = 1, max = 0, sum = 0;
  for (let i = 0; i < N; i++) {
    if (state.raw[i] < min) min = state.raw[i];
    if (state.raw[i] > max) max = state.raw[i];
    sum += state.raw[i];
  }
  const avg = sum / N;
  const fmt = (v) => v.toFixed(3);
  const sample = (arr, start, count) => {
    const out = [];
    for (let i = start; i < start + count && i < arr.length; i++) out.push(fmt(arr[i]));
    return out.join(' ');
  };
  const mid = Math.floor(N / 2);
  panel.textContent = [
    `mode: ${real}    bars: ${N}    min: ${fmt(min)}  max: ${fmt(max)}  avg: ${fmt(avg)}`,
    `low (i=0..4):    ${sample(state.raw, 0, 5)}`,
    `mid (i=${mid}..${mid + 4}):  ${sample(state.raw, mid, 5)}`,
    `high (i=${N - 5}..${N - 1}): ${sample(state.raw, N - 5, 5)}`,
    `lastData low: ${sample(state.lastData, 0, 5)}`,
    `lastData high: ${sample(state.lastData, N - 5, 5)}`,
  ].join('\n');
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
  }
  return '';
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
  $('#teCompCount').textContent = String(te.components.length);
  renderBg();
  renderProps();
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
        if (cur.type === 'text' && _dragStart && _dragStart.width > 0) {
          const factor = cur.width / _dragStart.width;
          cur.fontSize = Math.max(8, Math.round(_dragStart.fontSize * factor));
        }
        applyComponentTransform(el, cur);
        // 비주얼라이저는 width/height 변경 시 bar 다시 그리기
        if (cur.type === 'visualizer' || cur.type === 'progress' || cur.type === 'image' || cur.type === 'text') {
          el.querySelector('.te-bar')?.parentElement?.remove();
          const tr = el.querySelector('.text-render');
          const img = el.querySelector('img');
          const pt = el.querySelector('.te-progress-track');
          const noImage = el.querySelector('div[style*="이미지 없음"]');
          // 강제 재렌더 — 본체만 교체
          const oldExtra = el.querySelectorAll('.te-del, .te-handle, .te-opacity');
          // 내부 첫 자식만 교체
          const newInner = document.createElement('div');
          newInner.style.width = '100%'; newInner.style.height = '100%';
          newInner.innerHTML = renderComponentInner(cur);
          // 기존 내부 텍스트/img/visualizer 제거
          [...el.children].forEach((ch) => {
            if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
              ch.remove();
            }
          });
          // newInner 의 자식만 prepend
          while (newInner.firstChild) {
            el.insertBefore(newInner.firstChild, el.firstChild);
          }
          // Text 의 .text-render fontSize 를 화면 스케일에 맞춤 (rebuild 후 한 번 더)
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
  te.components[idx] = { ...te.components[idx], ...patch };
  const el = $(`#teCanvasInner [data-id="${id}"]`);
  if (!el) return;
  // inner 다시 그리기 (control 들 보존)
  [...el.children].forEach((ch) => {
    if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
      ch.remove();
    }
  });
  const inner = document.createElement('div');
  inner.style.width = '100%'; inner.style.height = '100%';
  inner.innerHTML = renderComponentInner(te.components[idx]);
  while (inner.firstChild) {
    el.insertBefore(inner.firstChild, el.firstChild);
  }
  // .text-render fontSize 스케일 + 좌표 재적용 (rebuild 후)
  applyComponentTransform(el, te.components[idx]);
}

function removeComponent(id) {
  te.components = te.components.filter((c) => c.id !== id);
  visState.delete(id);
  if (te.selectedId === id) te.selectedId = null;
  renderCanvas();
}

function addComponent(type) {
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
    typeFields = `
      <div class="te-prop">
        <label>Mode</label>
        <select data-prop="verticalMode">
          <option value="symmetric" ${c.verticalMode === 'symmetric' ? 'selected' : ''}>↕ Symmetric</option>
          <option value="up" ${c.verticalMode === 'up' ? 'selected' : ''}>↑ Up only</option>
          <option value="down" ${c.verticalMode === 'down' ? 'selected' : ''}>↓ Down only</option>
        </select>
      </div>
      ${colorBlock}
      ${slider('glow', 'Glow', 0, 80, 1, c.glow ?? 20, 'px')}
      ${slider('barCount', 'Bar Count', 4, 200, 1, c.barCount ?? 80, '')}
      ${slider('barWidth', 'Bar Width', 1, 30, 1, c.barWidth ?? 6, 'px')}
      ${slider('barGap', 'Bar Gap', 0, 30, 1, c.barGap ?? 2, 'px')}
      ${slider('splitGap', 'Split Gap', 0, 200, 1, c.splitGap ?? 0, 'px')}
      ${slider('centerCut', 'Low Cut', 0, 200, 1, c.centerCut ?? 0, '')}
      ${slider('trimStart', 'Trim Start', 0, 50, 1, c.trimStart ?? 3, '')}
      <div class="te-prop full" style="margin-top:6px;border-top:1px solid var(--border);padding-top:8px;">
        <label style="color:var(--jazz-gold)">— 주파수 —</label>
      </div>
      ${slider('sensitivity', 'Sensitivity', 0, 1, 0.005, c.sensitivity ?? 0.15, '')}
      ${slider('smoothing', 'Smoothing', 0, 1, 0.01, c.smoothing ?? 0.85, '')}
      ${slider('midBoost', 'Mid Boost', 0, 10, 0.05, c.midBoost ?? 1.5, '')}
      ${slider('highBoost', 'High Boost', 0, 10, 0.05, c.highBoost ?? 0.8, '')}
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
      if (Number.isNaN(val) && numericInput) return;
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
    });
  });
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

const gallery = {
  mode: localStorage.getItem(VIEW_MODE_KEY) || 'list',
  imgCache: new Map(),       // url → { img: Image, ready: bool }
  observer: null,            // IntersectionObserver — 화면 진입 시점에만 카드 그리기
  drawnTids: new Set(),      // 이미 그린 카드 id (캐싱)
};

function applyModeToggleUI() {
  const wrap = $('#teModeToggle');
  if (!wrap) return;
  wrap.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === gallery.mode);
  });
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
  // 배경
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, W, H);
  if (template.background_image_url) {
    const img = loadGalleryImage(template.background_image_url, () => {
      // 이미지 로드 후 다시 그리기 — 카드가 아직 DOM 에 있는지 확인
      const card = document.querySelector(`.te-tcard[data-tid="${template.id}"]`);
      if (card) {
        const cv = card.querySelector('canvas.te-tcard-thumb');
        if (cv) drawCardThumbnail(cv, template);
      }
    });
    if (img) {
      // cover 핏 — 비율 맞춰 채우고 잘라냄
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
  audio.analyser = audio.context.createAnalyser();
  audio.analyser.fftSize = FFT_SIZE;
  // ⚠ 막대 다양성을 위해 내부 smoothing 은 낮게. 사용자 smoothing 슬라이더가
  // 우리 쪽 pass 에서 적용되므로 여기서 더 smooth 하면 인접 막대들이 평탄화됨.
  audio.analyser.smoothingTimeConstant = 0.3;
  // dB range — 음악의 dynamic range 를 더 잘 보이게.
  audio.analyser.minDecibels = -90;
  audio.analyser.maxDecibels = -20;
  audio.bytes = new Uint8Array(audio.analyser.frequencyBinCount);
  audio.analyser.connect(audio.context.destination);
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
    audio.source = audio.context.createMediaElementSource(el);
    audio.source.connect(audio.analyser);

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
