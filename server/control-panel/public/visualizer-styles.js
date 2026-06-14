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

// ─── 추가 helpers (Style 4~8) ────────────────────────────────────

function hexToRgbArr(hex) {
  const h = (hex || '#D4AF37').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(f.slice(0, 2), 16) || 0,
    parseInt(f.slice(2, 4), 16) || 0,
    parseInt(f.slice(4, 6), 16) || 0,
  ];
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgbArr(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 캔버스 4면 가장자리를 부드럽게 페이드아웃 (destination-out 마스크).
// 경계에서 직각으로 잘리는 걸 방지 — 연기처럼 형태가 불규칙한 효과에 사용.
// fx = 페더 폭. 모서리(코너)는 두 면이 겹쳐 더 자연스럽게 풀린다.
function featherEdges(ctx, x, y, width, height, fx) {
  if (fx <= 0) return;
  const fade = (grad) => {
    grad.addColorStop(0, 'rgba(0,0,0,1)');   // 경계 = 완전 제거
    grad.addColorStop(1, 'rgba(0,0,0,0)');   // 안쪽 = 보존
    return grad;
  };
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  // 좌
  ctx.fillStyle = fade(ctx.createLinearGradient(x, 0, x + fx, 0));
  ctx.fillRect(x, y, fx, height);
  // 우
  ctx.fillStyle = fade(ctx.createLinearGradient(x + width, 0, x + width - fx, 0));
  ctx.fillRect(x + width - fx, y, fx, height);
  // 상
  ctx.fillStyle = fade(ctx.createLinearGradient(0, y, 0, y + fx));
  ctx.fillRect(x, y, width, fx);
  // 하
  ctx.fillStyle = fade(ctx.createLinearGradient(0, y + height, 0, y + height - fx));
  ctx.fillRect(x, y + height - fx, width, fx);
  ctx.restore();
}

// 연기 색 stops 생성: 중심(off 0) → 바깥(off 1). Gradient colorMode 면
// 사용자 gradientStops 를 그대로 톤으로 사용(투톤/쓰리톤+), 아니면 단색.
// 바깥으로 갈수록 alpha 가 줄어 자연스러운 연무 페이드. 끝은 완전 투명.
function buildSmokeColorStops(comp) {
  const make = (hex, off) => {
    const [r, g, b] = hexToRgbArr(hex);
    return { off, r, g, b, alpha: Math.max(0, 1 - off * 0.85) };
  };
  let stops;
  if (comp.colorMode === 'gradient'
      && Array.isArray(comp.gradientStops)
      && comp.gradientStops.length >= 2) {
    const sorted = [...comp.gradientStops].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    stops = sorted.map((s) => make(s.color || '#FFFFFF', Math.max(0, Math.min(1, (s.position ?? 0) / 100))));
    if (stops[0].off > 0) stops.unshift(make(sorted[0].color || '#FFFFFF', 0));
    if (stops[stops.length - 1].off < 1) stops.push(make(sorted[sorted.length - 1].color || '#FFFFFF', 1));
  } else {
    const col = comp.color || '#D4AF37';
    stops = [make(col, 0), make(col, 1)];
  }
  stops[stops.length - 1].alpha = 0;  // 바깥 끝은 완전 투명
  return stops;
}

// ─── Style 4: Aurora Hills (하단 baseline, 비대칭 능선 + 채움 + 글로우) ─

export function drawAuroraHills(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;
  const stepX = width / (N - 1);
  const baseline = y + height;
  const maxAmp = height * 0.9;
  const smoothness = comp.smoothness ?? 0.7;

  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    pts[i] = { x: x + i * stepX, y: baseline - amplitudes[i] * maxAmp };
  }

  ctx.save();

  // 능선 아래 채움
  ctx.beginPath();
  strokeSmoothPath(ctx, pts, smoothness);
  ctx.lineTo(x + width, baseline);
  ctx.lineTo(x, baseline);
  ctx.closePath();
  ctx.fillStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  ctx.globalAlpha = (comp.fillOpacity ?? 0.35);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 빛나는 능선
  ctx.beginPath();
  strokeSmoothPath(ctx, pts, smoothness);
  ctx.lineWidth = comp.lineWidth ?? 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  applyGlow(ctx, comp);
  ctx.stroke();

  ctx.restore();
}

