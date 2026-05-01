// Phase 4-D-3-C: Clock 렌더러.
//
// 4 designs:
//   legacy   → 옛 index.html 의 7-segment 커스텀 (segment hexagonal bar, bevel=4)
//   neon     → 흐릿한 "8:88" 배경 + 밝은 글로우 시간
//   flip     → 매 초 fade out → fade in (1초 cycle)
//   minimal  → sine pulse scale (1.0 → 1.05 → 1.0)
//
// canvas-only — DOM 사용 X. 미리보기 = 녹화 결과 100% 일치.
//
// 사용:
//   import { drawClock, formatTime } from './clock-renderer.js';
//   drawClock(ctx, clockComp, currentSec);
//
// 곡당 리셋: 호출자가 currentSec 을 넘겨줌 (audio.currentTime 권장).

// ─── 시간 포맷 ──────────────────────────────────────────────────

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  // 곡당 리셋 — 분이 한자리/두자리 자동
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 7-segment digit 패턴 (옛 index.html 동일)
const SEG_DIGITS = {
  '0': [1, 1, 1, 1, 1, 1, 0],
  '1': [0, 1, 1, 0, 0, 0, 0],
  '2': [1, 1, 0, 1, 1, 0, 1],
  '3': [1, 1, 1, 1, 0, 0, 1],
  '4': [0, 1, 1, 0, 0, 1, 1],
  '5': [1, 0, 1, 1, 0, 1, 1],
  '6': [1, 0, 1, 1, 1, 1, 1],
  '7': [1, 1, 1, 0, 0, 0, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 1],
};

