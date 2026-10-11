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

// ─── 프레임 사이에 이어지는 상태 (peak-hold · 파티클 · 스프링 등) ──
//
// comp 객체에 매달면 안 된다 — 에디터는 프레임마다 `{ ...cur, opacity: 1 }` 사본을 넘겨서
// 거기 단 값은 다음 프레임에 사라진다(Studio 는 원본을 넘겨서 남는다 → 미리보기 ≠ 녹화).
// 그래서 컴포넌트 id 로 따로 들고 있는다. 스타일이 바뀌면 새로 시작.
const _styleState = new Map();
function stateOf(comp, style) {
  const key = comp.id ?? comp;
  let st = _styleState.get(key);
  if (!st || st.style !== style) {
    st = { style, f: 0 };
    _styleState.set(key, st);
  }
  return st;
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
  const st = stateOf(comp, 'peak-dots');
  if (!Array.isArray(st.peaks) || st.peaks.length !== N) {
    st.peaks = new Array(N).fill(0);
  }
  const peaks = st.peaks;
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

  // 파티클 풀
  const st = stateOf(comp, 'smoke');
  if (!Array.isArray(st.parts)) st.parts = [];
  const parts = st.parts;
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

// ═══ Style 9~18: 부드럽고 역동적인 스타일 (2026-10-12) ════════════════
//
// 공통 원칙 — 날것의 진폭을 그대로 그리지 않는다. 올라갈 땐 빠르게, 내려올 땐 천천히
// 따라가게(easeToward) 하거나 스프링으로 받아서(springToward) 튀지 않고 출렁이게 한다.
// 시간은 프레임마다 쌓는 위상(st.ph)으로 센다 — 에디터·녹화 모두 프레임마다 한 번 그리므로
// 같은 움직임이고, 속도 슬라이더를 움직여도 위상이 튀지 않는다.

// 스타일별 세부 조정 값. 에디터 속성 패널이 이 표를 그대로 슬라이더로 만든다 —
// 여기에 한 줄 넣으면 슬라이더가 생기고, 그리는 코드는 paramsOf(comp, style)(key) 로 읽는다.
// def 는 저장된 값이 없을 때 쓰는 기본값(= 처음 만들었을 때의 모양).
const GAIN = (def = 1) => ({ key: 'vzGain', label: '크기 (민감도)', min: 0.2, max: 3, step: 0.05, def });
const ATTACK = (def) => ({ key: 'vzAttack', label: '반응 속도', min: 0.03, max: 1, step: 0.01, def });
const RELEASE = (def) => ({ key: 'vzRelease', label: '잔향 (작을수록 길게)', min: 0.01, max: 0.5, step: 0.01, def });
const SOFT = (def) => ({ key: 'vzSoft', label: '곡선 부드러움', min: 0, max: 8, step: 1, def });
const MOTION = (label, def = 1, max = 4) => ({ key: 'vzMotion', label, min: 0, max, step: 0.05, def });
const BOUNCE = (def) => ({ key: 'vzBounce', label: '탄력 (빠르기)', min: 0.02, max: 0.4, step: 0.01, def });
const DAMP = (def) => ({ key: 'vzDamp', label: '출렁임 지속', min: 0.5, max: 0.97, step: 0.01, def });

export const STYLE_PARAMS = {
  'silk-ribbon': [
    GAIN(), ATTACK(0.3), RELEASE(0.07), SOFT(3), MOTION('흐름 속도'),
    { key: 'silkLayers', label: '리본 겹 수', min: 1, max: 6, step: 1, def: 3 },
    { key: 'silkWave', label: '굽이 크기', min: 0, max: 3, step: 0.05, def: 1 },
    { key: 'silkSpread', label: '겹 사이 차이', min: 0, max: 0.5, step: 0.01, def: 0.22 },
  ],
  'liquid-wave': [
    GAIN(), BOUNCE(0.09), DAMP(0.86), SOFT(2),
    { key: 'liquidSpread', label: '옆으로 번짐', min: 0, max: 0.24, step: 0.01, def: 0.12 },
    { key: 'liquidSwell', label: '너울 크기', min: 0, max: 4, step: 0.1, def: 1 },
    MOTION('너울 속도'),
    { key: 'liquidGhost', label: '뒷물결 진하기', min: 0, max: 1, step: 0.05, def: 0.5 },
  ],
  'echo-trails': [
    GAIN(), ATTACK(0.35), RELEASE(0.1), SOFT(2),
    { key: 'echoCount', label: '잔상 줄 수', min: 2, max: 20, step: 1, def: 9 },
    { key: 'echoEvery', label: '잔상 간격 (프레임)', min: 1, max: 12, step: 1, def: 4 },
    { key: 'echoRise', label: '위로 퍼지는 폭', min: 0.2, max: 3, step: 0.05, def: 1 },
    { key: 'echoShrink', label: '원근 (멀수록 작게)', min: 0, max: 0.1, step: 0.005, def: 0.05 },
  ],
  'neon-strings': [
    GAIN(), ATTACK(0.45), RELEASE(0.06),
    { key: 'stringCount', label: '줄 수', min: 2, max: 10, step: 1, def: 5 },
    { key: 'stringNodes', label: '마디 수 (첫 줄)', min: 1, max: 6, step: 1, def: 2 },
    MOTION('떨림 속도'),
  ],
  'spring-bars': [
    GAIN(), BOUNCE(0.2), DAMP(0.74),
    { key: 'barCount', label: '막대 수', min: 8, max: 120, step: 1, def: 48 },
    { key: 'barFill', label: '막대 굵기', min: 0.1, max: 0.95, step: 0.01, def: 0.5 },
  ],
  'dot-matrix': [
    GAIN(), ATTACK(0.4), RELEASE(0.09),
    { key: 'dotCell', label: '점 간격', min: 10, max: 60, step: 1, def: 24, suffix: 'px' },
    { key: 'dotSize', label: '점 크기', min: 0.15, max: 0.5, step: 0.01, def: 0.3 },
    { key: 'dotGhost', label: '꺼진 점 밝기', min: 0, max: 0.3, step: 0.01, def: 0.07 },
  ],
  'floating-orbs': [
    GAIN(), BOUNCE(0.1), DAMP(0.8),
    { key: 'orbCount', label: '빛망울 수', min: 4, max: 40, step: 1, def: 14 },
    { key: 'orbSize', label: '빛망울 크기', min: 0.3, max: 3, step: 0.05, def: 1 },
    MOTION('떠다니는 속도'),
  ],
  'pulse-rings': [
    GAIN(), ATTACK(0.4), RELEASE(0.09), SOFT(3),
    { key: 'ringSense', label: '박자 민감도', min: 0.3, max: 3, step: 0.05, def: 1 },
    { key: 'ringSpeed', label: '링 퍼지는 속도', min: 0.3, max: 3, step: 0.05, def: 1 },
    { key: 'ringLife', label: '링 지속', min: 0.3, max: 3, step: 0.05, def: 1 },
    { key: 'coreSize', label: '중심 크기', min: 0.4, max: 2, step: 0.05, def: 1 },
  ],
  'radial-bloom': [
    GAIN(), ATTACK(0.3), RELEASE(0.07), SOFT(3),
    { key: 'bloomPetals', label: '꽃잎 수', min: 1, max: 8, step: 1, def: 3 },
    { key: 'bloomInner', label: '안쪽 크기', min: 0.05, max: 0.7, step: 0.01, def: 0.3 },
    { key: 'bloomLayers', label: '겹 수', min: 1, max: 3, step: 1, def: 2 },
    MOTION('회전 속도', 1, 6),
  ],
  'radial-bars': [
    GAIN(), ATTACK(0.45), RELEASE(0.1), SOFT(1),
    { key: 'radialCount', label: '막대 수', min: 16, max: 180, step: 2, def: 72 },
    { key: 'radialInner', label: '안쪽 원 크기', min: 0.1, max: 0.8, step: 0.01, def: 0.36 },
    { key: 'radialFill', label: '막대 굵기', min: 0.1, max: 0.95, step: 0.01, def: 0.55 },
    MOTION('회전 속도', 1, 6),
  ],
};

// comp 에 저장된 값이 없으면(또는 숫자가 아니면) 그 스타일의 기본값.
function paramsOf(comp, style) {
  const defs = STYLE_PARAMS[style] || [];
  return (key) => {
    const v = comp[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const d = defs.find((p) => p.key === key);
    return d ? d.def : 0;
  };
}

// 진폭 배열을 M 칸으로 다시 나눈다 (선형 보간). Mode 설정과 무관하게 모양을 일정하게.
// soft = 옆 칸과 섞는 횟수 — 곡선 스타일은 이걸 걸어야 톱니가 아니라 물결이 된다.
// gain = 크기 배율 (1.25 에서 자른다 — 상자 밖으로 튀어나가지 않게).
function resample(amps, M, soft = 0, gain = 1) {
  const N = amps.length;
  let out = new Float32Array(M);
  if (N === 0) return out;
  for (let i = 0; i < M; i++) {
    if (N === 1) { out[i] = amps[0]; continue; }
    const p = (i / Math.max(1, M - 1)) * (N - 1);
    const a = Math.floor(p);
    const b = Math.min(N - 1, a + 1);
    out[i] = amps[a] + (amps[b] - amps[a]) * (p - a);
  }
  for (let k = 0; k < soft; k++) {
    const next = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      next[i] = out[Math.max(0, i - 1)] * 0.25 + out[i] * 0.5 + out[Math.min(M - 1, i + 1)] * 0.25;
    }
    out = next;
  }
  if (gain !== 1) for (let i = 0; i < M; i++) out[i] = Math.min(1.25, out[i] * gain);
  return out;
}

// 빠르게 오르고 천천히 내리는 따라가기. st[key] 에 이어서 보관.
function easeToward(st, key, target, attack, release) {
  let cur = st[key];
  if (!cur || cur.length !== target.length) cur = st[key] = new Float32Array(target.length);
  for (let i = 0; i < target.length; i++) {
    const d = target[i] - cur[i];
    cur[i] += d * (d > 0 ? attack : release);
  }
  return cur;
}

// 스프링 — 목표를 살짝 지나쳤다 돌아온다(탄력). spread > 0 이면 옆 칸과 이어져 물결처럼 번진다.
function springToward(st, key, target, stiffness, damping, spread = 0) {
  const n = target.length;
  let pos = st[key];
  let vel = st[`${key}V`];
  if (!pos || pos.length !== n) {
    pos = st[key] = new Float32Array(n);
    vel = st[`${key}V`] = new Float32Array(n);
  }
  for (let i = 0; i < n; i++) {
    let force = (target[i] - pos[i]) * stiffness;
    if (spread > 0) {
      const l = pos[i > 0 ? i - 1 : i];
      const r = pos[i < n - 1 ? i + 1 : i];
      force += (l + r - 2 * pos[i]) * spread;
    }
    vel[i] = (vel[i] + force) * damping;
  }
  for (let i = 0; i < n; i++) pos[i] += vel[i];
  return pos;
}

// 구간 평균 (from~to 는 0~1 비율). 저음·중음·고음 세기를 뽑을 때.
function bandLevel(amps, from, to) {
  const N = amps.length;
  if (!N) return 0;
  const a = Math.max(0, Math.min(N - 1, Math.floor(from * N)));
  const b = Math.max(a + 1, Math.min(N, Math.ceil(to * N)));
  let sum = 0;
  for (let i = a; i < b; i++) sum += amps[i];
  return sum / (b - a);
}

// 색 한 점 — Gradient 모드면 stops 를 t(0~1) 위치에서 보간, 아니면 단색. [r, g, b].
function colorAt(comp, t) {
  if (comp.colorMode === 'gradient' && Array.isArray(comp.gradientStops) && comp.gradientStops.length >= 2) {
    const stops = [...comp.gradientStops].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const p = Math.max(0, Math.min(1, t)) * 100;
    if (p <= (stops[0].position ?? 0)) return hexToRgbArr(stops[0].color);
    for (let i = 0; i < stops.length - 1; i++) {
      const p0 = stops[i].position ?? 0;
      const p1 = stops[i + 1].position ?? 0;
      if (p <= p1) {
        const k = p1 > p0 ? (p - p0) / (p1 - p0) : 0;
        const c0 = hexToRgbArr(stops[i].color);
        const c1 = hexToRgbArr(stops[i + 1].color);
        return [
          Math.round(c0[0] + (c1[0] - c0[0]) * k),
          Math.round(c0[1] + (c1[1] - c0[1]) * k),
          Math.round(c0[2] + (c1[2] - c0[2]) * k),
        ];
      }
    }
    return hexToRgbArr(stops[stops.length - 1].color);
  }
  return hexToRgbArr(comp.color || '#D4AF37');
}

function rgbaOf(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, alpha))})`;
}

// 닫힌 부드러운 곡선 (Catmull-Rom, 끝과 처음이 이음새 없이 이어진다) — 원형 스타일용.
function closedSmoothPath(ctx, pts) {
  const n = pts.length;
  if (n < 3) return;
  const T = 1 / 6;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) * T, p1.y + (p2.y - p0.y) * T,
      p2.x - (p3.x - p1.x) * T, p2.y - (p3.y - p1.y) * T,
      p2.x, p2.y,
    );
  }
  ctx.closePath();
}

// 0~1 을 0→1→0 으로 접는다. 원 둘레에 저음→고음→저음 을 대칭으로 깔 때.
function fold(u) {
  const m = ((u % 1) + 1) % 1;
  return 1 - Math.abs(m * 2 - 1);
}

// 배열 e 를 0~1 위치 f 에서 읽는다 (보간).
function sampleAt(e, f) {
  const idx = Math.max(0, Math.min(1, f)) * (e.length - 1);
  const a = Math.floor(idx);
  const b = Math.min(e.length - 1, a + 1);
  return e[a] + (e[b] - e[a]) * (idx - a);
}

// ─── Style 9: Silk Ribbon (겹겹이 흐르는 비단 리본) ─────────────────

export function drawSilkRibbon(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'silk-ribbon');
  const P = paramsOf(comp, 'silk-ribbon');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const M = 56;
  const e = easeToward(st, 'e', resample(amplitudes, M, P('vzSoft'), P('vzGain')), P('vzAttack'), P('vzRelease'));
  const bass = bandLevel(e, 0, 0.2);
  const cy = y + height / 2;
  const maxAmp = height * 0.42;
  const fillA = comp.fillOpacity ?? 0.3;
  const style = buildStrokeStyle(ctx, comp, x, y, width, height);
  const LAYERS = Math.max(1, Math.round(P('silkLayers')));
  const spread = P('silkSpread');
  const wave = P('silkWave');

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let L = LAYERS - 1; L >= 0; L--) {
    const phase = st.ph * 0.018 * (1 + L * 0.4) + L * 1.7;
    const top = new Array(M);
    const bottom = new Array(M);
    const thin = Math.max(0.15, 1 - L * spread);
    for (let i = 0; i < M; i++) {
      const t = i / (M - 1);
      const taper = Math.pow(Math.sin(Math.PI * t), 0.6);   // 양 끝은 가늘게
      const mid = cy + Math.sin(t * Math.PI * 2.4 + phase) * height * 0.07 * wave * (0.5 + bass * 1.5);
      const half = (1.5 + e[i] * maxAmp * thin) * taper;
      const px = x + t * width;
      top[i] = { x: px, y: mid - half };
      bottom[M - 1 - i] = { x: px, y: mid + half };
    }
    ctx.beginPath();
    strokeSmoothPath(ctx, top, 1);
    ctx.lineTo(bottom[0].x, bottom[0].y);
    for (let i = 0; i < M - 1; i++) {
      const p0 = bottom[i - 1] || bottom[i];
      const p1 = bottom[i];
      const p2 = bottom[i + 1];
      const p3 = bottom[i + 2] || p2;
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) * 0.5, p1.y + (p2.y - p0.y) * 0.5,
        p2.x - (p3.x - p1.x) * 0.5, p2.y - (p3.y - p1.y) * 0.5,
        p2.x, p2.y,
      );
    }
    ctx.closePath();
    ctx.fillStyle = style;
    ctx.globalAlpha = fillA * Math.max(0.2, 1 - L * 0.25);
    ctx.shadowBlur = 0;
    ctx.fill();

    // 맨 앞 리본만 빛나는 윤곽선
    if (L === 0) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = style;
      ctx.lineWidth = comp.lineWidth ?? 3;
      applyGlow(ctx, comp);
      ctx.beginPath();
      strokeSmoothPath(ctx, top, 1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ─── Style 10: Liquid Wave (차올라 출렁이는 액체) ───────────────────

export function drawLiquidWave(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'liquid-wave');
  const P = paramsOf(comp, 'liquid-wave');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const M = 44;
  const surf = springToward(st, 's', resample(amplitudes, M, P('vzSoft'), P('vzGain')), P('vzBounce'), P('vzDamp'), P('liquidSpread'));
  const ghost = easeToward(st, 'g', surf, 0.12, 0.12);        // 한 박자 늦게 따라오는 뒷물결
  const baseline = y + height;
  const maxAmp = height * 0.8;
  const fillA = comp.fillOpacity ?? 0.3;
  const style = buildStrokeStyle(ctx, comp, x, y, width, height);
  const swellAmt = height * 0.018 * P('liquidSwell');

  const curve = (src, lift, drift) => {
    const pts = new Array(M);
    for (let i = 0; i < M; i++) {
      const t = i / (M - 1);
      const swell = Math.sin(t * Math.PI * 3 + st.ph * drift) * swellAmt;   // 잔잔한 너울
      const v = Math.max(0, Math.min(1.2, src[i]));
      pts[i] = { x: x + t * width, y: Math.max(y, baseline - lift - v * maxAmp - swell) };
    }
    return pts;
  };
  const fillUnder = (pts, alpha) => {
    ctx.beginPath();
    strokeSmoothPath(ctx, pts, 1);
    ctx.lineTo(x + width, baseline);
    ctx.lineTo(x, baseline);
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fill();
  };

  ctx.save();
  ctx.fillStyle = style;
  const ghostA = P('liquidGhost');
  if (ghostA > 0) fillUnder(curve(ghost, height * 0.07, -0.02), fillA * ghostA);
  const front = curve(surf, height * 0.04, 0.03);
  fillUnder(front, fillA);

  ctx.globalAlpha = 1;
  ctx.strokeStyle = style;
  ctx.lineWidth = comp.lineWidth ?? 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  applyGlow(ctx, comp);
  ctx.beginPath();
  strokeSmoothPath(ctx, front, 1);
  ctx.stroke();
  ctx.restore();
}

// ─── Style 11: Echo Trails (곡선이 잔상을 남기며 위로 흘러간다) ──────

export function drawEchoTrails(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'echo-trails');
  const P = paramsOf(comp, 'echo-trails');
  st.f++;
  const M = 48;
  const EVERY = Math.max(1, Math.round(P('echoEvery')));   // 몇 프레임마다 잔상 한 줄
  const KEEP = Math.max(1, Math.round(P('echoCount')));
  const e = easeToward(st, 'e', resample(amplitudes, M, P('vzSoft'), P('vzGain')), P('vzAttack'), P('vzRelease'));
  if (!st.hist) st.hist = [];
  if (st.f % EVERY === 0) st.hist.unshift(Float32Array.from(e));
  while (st.hist.length > KEEP) st.hist.pop();
  const baseline = y + height;
  const maxAmp = height * 0.5;
  const step = ((height * 0.45) / KEEP) * P('echoRise');
  const shrinkPer = P('echoShrink');
  const between = (st.f % EVERY) / EVERY;     // 줄 사이를 매끄럽게 이어 주는 보간
  const style = buildStrokeStyle(ctx, comp, x, y, width, height);
  const lw = comp.lineWidth ?? 3;

  const pointsOf = (src, age) => {
    const lift = age * step;
    const shrink = Math.max(0.1, 1 - age * shrinkPer);
    const inset = (width * (1 - shrink)) / 2;
    const pts = new Array(M);
    for (let i = 0; i < M; i++) {
      const t = i / (M - 1);
      pts[i] = { x: x + inset + t * width * shrink, y: baseline - lift - src[i] * maxAmp * shrink };
    }
    return pts;
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style;
  // 오래된 줄부터 (뒤 → 앞)
  for (let j = st.hist.length - 1; j >= 0; j--) {
    const age = j + 1 + between;
    const alpha = Math.pow(Math.max(0, 1 - age / (KEEP + 1)), 1.6);
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha * 0.8;
    ctx.lineWidth = Math.max(1, lw * (1 - age / (KEEP + 2)));
    ctx.shadowBlur = 0;
    ctx.beginPath();
    strokeSmoothPath(ctx, pointsOf(st.hist[j], age), 1);
    ctx.stroke();
  }
  // 지금 곡선 — 채움 + 글로우
  const now = pointsOf(e, 0);
  ctx.beginPath();
  strokeSmoothPath(ctx, now, 1);
  ctx.lineTo(x + width, baseline);
  ctx.lineTo(x, baseline);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.globalAlpha = comp.fillOpacity ?? 0.3;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = lw;
  applyGlow(ctx, comp);
  ctx.beginPath();
  strokeSmoothPath(ctx, now, 1);
  ctx.stroke();
  ctx.restore();
}

// ─── Style 12: Neon Strings (대역마다 떨리는 현) ────────────────────

export function drawNeonStrings(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'neon-strings');
  const P = paramsOf(comp, 'neon-strings');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const S = Math.max(1, Math.round(P('stringCount')));
  const gain = P('vzGain');
  const raw = new Float32Array(S);
  for (let s = 0; s < S; s++) raw[s] = Math.min(1.25, bandLevel(amplitudes, s / S, (s + 1) / S) * gain);
  const e = easeToward(st, 'e', raw, P('vzAttack'), P('vzRelease'));
  const gapY = height / (S + 1);
  const SEG = 64;
  const lw = comp.lineWidth ?? 3;
  const blurA = comp.fillOpacity ?? 0.3;
  const nodes0 = Math.max(1, Math.round(P('stringNodes')));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let s = 0; s < S; s++) {
    const ys = y + gapY * (s + 1);
    const amp = Math.min(gapY * 0.95, e[s] * gapY * 2.2);
    const nodes = nodes0 + s;                               // 높은 줄일수록 마디가 많다
    const swing = Math.cos(st.ph * (0.22 + s * 0.03) + s * 1.3);
    const rgb = colorAt(comp, S > 1 ? s / (S - 1) : 0);
    const shape = (t) => Math.sin(Math.PI * t * nodes) * Math.sin(Math.PI * t);

    // 떨림의 잔상 — 위아래 끝자리 사이를 옅게 채운다
    if (amp > 0.5 && blurA > 0) {
      ctx.beginPath();
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const py = ys - Math.abs(shape(t)) * amp;
        if (i === 0) ctx.moveTo(x, py); else ctx.lineTo(x + t * width, py);
      }
      for (let i = SEG; i >= 0; i--) {
        const t = i / SEG;
        ctx.lineTo(x + t * width, ys + Math.abs(shape(t)) * amp);
      }
      ctx.closePath();
      ctx.shadowBlur = 0;
      ctx.fillStyle = rgbaOf(rgb, blurA * 0.5);
      ctx.fill();
    }

    // 현
    ctx.beginPath();
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const py = ys + shape(t) * amp * swing;
      if (i === 0) ctx.moveTo(x, py); else ctx.lineTo(x + t * width, py);
    }
    ctx.strokeStyle = rgbaOf(rgb, 1);
    ctx.lineWidth = lw;
    applyGlow(ctx, comp);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── Style 13: Spring Bars (탄력 있게 튀는 상하 대칭 둥근 막대) ──────

export function drawSpringBars(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'spring-bars');
  const P = paramsOf(comp, 'spring-bars');
  const K = Math.max(2, Math.round(P('barCount')));
  const v = springToward(st, 's', resample(amplitudes, K, 0, P('vzGain')), P('vzBounce'), P('vzDamp'));
  const slot = width / K;
  const barW = Math.max(1, slot * P('barFill'));
  const cy = y + height / 2;
  const maxHalf = height * 0.48;

  ctx.save();
  ctx.fillStyle = buildStrokeStyle(ctx, comp, x, y, width, height);
  applyGlow(ctx, comp);
  for (let i = 0; i < K; i++) {
    const half = Math.max(barW / 2, Math.min(maxHalf, Math.max(0, v[i]) * maxHalf));
    roundRectPath(ctx, x + i * slot + (slot - barW) / 2, cy - half, barW, half * 2, barW / 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Style 14: Dot Matrix (점들이 차오르는 격자) ────────────────────

export function drawDotMatrix(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'dot-matrix');
  const P = paramsOf(comp, 'dot-matrix');
  const K = Math.max(2, Math.min(160, Math.round(width / Math.max(4, P('dotCell')))));
  const cell = width / K;
  const R = Math.max(1, Math.min(80, Math.floor(height / cell)));
  const e = easeToward(st, 'e', resample(amplitudes, K, 0, P('vzGain')), P('vzAttack'), P('vzRelease'));
  const baseR = cell * P('dotSize');
  const ghost = P('dotGhost');

  ctx.save();
  for (let i = 0; i < K; i++) {
    const cx = x + (i + 0.5) * cell;
    const lit = Math.min(1, e[i]) * R;
    const rgb = colorAt(comp, K > 1 ? i / (K - 1) : 0);
    const topRow = Math.min(R - 1, Math.floor(lit));
    for (let r = 0; r < R; r++) {
      const a = Math.max(0, Math.min(1, lit - r));          // 맨 위 점은 서서히 켜진다
      if (a <= 0 && ghost <= 0) continue;
      const cyDot = y + height - (r + 0.5) * cell;
      const isTop = r === topRow && a > 0;
      ctx.shadowBlur = 0;
      if (isTop) applyGlow(ctx, comp);                       // 글로우는 맨 위 점만 (값비싸서)
      ctx.fillStyle = rgbaOf(rgb, a > 0 ? a * (1 - 0.45 * (r / R)) : ghost);
      ctx.beginPath();
      ctx.arc(cx, cyDot, baseR * (a > 0 ? 0.7 + 0.3 * a : 0.55), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ─── Style 15: Floating Orbs (음에 맞춰 부풀며 떠다니는 빛망울) ──────

export function drawFloatingOrbs(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'floating-orbs');
  const P = paramsOf(comp, 'floating-orbs');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const K = Math.max(1, Math.round(P('orbCount')));
  const e = springToward(st, 's', resample(amplitudes, K, 0, P('vzGain')), P('vzBounce'), P('vzDamp'));
  const slot = width / K;
  const unit = Math.min(slot, height * 0.35) * P('orbSize');
  const intensity = comp.fillOpacity ?? 0.6;
  const glow = comp.glow ?? 0;

  ctx.save();
  for (let i = 0; i < K; i++) {
    const v = Math.max(0, Math.min(1.2, e[i]));
    const r = Math.max(2, Math.min(height * 0.48, unit * (0.32 + v * 1.1)));
    const cx = x + (i + 0.5) * slot + Math.sin(st.ph * 0.011 + i * 2.1) * slot * 0.22;
    const floatY = Math.sin(st.ph * 0.017 + i * 1.7) * height * 0.04;
    const cy = Math.max(y + r, Math.min(y + height - r, y + height - r - v * (height - 2 * r) * 0.85 + floatY));
    const rgb = colorAt(comp, K > 1 ? i / (K - 1) : 0);
    const a = (0.3 + 0.7 * Math.min(1, v)) * intensity;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, rgbaOf(rgb, a));
    grad.addColorStop(0.45, rgbaOf(rgb, a * 0.55));
    grad.addColorStop(1, rgbaOf(rgb, 0));
    ctx.fillStyle = grad;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // 가운데 심지 — 여기에만 글로우
    if (glow > 0) {
      ctx.shadowColor = comp.glowColor || '#D4AF37';
      ctx.shadowBlur = glow;
    }
    ctx.fillStyle = rgbaOf(rgb, Math.min(1, a * 1.4));
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1.5, r * 0.14), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Style 16: Pulse Rings (저음마다 퍼져 나가는 동심원 + 숨 쉬는 중심) ─

export function drawPulseRings(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'pulse-rings');
  const P = paramsOf(comp, 'pulse-rings');
  const M = 40;
  const gain = P('vzGain');
  const e = easeToward(st, 'e', resample(amplitudes, M, P('vzSoft'), gain), P('vzAttack'), P('vzRelease'));
  const bass = Math.min(1.25, bandLevel(amplitudes, 0, 0.15) * gain);
  st.bass = (st.bass ?? 0) + (bass - (st.bass ?? 0)) * (bass > (st.bass ?? 0) ? 0.5 : 0.1);
  st.avg = (st.avg ?? 0) + (bass - (st.avg ?? 0)) * 0.03;
  if (!st.rings) st.rings = [];
  st.cool = Math.max(0, (st.cool ?? 0) - 1);
  // 저음이 평소보다 확 올라온 순간 = 박자 → 링 하나 내보낸다
  const sense = Math.max(0.05, P('ringSense'));
  if (st.cool === 0 && bass > 0.12 / sense && bass > st.avg * (1 + 0.3 / sense) + 0.04 / sense) {
    st.rings.push({ r: 0, life: 1, power: Math.min(1, bass * 1.4) });
    st.cool = 12;
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  const R = Math.min(width, height) / 2;
  const lw = comp.lineWidth ?? 3;
  const coreR = Math.min(R * 0.8, R * (0.26 + st.bass * 0.1) * P('coreSize'));
  const speed = P('ringSpeed');
  const lifeMul = Math.max(0.05, P('ringLife'));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = st.rings.length - 1; i >= 0; i--) {
    const ring = st.rings[i];
    ring.r += ((1 - ring.r) * 0.035 + 0.004) * speed;
    ring.life -= 0.018 / lifeMul;
    if (ring.life <= 0 || ring.r >= 1) { st.rings.splice(i, 1); continue; }
    const rad = coreR + ring.r * Math.max(0, R - coreR - lw);
    ctx.strokeStyle = rgbaOf(colorAt(comp, ring.r), ring.life * ring.life * (0.4 + 0.6 * ring.power));
    ctx.lineWidth = Math.max(0.75, lw * ring.life);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 중심 — 둘레에 스펙트럼을 대칭으로 두른 닫힌 곡선
  const N = 72;
  const pts = new Array(N);
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const rad = coreR + Math.min(1, sampleAt(e, fold(u))) * R * 0.2;
    const ang = u * Math.PI * 2 - Math.PI / 2;
    pts[i] = { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
  }
  const core = rgbaOf(colorAt(comp, 0), 1);
  ctx.beginPath();
  closedSmoothPath(ctx, pts);
  ctx.fillStyle = core;
  ctx.globalAlpha = comp.fillOpacity ?? 0.3;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = core;
  ctx.lineWidth = lw;
  applyGlow(ctx, comp);
  ctx.stroke();
  ctx.restore();
}

// ─── Style 17: Radial Bloom (천천히 돌며 피어나는 꽃잎 곡선) ─────────

export function drawRadialBloom(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 2 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'radial-bloom');
  const P = paramsOf(comp, 'radial-bloom');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const M = 32;
  const e = easeToward(st, 'e', resample(amplitudes, M, P('vzSoft'), P('vzGain')), P('vzAttack'), P('vzRelease'));
  const cx = x + width / 2;
  const cy = y + height / 2;
  const R = Math.min(width, height) / 2;
  const lw = comp.lineWidth ?? 3;
  const fillA = comp.fillOpacity ?? 0.3;
  const N = 96;
  const PETALS = Math.max(1, Math.round(P('bloomPetals')));
  const inner = P('bloomInner');
  const LAYERS = Math.max(1, Math.round(P('bloomLayers')));

  const layer = (spin, scale, alphaMul, stroke) => {
    const pts = new Array(N);
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const v = Math.min(1, sampleAt(e, fold(u * PETALS)));
      const rad = Math.max(1, Math.min(R - lw, (R * inner + v * R * (0.96 - inner)) * scale));
      const ang = u * Math.PI * 2 + spin;
      pts[i] = { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
    }
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, rgbaOf(colorAt(comp, 0), 1));
    grad.addColorStop(0.5, rgbaOf(colorAt(comp, 0.5), 1));
    grad.addColorStop(1, rgbaOf(colorAt(comp, 1), 1));
    ctx.beginPath();
    closedSmoothPath(ctx, pts);
    ctx.shadowBlur = 0;
    ctx.fillStyle = grad;
    ctx.globalAlpha = fillA * alphaMul;
    ctx.fill();
    if (stroke) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      applyGlow(ctx, comp);
      ctx.stroke();
    }
  };

  ctx.save();
  // 뒤 겹부터 — 겹마다 번갈아 반대로 돌고 조금씩 작다
  for (let L = LAYERS - 1; L >= 1; L--) {
    const dir = L % 2 ? -1 : 1;
    layer(dir * st.ph * 0.0026 * (1 + L * 0.2) + (Math.PI / PETALS) * L, 1 - L * 0.18, 0.7, false);
  }
  layer(st.ph * 0.004, 1, 1, true);
  ctx.restore();
}

// ─── Style 18: Radial Bars (원형으로 두른 둥근 막대 — 햇살) ──────────

export function drawRadialBars(ctx, comp, amplitudes, x, y, width, height) {
  if (!amplitudes || amplitudes.length < 1 || width <= 0 || height <= 0) return;
  const st = stateOf(comp, 'radial-bars');
  const P = paramsOf(comp, 'radial-bars');
  st.ph = (st.ph ?? 0) + P('vzMotion');
  const M = 36;
  const e = easeToward(st, 'e', resample(amplitudes, M, P('vzSoft'), P('vzGain')), P('vzAttack'), P('vzRelease'));
  const bass = bandLevel(e, 0, 0.2);
  const cx = x + width / 2;
  const cy = y + height / 2;
  const R = Math.min(width, height) / 2;
  const K = Math.max(3, Math.round(P('radialCount')));
  const r0 = R * Math.min(0.9, P('radialInner') + bass * 0.05);     // 저음에 맞춰 안쪽 원이 숨 쉰다
  const barW = Math.max(1, ((Math.PI * 2 * r0) / K) * P('radialFill'));
  const maxLen = Math.max(0, R - r0 - barW);
  const spin = st.ph * 0.0025 - Math.PI / 2;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = barW;
  applyGlow(ctx, comp);
  for (let i = 0; i < K; i++) {
    const u = i / K;
    const f = fold(u);
    const len = Math.max(0.01, Math.min(1, sampleAt(e, f)) * maxLen);
    const ang = u * Math.PI * 2 + spin;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    ctx.strokeStyle = rgbaOf(colorAt(comp, f), 1);
    ctx.beginPath();
    ctx.moveTo(cx + dx * r0, cy + dy * r0);
    ctx.lineTo(cx + dx * (r0 + len), cy + dy * (r0 + len));
    ctx.stroke();
  }
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
    case 'silk-ribbon':     drawSilkRibbon(ctx, comp, amplitudes, x, y, width, height); break;
    case 'liquid-wave':     drawLiquidWave(ctx, comp, amplitudes, x, y, width, height); break;
    case 'echo-trails':     drawEchoTrails(ctx, comp, amplitudes, x, y, width, height); break;
    case 'neon-strings':    drawNeonStrings(ctx, comp, amplitudes, x, y, width, height); break;
    case 'spring-bars':     drawSpringBars(ctx, comp, amplitudes, x, y, width, height); break;
    case 'dot-matrix':      drawDotMatrix(ctx, comp, amplitudes, x, y, width, height); break;
    case 'floating-orbs':   drawFloatingOrbs(ctx, comp, amplitudes, x, y, width, height); break;
    case 'pulse-rings':     drawPulseRings(ctx, comp, amplitudes, x, y, width, height); break;
    case 'radial-bloom':    drawRadialBloom(ctx, comp, amplitudes, x, y, width, height); break;
    case 'radial-bars':     drawRadialBars(ctx, comp, amplitudes, x, y, width, height); break;
  }
  ctx.restore();
}

// custom (canvas 직접 그리기) 스타일 목록 — AM 내장(bars/line)과 구분용.
export const CUSTOM_VISUALIZER_STYLES = [
  'wave-time', 'mirror', 'mirror-fill',
  'aurora-hills', 'capsule-bars', 'reflection-bars', 'peak-dots', 'smoke',
  'silk-ribbon', 'liquid-wave', 'echo-trails', 'neon-strings', 'spring-bars',
  'dot-matrix', 'floating-orbs', 'pulse-rings', 'radial-bloom', 'radial-bars',
];
// 에디터 속성 패널이 어떤 슬라이더를 보여 줄지 — Line Width / Fill Opacity 를 쓰는 스타일.
export const LINE_WIDTH_STYLES = [
  'silk-ribbon', 'liquid-wave', 'echo-trails', 'neon-strings', 'pulse-rings', 'radial-bloom',
];
export const FILL_OPACITY_STYLES = [
  'silk-ribbon', 'liquid-wave', 'echo-trails', 'neon-strings', 'floating-orbs', 'pulse-rings', 'radial-bloom',
];
export function isCustomStyle(style) {
  return CUSTOM_VISUALIZER_STYLES.includes(style);
}

// 내부 helper export (테스트용)
export { strokeSmoothPath };
