// Phase 4-D-3-D-1: Visualizer custom styles (canvas-only).
//
// Bars / Line 은 AudioMotion-analyzer 자체 mode 로 처리 (이 파일은 무관).
// 본 모듈은 wave-time / mirror / mirror-fill — AudioMotion 의 raw bars 데이터를
// 받아 직접 그리는 함수들.
//
// AudioMotion getBars() → [{ value: number | [L,R], freq, ... }, ...]
//   value 는 0~1 normalize. 스테레오면 배열.
//
// 사용:
//   import { getAmplitudes, drawWaveTime, drawMirror, drawMirrorFill }
//     from './visualizer-styles.js';
//   const amps = getAmplitudes(audioMotion);
//   drawWaveTime(ctx, comp, amps, x, y, width, height);

// ─── 데이터 추출 ──────────────────────────────────────────────────

export function getAmplitudes(audioMotion) {
  if (!audioMotion || !audioMotion.getBars) return [];
  const bars = audioMotion.getBars();
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i].value;
    out[i] = Array.isArray(v) ? Math.max(v[0] || 0, v[1] || 0) : (v || 0);
  }
  return out;
}

// ─── 그라데이션/색상 helpers ─────────────────────────────────────

function buildStrokeStyle(ctx, comp, x, y, width /*, height */) {
  if (comp.colorMode === 'gradient' && Array.isArray(comp.gradientStops) && comp.gradientStops.length >= 2) {
    const grad = ctx.createLinearGradient(x, 0, x + width, 0);
    const sorted = [...comp.gradientStops].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const s of sorted) {
      const pos = Math.max(0, Math.min(1, (s.position ?? 0) / 100));
      grad.addColorStop(pos, s.color || '#FFFFFF');
    }
    return grad;
  }
  return comp.color || '#D4AF37';
}

function applyGlow(ctx, comp) {
  const glow = comp.glow ?? 0;
  if (glow > 0) {
    // Phase 4-D-3-D-1 polish: glow 색은 c.glowColor 직접 사용 (자동 매칭 X).
    ctx.shadowColor = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = glow;
  }
}

// ─── Catmull-Rom 부드러운 곡선 ───────────────────────────────────

// pts: [{x, y}, ...]. smoothness 0=각진(lineTo), 1=매우 부드러움.
function strokeSmoothPath(ctx, pts, smoothness) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (smoothness <= 0) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  // Catmull-Rom → cubic Bezier 변환. tension t = smoothness * 0.5.
  const t = Math.max(0, Math.min(1, smoothness)) * 0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;
    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

// ─── Style 1: Wave Time (좌→우 시간축 파형) ─────────────────────

export function drawWaveTime(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;
  const stepX = width / (N - 1);
  const cy = y + height / 2;
  const maxAmp = height / 2;

  ctx.save();
  ctx.lineWidth = comp.lineWidth ?? 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  applyGlow(ctx, comp);

  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    pts[i] = { x: x + i * stepX, y: cy - amplitudes[i] * maxAmp };
  }

  ctx.beginPath();
  strokeSmoothPath(ctx, pts, comp.smoothness ?? 0.5);
  ctx.stroke();
  ctx.restore();
}

// ─── Style 2: Mirror (가운데 기준 좌우 대칭, 상단 곡선) ─────────

// 둘 다 path 만들기 — 좌측 (가운데 → 좌끝), 우측 (가운데 → 우끝).
function buildMirrorTopPoints(comp, amplitudes, x, y, width, height) {
  const N = Math.floor(amplitudes.length / 2);
  if (N < 2) return null;
  const half = amplitudes.slice(0, N);
  const cx = x + width / 2;
  const stepX = (width / 2) / (N - 1);
  const cy = y + height / 2;
  const maxAmp = height / 2;
  const left = new Array(N);
  const right = new Array(N);
  for (let i = 0; i < N; i++) {
    const yy = cy - half[i] * maxAmp;
    left[i] = { x: cx - i * stepX, y: yy };  // 가운데에서 좌측으로
    right[i] = { x: cx + i * stepX, y: yy };
  }
  return { left, right };
}

