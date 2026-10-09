// text-panel.js — 텍스트 컴포넌트의 배경 패널 (Phase 4-E-1)
//
// 왜 있나: 배경 이미지에 선/무늬가 지나가면 그 위의 텍스트가 안 읽힌다.
//   "글자를 놓을 빈 공간"을 형님이 원하는 자리에 직접 만들어 주기 위한 패널이다.
//
// 어디서 쓰나 — canvas 로 그리는 두 경로가 이 파일을 공유한다:
//   1. studio.js       미리보기 + **실제 mp4 출력** (여기가 진짜 결과물)
//   2. template-editor.js  템플릿 목록 카드 썸네일 (drawCardText)
//   편집 캔버스(DOM) 는 CSS 로 같은 그림을 흉내낸다 — template-editor.js 의 renderTextInner.
//
// 구현 원리: 패널을 **오프스크린 레이어에 통째로 만든 뒤** 메인 캔버스에 한 번에 얹는다.
//   그래야 feather(가장자리 페더)를 backdrop blur·배경색·테두리 **전부에 동일하게** 걸 수 있다.
//   레이어에 하나씩 그리고 마지막에 destination-in 으로 부드러운 마스크를 씌우는 순서다.

const DEFAULTS = {
  panelColor: '#000000',
  panelOpacity: 0.45,
  panelRadius: 24,
  panelFeather: 18,
  panelBackdropBlur: 0,
  panelPadding: 24,
  panelBorderWidth: 0,
  panelBorderColor: '#D4AF37',
  panelBorderOpacity: 1,
  panelShadow: 0,
  panelShadowColor: '#000000',
  panelShadowOpacity: 0.5,
  panelShadowOffsetY: 0,
};

export const TEXT_PANEL_DEFAULTS = DEFAULTS;

export function hasTextPanel(c) {
  return !!c && c.panelEnabled === true;
}