// ─── Style 5: Capsule Bars (끝이 둥근 막대 + 넓은 간격 + 글로우) ──

export function drawCapsuleBars(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;
  const slot = width / N;
  const barW = slot * 0.55;            // 막대 55%, 간격 45%
  const gap = (slot - barW) / 2;
  const baseline = y + height;
  const maxAmp = height * 0.95;
  const radius = barW / 2;

  ctx.save();
  ctx.fillStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  applyGlow(ctx, comp);
  for (let i = 0; i < N; i++) {
    const bx = x + i * slot + gap;
    let bh = amplitudes[i] * maxAmp;
    if (bh < barW) bh = barW;          // 최소 = 원 (캡슐 끝)
    roundRectPath(ctx, bx, baseline - bh, barW, bh, radius);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Style 6: Reflection Bars (막대 + 아래로 페이드되는 거울 반사) ──

export function drawReflectionBars(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;
  const slot = width / N;
  const barW = slot * 0.6;
  const gap = (slot - barW) / 2;
  const baseline = y + height * 0.62;  // 바닥선 (위 62% 막대, 아래 38% 반사)
  const maxAmp = height * 0.55;
  const reflectMax = height * 0.34;
  const radius = Math.min(barW / 2, 4);
  const fill = buildStrokeStyle(ctx, comp, x, y, width, height);
  const baseColor = comp.color || '#D4AF37';
  const reflAlpha = comp.fillOpacity ?? 0.35;

  ctx.save();
  for (let i = 0; i < N; i++) {
    const bx = x + i * slot + gap;
    const amp = amplitudes[i];
    const bh = Math.max(2, amp * maxAmp);

    // 메인 막대 (글로우)
    ctx.save();
    ctx.fillStyle = fill;
    applyGlow(ctx, comp);
    roundRectPath(ctx, bx, baseline - bh, barW, bh, radius);
    ctx.fill();
    ctx.restore();

    // 거울 반사 (세로 alpha 페이드)
    const rh = Math.max(1, amp * reflectMax);
    const grad = ctx.createLinearGradient(0, baseline, 0, baseline + rh);
    grad.addColorStop(0, hexToRgba(baseColor, reflAlpha));
    grad.addColorStop(1, hexToRgba(baseColor, 0));
    ctx.save();
    ctx.fillStyle = grad;
    roundRectPath(ctx, bx, baseline, barW, rh, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ─── Style 7: Peak Dots (얇은 막대 + 떠다니는 peak-hold 점) ────────

export function drawPeakDots(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;
  const slot = width / N;
  const barW = Math.max(1, slot * 0.18);
  const baseline = y + height;
  const maxAmp = height * 0.86;
  const dotR = Math.max(2, slot * 0.16);
  const fill = buildStrokeStyle(ctx, comp, x, y, width, height);

  // peak-hold 상태 (천천히 내려오는 점)
  if (!Array.isArray(comp._peaks) || comp._peaks.length !== N) {
    comp._peaks = new Array(N).fill(0);
  }
  const peaks = comp._peaks;
  const decay = 0.012;

  ctx.save();
  for (let i = 0; i < N; i++) {
    const cx = x + i * slot + slot / 2;
    const amp = amplitudes[i];
    const bh = amp * maxAmp;

    // 얇은 막대 (옅게)
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.shadowBlur = 0;
    ctx.fillStyle = fill;
    ctx.fillRect(cx - barW / 2, baseline - bh, barW, bh);
    ctx.restore();

    // peak-hold 갱신
    if (amp > peaks[i]) peaks[i] = amp;
    else peaks[i] = Math.max(amp, peaks[i] - decay);

    // 떠다니는 점 (밝게 + 글로우)
    const py = baseline - peaks[i] * maxAmp - dotR - 2;
    ctx.save();
    ctx.fillStyle = fill;
    applyGlow(ctx, comp);
    ctx.beginPath();
    ctx.arc(cx, py, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ─── Style 8: Smoke (하단에서 피어올라 퍼지며 사라지는 연무 — 파티클) ─

export function drawSmoke(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const N = amplitudes.length;

  // 중심 → 바깥 색 stops. Gradient 모드면 사용자 지정(투톤/쓰리톤+),
  // Solid 모드면 단색이 바깥으로 갈수록 투명.
  const smokeStops = buildSmokeColorStops(comp);

  // 파티클 풀 (comp 에 보존 — updateComponent 가 spread 로 ref 유지)
  if (!Array.isArray(comp._smoke)) comp._smoke = [];
  const parts = comp._smoke;
  const MAX = 460;
  const density = comp.smokeDensity ?? 1;
  const intensity = comp.fillOpacity ?? 0.5;
  const slot = width / N;

  // 진폭에 비례해 하단에서 입자 방출
  for (let i = 0; i < N; i++) {
    const amp = amplitudes[i];
    if (amp < 0.04) continue;
    const rate = amp * amp * 2.2 * density;
    let n = Math.floor(rate);
    if (Math.random() < rate - n) n++;
    for (let k = 0; k < n && parts.length < MAX; k++) {
      parts.push({
        x: x + (i + Math.random()) * slot,
        y: y + height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(0.6 + Math.random() * 0.9 + amp * 1.4),
        r: slot * (0.5 + Math.random()),
        life: 1,
        decay: 0.006 + Math.random() * 0.006,
        sway: Math.random() * Math.PI * 2,
      });
    }
  }

  // 업데이트 + 그리기. 일반 합성(source-over) — 겹쳐도 색이 흰색으로
  // 포화되지 않아, 사용자가 고른 중심/바깥 색이 그대로 유지된다.
  ctx.save();
  for (let p = parts.length - 1; p >= 0; p--) {
    const pt = parts[p];
    pt.sway += 0.04;
    pt.x += pt.vx + Math.sin(pt.sway) * 0.3;   // 난류 흔들림
    pt.y += pt.vy;
    pt.vy *= 0.992;                            // 상승 감속
    pt.r += 0.6;                               // 퍼짐
    pt.life -= pt.decay;
    if (pt.life <= 0 || pt.y < y - pt.r) {
      parts.splice(p, 1);
      continue;
    }
    const a = pt.life * pt.life * intensity;   // ease-out 페이드
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, pt.r);
    for (const s of smokeStops) {
      grad.addColorStop(s.off, `rgba(${s.r}, ${s.g}, ${s.b}, ${a * s.alpha})`);
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 가장자리에서 직각으로 잘리지 않게 4면 부드럽게 마감
  featherEdges(ctx, x, y, width, height, Math.min(width, height) * 0.14);

  ctx.restore();
}

// ─── 통합 entry ──────────────────────────────────────────────────

export function drawCustomVisualizer(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length === 0) return;
  ctx.save();
  ctx.globalAlpha = (comp.opacity ?? 1) * (ctx.globalAlpha ?? 1);
  switch (comp.visualizerStyle) {
    case 'wave-time':       drawWaveTime(ctx, comp, amplitudes, x, y, width, height); break;
    case 'mirror':          drawMirror(ctx, comp, amplitudes, x, y, width, height); break;
    case 'mirror-fill':     drawMirrorFill(ctx, comp, amplitudes, x, y, width, height); break;
    case 'aurora-hills':    drawAuroraHills(ctx, comp, amplitudes, x, y, width, height); break;
    case 'capsule-bars':    drawCapsuleBars(ctx, comp, amplitudes, x, y, width, height); break;
    case 'reflection-bars': drawReflectionBars(ctx, comp, amplitudes, x, y, width, height); break;
    case 'peak-dots':       drawPeakDots(ctx, comp, amplitudes, x, y, width, height); break;
    case 'smoke':           drawSmoke(ctx, comp, amplitudes, x, y, width, height); break;
  }
  ctx.restore();
}

// custom (canvas 직접 그리기) 스타일 목록 — AM 내장(bars/line)과 구분용.
export const CUSTOM_VISUALIZER_STYLES = [
  'wave-time', 'mirror', 'mirror-fill',
  'aurora-hills', 'capsule-bars', 'reflection-bars', 'peak-dots', 'smoke',
];
export function isCustomStyle(style) {
  return CUSTOM_VISUALIZER_STYLES.includes(style);
}

// 내부 helper export (테스트용)
export { strokeSmoothPath };