export function drawMirror(ctx, comp, amplitudes, x, y, width, height) {
  const pts = buildMirrorTopPoints(comp, amplitudes, x, y, width, height);
  if (!pts) return;

  ctx.save();
  ctx.lineWidth = comp.lineWidth ?? 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  applyGlow(ctx, comp);

  const smoothness = comp.smoothness ?? 0.5;
  // 좌측 — 좌끝부터 가운데로 (역순 그리면 자연스러운 진행)
  const leftPath = pts.left.slice().reverse();
  ctx.beginPath();
  strokeSmoothPath(ctx, leftPath, smoothness);
  ctx.stroke();

  // 우측 — 가운데부터 우끝으로
  ctx.beginPath();
  strokeSmoothPath(ctx, pts.right, smoothness);
  ctx.stroke();

  ctx.restore();
}

// ─── Style 3: Mirror Fill (좌우 대칭 + 상하 영역 채움) ──────────

export function drawMirrorFill(ctx, comp, amplitudes, x, y, width, height) {
  const pts = buildMirrorTopPoints(comp, amplitudes, x, y, width, height);
  if (!pts) return;

  const cy = y + height / 2;
  const maxAmp = height / 2;
  const smoothness = comp.smoothness ?? 0.5;

  // 상단 path: 좌끝 → 가운데 → 우끝
  const topPath = [...pts.left.slice().reverse(), ...pts.right.slice(1)];
  // 하단 mirror path (대칭 반전): 우끝 → 가운데 → 좌끝, 단 y 는 cy 기준 반대.
  const bottomPath = topPath.slice().reverse().map((p) => ({
    x: p.x,
    y: cy + (cy - p.y),  // y 를 cy 기준으로 반사
  }));

  ctx.save();
  ctx.strokeStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  ctx.fillStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  ctx.lineWidth = comp.lineWidth ?? 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Fill 영역 — closed path (top + bottom)
  ctx.save();
  ctx.beginPath();
  strokeSmoothPath(ctx, topPath, smoothness);
  // bottom path 의 첫 point 가 topPath 의 마지막 point 위치(cy 기준 mirror)이므로
  // moveTo 없이 lineTo 로 연결되도록 strokeSmoothPath 가 alone path 라 별도 처리.
  // closePath 로 첫 점까지 자동 연결시키지 않고 직접 lineTo 추가.
  for (const p of bottomPath) ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.globalAlpha = (comp.fillOpacity ?? 0.3);
  ctx.fill();
  ctx.restore();

  // Stroke (top + bottom 각각) — 명확한 윤곽선
  applyGlow(ctx, comp);
  ctx.beginPath();
  strokeSmoothPath(ctx, topPath, smoothness);
  ctx.stroke();
  ctx.beginPath();
  strokeSmoothPath(ctx, bottomPath, smoothness);
  ctx.stroke();

  ctx.restore();
}

// ─── Style 4: Legacy Bars (옛 index.html 시그니처 디자인) ───────
// Phase 4-D-3-D-3 — Phase 4-C-1-A polish 4 (커밋 bdc7d52) 의 drawVisualizer 그대로 이식.
// 입력: byteFreqData (Uint8Array, AnalyserNode.getByteFrequencyData 결과) + fftSize.
// 출력: 좌우 대칭 막대 (round rect), legacy 의 log mapping + adaptive bin range + EQ.

// 컴포넌트별 smoothing state.
const _legacyVisState = new Map();  // id → { lastData: Float32Array, raw: Float32Array, len: number }

function getLegacyVisState(comp) {
  const need = Math.max(1, (comp.barCount | 0) || 80);
  let s = _legacyVisState.get(comp.id);
  if (!s || s.len !== need) {
    s = { lastData: new Float32Array(need), raw: new Float32Array(need), len: need };
    _legacyVisState.set(comp.id, s);
  }
  return s;
}

export function clearLegacyVisState(compId) {
  _legacyVisState.delete(compId);
}

// 그라데이션 색 (좌우 대칭 idx 기반). 0=가운데, totalBars-1=가장자리.
function legacyBarColor(comp, barIdx, totalBars) {
  if (comp.colorMode !== 'gradient' || !Array.isArray(comp.gradientStops) || comp.gradientStops.length < 2) {
    return comp.color || '#D4AF37';
  }
  const pct = (barIdx / Math.max(1, totalBars - 1)) * 100;
  const sorted = [...comp.gradientStops].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (pct <= sorted[0].position) return sorted[0].color || '#FFFFFF';
  if (pct >= sorted[sorted.length - 1].position) return sorted[sorted.length - 1].color || '#FFFFFF';
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (pct >= a.position && pct <= b.position) {
      const span = Math.max(0.0001, b.position - a.position);
      const t = (pct - a.position) / span;
      const c1 = hexToRgbLocal(a.color || '#FFFFFF');
      const c2 = hexToRgbLocal(b.color || '#FFFFFF');
      return `rgb(${Math.round(c1.r + (c2.r - c1.r) * t)},${Math.round(c1.g + (c2.g - c1.g) * t)},${Math.round(c1.b + (c2.b - c1.b) * t)})`;
    }
  }
  return sorted[sorted.length - 1].color || '#FFFFFF';
}