function num(c, key) {
  const v = c[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[key];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(0,0,0,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
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
}

// 오프스크린 레이어는 프레임마다 새로 만들지 않는다 — 60fps 렌더에서 캔버스를 매번
// 할당하면 GC 압력이 커진다. 필요한 만큼만 키워서 계속 재사용한다.
let _scratch = null;
function getScratch(w, h) {
  if (!_scratch) {
    const cv = document.createElement('canvas');
    _scratch = { cv, ctx: cv.getContext('2d') };
  }
  if (_scratch.cv.width < w || _scratch.cv.height < h) {
    _scratch.cv.width = Math.max(w, _scratch.cv.width);
    _scratch.cv.height = Math.max(h, _scratch.cv.height);
  }
  return _scratch;
}

let _warnedRotation = false;

/**
 * 텍스트 배경 패널을 그린다. 텍스트보다 **먼저** 호출할 것.
 *
 * @param ctx    대상 2D 컨텍스트
 * @param c      컴포넌트 (panel* 속성들)
 * @param rect   {x,y,w,h} — 이미 스케일이 반영된 화면 좌표
 * @param opts   { scale=1, allowBackdrop=true }
 *   scale         — 카드 썸네일처럼 축소해 그릴 때의 배율. blur/radius 등 px 값에 곱한다.
 *   allowBackdrop — false 면 backdrop blur 를 건너뛴다 (썸네일은 배경을 안 깔고 그리므로 무의미).
 */
export function drawTextPanel(ctx, c, rect, opts = {}) {
  if (!hasTextPanel(c)) return;
  const { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) return;

  const s = opts.scale ?? 1;
  const radius = Math.max(0, num(c, 'panelRadius') * s);
  const feather = Math.max(0, num(c, 'panelFeather') * s);
  const borderW = Math.max(0, num(c, 'panelBorderWidth') * s);
  const fillAlpha = clamp01(num(c, 'panelOpacity'));
  const shadowBlur = Math.max(0, num(c, 'panelShadow') * s);
  const shadowDY = num(c, 'panelShadowOffsetY') * s;

  // 회전된 컴포넌트에서는 backdrop 을 포기한다.
  //   메인 캔버스에서 떠오는 픽셀은 회전 전 좌표계인데 합성은 회전된 변환 아래서 일어나
  //   흐린 배경이 엉뚱한 자리에 얹힌다. 색/페더/테두리는 회전과 무관하게 정상이다.
  let backdrop = opts.allowBackdrop === false ? 0 : Math.max(0, num(c, 'panelBackdropBlur') * s);
  if (backdrop > 0 && c.rotation) {
    backdrop = 0;
    if (!_warnedRotation) {
      _warnedRotation = true;
      console.warn('[text-panel] 회전된 텍스트에는 Backdrop Blur 를 적용하지 않습니다 (좌표가 어긋남)');
    }
  }

  // 아무것도 안 보이는 조합이면 레이어를 만들 이유가 없다.
  if (fillAlpha <= 0 && borderW <= 0 && backdrop <= 0) return;

  // feather 는 바깥으로 번지고 backdrop 은 가장자리 샘플이 필요하다 → 레이어에 여유를 준다.
  const margin = Math.ceil(feather * 2 + backdrop * 2 + borderW + 2);
  const lw = Math.ceil(w + margin * 2);
  const lh = Math.ceil(h + margin * 2);
  const scratch = getScratch(lw, lh);
  const lctx = scratch.ctx;
  lctx.save();
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, lw, lh);
  lctx.filter = 'none';
  lctx.globalCompositeOperation = 'source-over';
  lctx.globalAlpha = 1;

  // 1) backdrop — 지금까지 메인 캔버스에 그려진 그림을 그대로 떠와 흐리게 만든다.
  //    (배경 이미지 + 이 컴포넌트보다 먼저 그려진 것들이 대상이다.)
  if (backdrop > 0) {
    lctx.save();
    lctx.filter = `blur(${backdrop}px)`;
    lctx.drawImage(ctx.canvas, x - margin, y - margin, lw, lh, 0, 0, lw, lh);
    lctx.restore();
  }

  // 2) 배경색
  if (fillAlpha > 0) {
    lctx.save();
    lctx.globalAlpha = fillAlpha;
    lctx.fillStyle = c.panelColor || DEFAULTS.panelColor;
    roundRectPath(lctx, margin, margin, w, h, radius);
    lctx.fill();
    lctx.restore();
  }

  // 3) 테두리 — 선의 중심이 경계에 오도록 반 두께만큼 안쪽에 그린다.
  if (borderW > 0) {
    lctx.save();
    lctx.globalAlpha = clamp01(num(c, 'panelBorderOpacity'));
    lctx.strokeStyle = c.panelBorderColor || DEFAULTS.panelBorderColor;
    lctx.lineWidth = borderW;
    roundRectPath(
      lctx,
      margin + borderW / 2, margin + borderW / 2,
      Math.max(0, w - borderW), Math.max(0, h - borderW),
      Math.max(0, radius - borderW / 2)
    );
    lctx.stroke();
    lctx.restore();
  }

  // 4) feather — 레이어 전체에 부드러운 마스크. 여기까지 그린 것 **전부**에 동일하게 걸린다.
  //    마스크를 feather 만큼 안쪽으로 넣어야 blur 로 번진 결과가 원래 박스 크기와 얼추 맞는다.
  if (feather > 0) {
    lctx.save();
    lctx.globalCompositeOperation = 'destination-in';
    lctx.filter = `blur(${feather}px)`;
    lctx.fillStyle = '#ffffff';
    const inset = feather;
    roundRectPath(
      lctx,
      margin + inset, margin + inset,
      Math.max(0, w - inset * 2), Math.max(0, h - inset * 2),
      Math.max(0, radius - inset)
    );
    lctx.fill();
    lctx.restore();
  }
  lctx.restore();

  // 5) 메인에 합성 — 그림자는 레이어의 alpha 모양을 그대로 따른다.
  ctx.save();
  if (shadowBlur > 0 || shadowDY !== 0) {
    ctx.shadowColor = hexToRgba(c.panelShadowColor || DEFAULTS.panelShadowColor, clamp01(num(c, 'panelShadowOpacity')));
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowDY;
  }
  ctx.drawImage(scratch.cv, 0, 0, lw, lh, x - margin, y - margin, lw, lh);
  ctx.restore();
}

/**
 * 패딩을 반영한 **텍스트가 실제로 놓일 영역**. 패널이 꺼져 있으면 컴포넌트 영역 그대로.
 * 패널을 켜면 글자가 박스 가장자리에 붙지 않도록 padding 만큼 안쪽으로 들어간다.
 */
export function textAreaFor(c) {
  const p = hasTextPanel(c) ? Math.max(0, num(c, 'panelPadding')) : 0;
  const w = c.width - p * 2;
  const h = c.height - p * 2;
  // 패딩이 박스보다 크면 영역이 뒤집힌다 — 그 경우 패딩을 무시하는 게 낫다(글자가 사라지는 것보다).
  if (w <= 1 || h <= 1) return { x: c.x, y: c.y, width: c.width, height: c.height };
  return { x: c.x + p, y: c.y + p, width: w, height: h };
}
