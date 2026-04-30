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
      textShadow: cfg.title.textShadow || '0 0 20px rgba(212,175,55,0.8)',
      textAlign: 'center',
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

  // 1) Fake spectrum — sine + 약간 랜덤. 부드럽게 oscillate.
  const t = time * 0.001;
  for (let i = 0; i < N; i++) {
    const base = 0.45 + 0.35 * Math.sin(i * 0.28 + t * 1.2);
    const wave2 = 0.20 * Math.sin(i * 0.7 + t * 0.7);
    const noise = (Math.random() - 0.5) * 0.18;
    state.raw[i] = Math.max(0.05, Math.min(1, base + wave2 + noise));
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
  // trimStart 는 FFT bin offset — Editor 미리보기에서는 raw 가 fake 라 직접 영향 약함.
  // legacy 식을 흉내 내기 위해 raw 인덱스에 +trimStart 만큼 시프트해서 다른 영역 sample.
  const trimStart = Math.max(0, c.trimStart | 0);

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
    // raw 인덱스에 trimStart 시프트 (out-of-range 면 wrap)
    const rawIdx = (i + trimStart) % N;
    const adjusted = state.raw[rawIdx] * 2000 * sensitivity * eq;

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
  setInterval(() => {
    if (!te.initialized) return;
    const now = performance.now();
    for (const c of te.components) {
      if (c.type !== 'visualizer') continue;
      const cv = document.querySelector(`#teCanvasInner [data-id="${c.id}"] canvas[data-vis-id="${c.id}"]`);
      if (cv) drawVisualizer(cv, c, now);
    }
  }, 50);
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
  window.interact(el).resizable({
    edges: { right: '.te-handle', bottom: '.te-handle' },
    listeners: {
      move(ev) {
        const cur = te.components.find((x) => x.id === c.id);
        if (!cur) return;
        const s = scale();
        const oldW = cur.width;
        cur.width = Math.max(20, Math.round(cur.width + ev.deltaRect.width / s));
        cur.height = Math.max(10, Math.round(cur.height + ev.deltaRect.height / s));
        // Text 는 폭에 비례해 폰트 크기 함께 스케일
        if (cur.type === 'text' && oldW > 0 && cur.width !== oldW) {
          const factor = cur.width / oldW;
          cur.fontSize = Math.max(8, Math.round((cur.fontSize || 72) * factor));
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
        <input type="text" data-prop="content" value="${escapeHtml(c.content || '')}" />
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
      ${slider('sensitivity', 'Sensitivity', 0, 0.3, 0.005, c.sensitivity ?? 0.15, '')}
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

function renderTemplateList() {
  const ul = $('#teList');
  if (!ul) return;
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
  ul.querySelectorAll('.star').forEach((s) =>
    s.addEventListener('click', () => toggleFavorite(parseInt(s.dataset.id, 10)))
  );
  ul.querySelectorAll('[data-load]').forEach((b) =>
    b.addEventListener('click', () => loadTemplate(parseInt(b.dataset.load, 10)))
  );
  ul.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', () => duplicateTemplate(parseInt(b.dataset.dup, 10)))
  );
  ul.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteTemplate(parseInt(b.dataset.del, 10)))
  );
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
    await refreshTemplateList();
    renderCanvas();
    startVisualizerTicker();
  } else {
    // 재진입 시 리스트 만 갱신 (다른 탭에서 변경 가능성)
    refreshTemplateList();
  }
}

// app.js 의 switchTab 이 hook 하는 전역
window.templatesOnEnter = templatesOnEnter;