function hexToRgbLocal(hex) {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  if (m.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
}

function legacyRoundedRect(ctx, x, y, w, h, r) {
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

// 메인 그리기 — Phase 4-C-1-A polish 4 의 drawVisualizer 와 동일 로직.
// byteFreqData: Uint8Array (analyser.getByteFrequencyData 결과)
// fftSize: analyser.fftSize
export function drawLegacyBars(ctx, comp, byteFreqData, fftSize, x, y, width, height) {
  if (width <= 0 || height <= 0) return;

  const state = getLegacyVisState(comp);
  const N = state.len;
  const ccLocal = Math.max(0, comp.centerCut | 0);
  const tsLocal = Math.max(0, comp.trimStart | 0);

  // 1) Spectrum → state.raw (i-th 막대 amplitude 0~1)
  if (byteFreqData && byteFreqData.length > 0) {
    const binCount = byteFreqData.length;
    for (let i = 0; i < N; i++) {
      const denom = N + ccLocal - 1;
      const percent = denom > 0 ? (i + ccLocal) / denom : 0;
      const logIndex = Math.pow(percent, 2.0);
      const rawIdx = Math.floor(tsLocal + logIndex * (fftSize / 5));
      const range = 2 + Math.floor(percent * 4);  // legacy: 3~7 bins adaptive
      let sum = 0, cnt = 0;
      for (let k = 0; k <= range; k++) {
        const idx = rawIdx + k;
        if (idx >= 0 && idx < binCount) {
          sum += byteFreqData[idx];
          cnt++;
        }
      }
      state.raw[i] = cnt > 0 ? (sum / cnt) / 255 : 0;
    }
  } else {
    // fake (오디오 데이터 없을 때) — sine + 노이즈
    const t = performance.now() * 0.001;
    for (let i = 0; i < N; i++) {
      const base = 0.45 + 0.35 * Math.sin(i * 0.28 + t * 1.2);
      const wave2 = 0.20 * Math.sin(i * 0.7 + t * 0.7);
      const noise = (Math.random() - 0.5) * 0.18;
      state.raw[i] = Math.max(0.05, Math.min(1, base + wave2 + noise));
    }
  }

  // 2) 그리기 setup
  ctx.save();
  ctx.shadowBlur = Math.max(0, comp.glow ?? 20);
  // glow color 는 c.glowColor 직접 (Phase 4-D-3-D-1 polish 와 동일).
  const glowCol = comp.glowColor || '#D4AF37';
  const isGradient = comp.colorMode === 'gradient' && Array.isArray(comp.gradientStops) && comp.gradientStops.length >= 2;
  if (!isGradient) {
    const col = comp.color || '#D4AF37';
    ctx.fillStyle = col;
  }
  ctx.shadowColor = glowCol;

  const barWidth = Math.max(1, (comp.barWidth | 0) || 6);
  const barGap = Math.max(0, (comp.barGap | 0) || 0);
  const ew = barWidth + barGap;
  const splitGap = Math.max(0, (comp.splitGap | 0) || 0);
  const halfSplit = splitGap / 2;
  const ox = x + width / 2;
  const oy = y + height / 2;

  const sensitivity = Math.max(0, comp.sensitivity ?? 0.15);
  // legacySmoothing — AudioMotion 의 smoothing (FFT 시간 평탄화) 와 별개.
  // legacy 그리기 단계의 막대 떨림 smoothing.
  const smoothing = Math.max(0, Math.min(0.999, comp.legacySmoothing ?? 0.85));
  const midBoost = comp.midBoost ?? 1.5;
  const highBoost = comp.highBoost ?? 0.8;
  const centerCut = ccLocal;

  const maxHalfBars = Math.max(1, Math.floor((width / 2) / Math.max(1, ew)));
  const drawCount = Math.min(N, maxHalfBars);
  const heightCap = height * 0.8;
  const verticalMode = comp.legacyVerticalMode || comp.verticalMode || 'symmetric';

  for (let i = 0; i < drawCount; i++) {
    const denom = N + centerCut - 1;
    const percent = denom > 0 ? (i + centerCut) / denom : 0;
    const eq = midBoost * (1 - percent) + highBoost * percent;
    const adjusted = state.raw[i] * 2000 * sensitivity * eq;

    // smoothing — rising 빠름 (prev*0.3 + raw*0.7), falling 부드러움 (prev*s + raw*(1-s))
    const prev = state.lastData[i];
    state.lastData[i] = adjusted > prev
      ? prev * 0.3 + adjusted * 0.7
      : prev * smoothing + adjusted * (1 - smoothing);

    let barH = Math.min(state.lastData[i], heightCap);
    if (barH < 2) barH = 2;
    const halfH = barH / 2;
    const r = barWidth / 2;

    if (isGradient) {
      const col = legacyBarColor(comp, i, drawCount);
      ctx.fillStyle = col;
    }

    if (verticalMode === 'symmetric' && splitGap === 0) {
      // 단일 블록 — 좌우 대칭 + 위/아래 동시 (가운데 oy)
      legacyRoundedRect(ctx, ox + i * ew,           oy - halfH, barWidth, barH, r);
      legacyRoundedRect(ctx, ox - (i + 1) * ew,     oy - halfH, barWidth, barH, r);
    } else {
      // splitGap>0 또는 vMode up/down — 위/아래 분리
      if (verticalMode !== 'down') {
        legacyRoundedRect(ctx, ox + i * ew,         oy - halfSplit - halfH, barWidth, halfH, r);
        legacyRoundedRect(ctx, ox - (i + 1) * ew,   oy - halfSplit - halfH, barWidth, halfH, r);
      }
      if (verticalMode !== 'up') {
        legacyRoundedRect(ctx, ox + i * ew,         oy + halfSplit, barWidth, halfH, r);
        legacyRoundedRect(ctx, ox - (i + 1) * ew,   oy + halfSplit, barWidth, halfH, r);
      }
    }
  }
  ctx.restore();
}

// AudioMotion 의 internal AnalyserNode 에서 byteFreqData 추출.
//   v4.5+ 는 this._analyzer (단일 AnalyserNode). 스테레오 dual layout 일 땐 채널별 분리되지만
//   legacy 는 원래 단일 mono 였으니 그대로 단일 사용.
//   playing 중이 아니면 null 반환 → fake 데이터로 fallback.
export function getLegacyByteFreqData(audioMotion) {
  if (!audioMotion) return null;
  const an = audioMotion._analyzer;
  if (!an || typeof an.getByteFrequencyData !== 'function') return null;
  const buf = new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(buf);
  // 모두 0 이면 silence — null 반환해 fake 로 (legacy audioHasRealData 체크 모방)
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  if (sum === 0) return null;
  return { data: buf, fftSize: an.fftSize };
}

// ─── 통합 entry ──────────────────────────────────────────────────

export function drawCustomVisualizer(ctx, comp, amplitudes, x, y, width, height, audioMotion) {
  ctx.save();
  ctx.globalAlpha = (comp.opacity ?? 1) * (ctx.globalAlpha ?? 1);
  switch (comp.visualizerStyle) {
    case 'wave-time':
      if (amplitudes && amplitudes.length) drawWaveTime(ctx, comp, amplitudes, x, y, width, height);
      break;
    case 'mirror':
      if (amplitudes && amplitudes.length) drawMirror(ctx, comp, amplitudes, x, y, width, height);
      break;
    case 'mirror-fill':
      if (amplitudes && amplitudes.length) drawMirrorFill(ctx, comp, amplitudes, x, y, width, height);
      break;
    case 'legacy-bars': {
      // AudioMotion 의 internal analyser 에서 byteFreqData 가져오기
      const real = audioMotion ? getLegacyByteFreqData(audioMotion) : null;
      drawLegacyBars(ctx, comp, real?.data || null, real?.fftSize || 8192, x, y, width, height);
      break;
    }
  }
  ctx.restore();
}

// 내부 helper export (테스트용)
export { strokeSmoothPath };
