// Phase 4-D-3-A: NowPlaying 애니메이션 모듈.
//
// 핵심 설계: 애니메이션을 "시간 → state" 순수 함수로 정의.
//   - DOM 드라이버 (Editor 미리보기 / Studio live preview): RAF 마다 state 를 inline style 로 적용
//   - Canvas 드라이버 (Studio 녹화 시 mp4 인코딩): 매 frame state 를 ctx 에 적용
//
// 두 path 가 같은 state 를 공유 → 미리보기 = 녹화 결과 (보장).
//
// 5 phase: idle → 'in' (애니메이션) → 'hold' → 'out' (페이드아웃) → idle
// 곡 전환 시 (out → 'in' new text) 자동 트리거.

// ─── easing ──────────────────────────────────────────────────────
const easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
const easeInOutCubic = (p) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

// ─── 5 in-animations ─────────────────────────────────────────────
// 각 함수: (elapsedMs, durationMs, fullText, comp) → AnimationState
//   AnimationState = { opacity, translateX, translateY, blur, glowMultiplier, text, cursor }
// glowMultiplier: comp.glow 에 곱하는 배수 (기본 1)

const animations = {
  fade(t, d, text /*, comp */) {
    const p = Math.min(1, Math.max(0, t / d));
    return { opacity: p, text };
  },

  slide(t, d, text /*, comp */) {
    const p = Math.min(1, Math.max(0, t / d));
    const eased = easeOutQuart(p);
    return {
      opacity: eased,
      translateY: 40 * (1 - eased),
      text,
    };
  },

  typewriter(t, d, text /*, comp */) {
    if (!text) return { opacity: 1, text: '' };
    // 정확히 d 안에 모든 char 표시되도록 cps 자동 계산 (최소 20cps).
    const cps = Math.max(20, text.length / Math.max(0.001, d / 1000));
    const charsVisible = Math.min(text.length, Math.floor((t / 1000) * cps));
    return {
      opacity: 1,
      text: text.substring(0, Math.max(0, charsVisible)),
      cursor: charsVisible < text.length,
    };
  },

  glow(t, d, text /*, comp */) {
    const p = Math.min(1, Math.max(0, t / d));
    // opacity: 처음 1/3 동안 0→1
    const opacity = Math.min(1, t / (d / 3));
    // glow: 0→4x 까지 솟았다가 1x 로. d/2 에서 peak.
    let glowMul;
    if (p < 0.5) {
      glowMul = 1 + (p / 0.5) * 3; // 1 → 4
    } else {
      glowMul = 4 - ((p - 0.5) / 0.5) * 3; // 4 → 1
    }
    return { opacity, glowMultiplier: glowMul, text };
  },

  blur(t, d, text /*, comp */) {
    const p = Math.min(1, Math.max(0, t / d));
    const eased = easeInOutCubic(p);
    return {
      opacity: eased,
      blur: 20 * (1 - eased),
      text,
    };
  },
};

// ─── fade-out (out phase, 곡 끝날 때) ────────────────────────────
function fadeOutState(t, d) {
  const p = Math.min(1, Math.max(0, t / d));
  return { opacity: 1 - p };
}

// ─── 외부 API ─────────────────────────────────────────────────────

export const ANIMATION_TYPES = ['fade', 'slide', 'typewriter', 'glow', 'blur'];

/**
 * 애니메이션 controller — Editor 미리보기 / Studio live preview / Studio 녹화 모두 사용.
 *
 * createController(comp) → controller
 * controller.startIn(text)    : in-phase 시작 (새 텍스트 표시)
 * controller.startOut()       : out-phase 시작
 * controller.stateAt(now)     : now (performance.now() 또는 임의 ms) 기준 state 반환
 * controller.isPlaying(now)   : in 또는 out 중인지
 * controller.reset()          : idle 상태 (opacity 0)
 */
export function createController(comp) {
  let phase = 'idle';      // 'idle' | 'in' | 'hold' | 'out'
  let phaseStart = 0;      // ms (now 기준)
  let currentText = '';
  let savedHoldState = { opacity: 1, text: '' };

  const ctrl = {
    get phase() { return phase; },
    get text() { return currentText; },

    startIn(text, now = performance.now()) {
      currentText = text || '';
      phase = 'in';
      phaseStart = now;
    },

    startOut(now = performance.now()) {
      if (phase === 'idle') return;
      phase = 'out';
      phaseStart = now;
    },

    reset() {
      phase = 'idle';
      currentText = '';
      savedHoldState = { opacity: 1, text: '' };
    },

    isPlaying(now = performance.now()) {
      const inDur = comp.animationDurationMs ?? 800;
      const outDur = comp.fadeOutMs ?? 500;
      const elapsed = now - phaseStart;
      if (phase === 'in') return elapsed < inDur;
      if (phase === 'out') return elapsed < outDur;
      return false;
    },

    stateAt(now = performance.now()) {
      if (phase === 'idle') {
        return { opacity: 0, text: '' };
      }
      const elapsed = now - phaseStart;

      if (phase === 'in') {
        const inDur = Math.max(50, comp.animationDurationMs ?? 800);
        const animFn = animations[comp.animation] || animations.fade;
        if (elapsed >= inDur) {
          // 자동으로 hold 로 전환
          phase = 'hold';
          savedHoldState = { opacity: 1, text: currentText };
          return savedHoldState;
        }
        return animFn(elapsed, inDur, currentText, comp);
      }

      if (phase === 'hold') {
        return { opacity: 1, text: currentText };
      }

      if (phase === 'out') {
        const outDur = Math.max(50, comp.fadeOutMs ?? 500);
        if (elapsed >= outDur) {
          phase = 'idle';
          currentText = '';
          return { opacity: 0, text: '' };
        }
        const fade = fadeOutState(elapsed, outDur);
        return { opacity: fade.opacity, text: currentText };
      }

      return { opacity: 0, text: '' };
    },
  };

  return ctrl;
}

