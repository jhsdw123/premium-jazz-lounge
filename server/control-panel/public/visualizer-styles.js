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

// ─── 통합 entry ──────────────────────────────────────────────────

export function drawCustomVisualizer(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length === 0) return;
  ctx.save();
  ctx.globalAlpha = (comp.opacity ?? 1) * (ctx.globalAlpha ?? 1);
  switch (comp.visualizerStyle) {
    case 'wave-time':   drawWaveTime(ctx, comp, amplitudes, x, y, width, height); break;
    case 'mirror':      drawMirror(ctx, comp, amplitudes, x, y, width, height); break;
    case 'mirror-fill': drawMirrorFill(ctx, comp, amplitudes, x, y, width, height); break;
  }
  ctx.restore();
}

// 내부 helper export (테스트용)
export { strokeSmoothPath };