// 6각 베벨 막대 (옛 index.html 동일)
function drawSegRect(ctx, x, y, w, h) {
  const bevel = 4;
  ctx.beginPath();
  ctx.moveTo(x + bevel, y);
  ctx.lineTo(x + w - bevel, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w - bevel, y + h);
  ctx.lineTo(x + bevel, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
  ctx.fill();
}

function drawSevenSegDigit(ctx, num, x, y) {
  const segs = SEG_DIGITS[num];
  if (!segs) return;
  const w = 40, h = 8, l = 35;
  if (segs[0]) drawSegRect(ctx, x + 5,  y,        w, h);  // top
  if (segs[1]) drawSegRect(ctx, x + 42, y + 5,    h, l);  // top-right
  if (segs[2]) drawSegRect(ctx, x + 42, y + 50,   h, l);  // bottom-right
  if (segs[3]) drawSegRect(ctx, x + 5,  y + 82,   w, h);  // bottom
  if (segs[4]) drawSegRect(ctx, x,      y + 50,   h, l);  // bottom-left
  if (segs[5]) drawSegRect(ctx, x,      y + 5,    h, l);  // top-left
  if (segs[6]) drawSegRect(ctx, x + 5,  y + 41,   w, h);  // middle
}

function drawSevenSegColon(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x + 5, y + 25, 4, 0, Math.PI * 2);
  ctx.arc(x + 5, y + 65, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Design 1: Legacy 7-segment (옛 index.html 그대로) ──────────

function drawClockLegacy(ctx, comp, text /*, currentSec */) {
  // text = "M:SS" 또는 "MM:SS" — 콜론 제외 숫자만 추출
  const digitsOnly = text.replace(/[^0-9]/g, '');
  // 옛 코드: HHMMSS / MMSS. 곡당 리셋이라 MMSS (4자리) 또는 MSS (3자리).
  // 3자리는 어색하니 0 padding → MMSS 4자리로 통일.
  const str = digitsOnly.length < 4 ? digitsOnly.padStart(4, '0') : digitsOnly;

  // 옛 코드 dims: digitW=50, digitH=90, gap=10. colon between idx 1 & 2 (MM:SS).
  // 콜론 추가 폭: str.length===4 일 때 +30 (옛 코드 fullW 계산식과 동일)
  const digitW = 50, digitH = 90, gap = 10;
  const colonExtra = str.length === 4 ? 30 : (str.length >= 6 ? 60 : 0);
  const fullW = (str.length * (digitW + gap)) + colonExtra;

  // comp.fontSize 를 base height (90px) 대비 비율로 → scale.
  // 옛 코드는 외부 cfg.scale 로 받지만 우리 schema 는 fontSize 사용.
  const scale = (comp.fontSize || 60) / 60;  // base = 60px → scale 1.0

  ctx.save();
  // comp 의 가운데에 정렬
  const cx = comp.x + comp.width / 2;
  const cy = comp.y + comp.height / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  ctx.fillStyle = comp.color || '#FFFFFF';
  if ((comp.glow ?? 0) > 0) {
    ctx.shadowColor = comp.glowColor || comp.color || '#D4AF37';
    ctx.shadowBlur = comp.glow;
  }

  ctx.translate(-fullW / 2, -digitH / 2);
  let offsetX = 0;
  for (let i = 0; i < str.length; i++) {
    drawSevenSegDigit(ctx, str[i], offsetX, 0);
    offsetX += digitW + gap;
    // MMSS: colon between idx 1 & 2. HHMMSS: between 1&2, 3&4.
    if (str.length === 4 && i === 1) {
      drawSevenSegColon(ctx, offsetX, 0);
      offsetX += 20;
    } else if (str.length === 6 && (i === 1 || i === 3)) {
      drawSevenSegColon(ctx, offsetX, 0);
      offsetX += 20;
    }
  }
  ctx.restore();
}

// ─── Design 2: Neon 7-segment (흐릿한 8:88 + 밝은 시간) ─────────

function drawClockNeon(ctx, comp, text /*, currentSec */) {
  ctx.save();
  // align center (font-based — 7seg 가 아닌 일반 폰트, monospace)
  ctx.font = `${comp.fontSize || 60}px ${comp.fontFamily || '"Orbitron", "Courier New", monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = comp.x + comp.width / 2;
  const cy = comp.y + comp.height / 2;

  // 1) 흐릿한 placeholder "8:88" (또는 text 와 같은 자릿수)
  const placeholder = text.replace(/[0-9]/g, '8');
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.shadowBlur = 0;
  ctx.fillText(placeholder, cx, cy);

  // 2) 실제 시간 — 밝게 + 강한 glow
  ctx.fillStyle = comp.color || '#FFFFFF';
  if ((comp.glow ?? 0) > 0) {
    ctx.shadowColor = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = (comp.glow ?? 10) * 1.5;
  }
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// ─── Design 3: 3D Flip (fade out → fade in 1초 cycle) ──────────

function drawClockFlip(ctx, comp, text, currentSec) {
  // 1초 cycle 의 phase: 0 ~ 0.2 = fade-out, 0.2 ~ 0.4 = fade-in, 0.4 ~ 1 = stable.
  // currentSec 의 소수점 — 단, 미리보기에서 currentSec 이 정수면 sub=0 → alpha=1 (정적).
  const sub = currentSec - Math.floor(currentSec);
  let alpha = 1;
  if (sub < 0.2) alpha = 1 - (sub / 0.2);          // fade out (이전 숫자 기준이지만 같은 text 로 단순화)
  else if (sub < 0.4) alpha = (sub - 0.2) / 0.2;   // fade in (새 숫자)
  else alpha = 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `bold ${comp.fontSize || 60}px ${comp.fontFamily || 'monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = comp.color || '#FFFFFF';
  if ((comp.glow ?? 0) > 0) {
    ctx.shadowColor = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = comp.glow;
  }
  const cx = comp.x + comp.width / 2;
  const cy = comp.y + comp.height / 2;
  ctx.fillText(text, cx, cy);

  // 옵션: flip 중앙 hairline (3D 카드 가운데 선 느낌)
  if (sub < 0.4) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = 0;
    ctx.fillRect(cx - (comp.fontSize || 60) * 0.7, cy - 1, (comp.fontSize || 60) * 1.4, 2);
  }
  ctx.restore();
}

// ─── Design 4: Minimal Pulse (sine scale) ──────────────────────

function drawClockMinimal(ctx, comp, text, currentSec) {
  const sub = currentSec - Math.floor(currentSec);
  // sin(0..π) → 0..1..0 (1초 안에 한 사이클 — peak at sub=0.5)
  const scale = 1 + Math.sin(sub * Math.PI) * 0.05;

  ctx.save();
  const cx = comp.x + comp.width / 2;
  const cy = comp.y + comp.height / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  ctx.font = `400 ${comp.fontSize || 60}px ${comp.fontFamily || '"Roboto Mono", monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = comp.color || '#FFFFFF';
  if ((comp.glow ?? 0) > 0) {
    ctx.shadowColor = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = comp.glow;
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ─── 통합 entry ──────────────────────────────────────────────────

export function drawClock(ctx, comp, currentSec) {
  if (!comp || comp.type !== 'clock') return;
  if (!Number.isFinite(currentSec)) currentSec = 0;
  const text = formatTime(currentSec);

  ctx.save();
  ctx.globalAlpha = comp.opacity ?? 1;
  switch (comp.design) {
    case 'legacy':  drawClockLegacy(ctx, comp, text, currentSec); break;
    case 'neon':    drawClockNeon(ctx, comp, text, currentSec); break;
    case 'flip':    drawClockFlip(ctx, comp, text, currentSec); break;
    case 'minimal': drawClockMinimal(ctx, comp, text, currentSec); break;
    default:        drawClockLegacy(ctx, comp, text, currentSec); break;
  }
  ctx.restore();
}

export {
  drawClockLegacy,
  drawClockNeon,
  drawClockFlip,
  drawClockMinimal,
};