// ─── DOM 드라이버 — controller state 를 div 에 적용 ───────────────
export function applyStateToElement(element, state, comp) {
  if (!element) return;
  element.style.opacity = String(state.opacity ?? 0);
  const tx = state.translateX || 0;
  const ty = state.translateY || 0;
  element.style.transform = `translate(${tx}px, ${ty}px)`;
  element.style.filter = state.blur ? `blur(${state.blur}px)` : 'none';

  // 텍스트 갱신
  if (state.cursor) {
    element.textContent = (state.text || '') + '▎'; // typewriter cursor
  } else {
    element.textContent = state.text || '';
  }

  // glow — comp.glow * glowMultiplier
  const baseGlow = Math.max(0, comp.glow ?? 0);
  const mul = state.glowMultiplier ?? 1;
  const finalGlow = baseGlow * mul;
  if (finalGlow > 0) {
    const color = comp.glowColor || '#D4AF37';
    element.style.textShadow = `0 0 ${finalGlow}px ${color}, 0 0 ${finalGlow * 2}px ${color}`;
  } else {
    element.style.textShadow = 'none';
  }
}

// ─── Canvas 드라이버 — controller state 를 ctx 에 그리기 ─────────
export function drawStateOnCanvas(ctx, state, comp) {
  if (!state || (state.opacity ?? 0) <= 0) return;
  if (!state.text && !state.cursor) return;

  ctx.save();
  ctx.globalAlpha = (comp.opacity ?? 1) * (state.opacity ?? 1);

  const tx = state.translateX || 0;
  const ty = state.translateY || 0;
  ctx.translate(tx, ty);

  if (state.blur && state.blur > 0.1) {
    ctx.filter = `blur(${state.blur}px)`;
  }

  // 폰트
  let fontSpec = '';
  if (comp.italic) fontSpec += 'italic ';
  fontSpec += comp.bold ? '700 ' : '400 ';
  fontSpec += `${comp.fontSize || 48}px ${comp.fontFamily || 'system-ui, sans-serif'}`;
  ctx.font = fontSpec;
  ctx.fillStyle = comp.color || '#FFFFFF';
  ctx.textBaseline = 'middle';

  const align = comp.textAlign || 'center';
  ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';

  // glow → shadow
  const baseGlow = Math.max(0, comp.glow ?? 0);
  const mul = state.glowMultiplier ?? 1;
  const finalGlow = baseGlow * mul;
  if (finalGlow > 0) {
    ctx.shadowColor = comp.glowColor || '#D4AF37';
    ctx.shadowBlur = finalGlow;
  }

  // 위치 — comp.x/y 가 좌상단 (canvas world coords). textAlign 에 따라 anchor 보정.
  const cx = comp.x + comp.width / 2;
  const cy = comp.y + comp.height / 2;
  let drawX = cx;
  if (align === 'left') drawX = comp.x;
  else if (align === 'right') drawX = comp.x + comp.width;

  // textTransform
  let displayText = state.text || '';
  if (comp.textTransform === 'uppercase') displayText = displayText.toUpperCase();
  else if (comp.textTransform === 'lowercase') displayText = displayText.toLowerCase();
  else if (comp.textTransform === 'capitalize') {
    displayText = displayText.replace(/\b\w/g, (m) => m.toUpperCase());
  }

  if (state.cursor) displayText += '▎';

  ctx.fillText(displayText, drawX, cy);

  // underline
  if (comp.underline && displayText) {
    const m = ctx.measureText(displayText);
    const lineW = m.width;
    let lx = drawX;
    if (align === 'center') lx = drawX - lineW / 2;
    else if (align === 'right') lx = drawX - lineW;
    const lineY = cy + (comp.fontSize || 48) * 0.5;
    ctx.fillRect(lx, lineY, lineW, Math.max(2, (comp.fontSize || 48) * 0.06));
  }

  ctx.restore();
}

// ─── Editor 미리보기 RAF runner ───────────────────────────────────
//   start: in-phase 만 1회 재생 → hold (애니메이션 끝난 상태로 멈춤)
//   useCase: 사용자가 "미리보기" 버튼 눌렀을 때 1회 시연.
export function runPreview(controller, element, comp, text) {
  controller.startIn(text);
  let rafId = null;
  const tick = () => {
    const state = controller.stateAt();
    applyStateToElement(element, state, comp);
    if (controller.phase === 'in') {
      rafId = requestAnimationFrame(tick);
    } else {
      // hold 상태 — 끝까지 표시 유지
      cancelAnimationFrame(rafId);
    }
  };
  tick();
  return () => { if (rafId) cancelAnimationFrame(rafId); };
}
