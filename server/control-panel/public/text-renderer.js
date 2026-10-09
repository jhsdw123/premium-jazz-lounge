// text-renderer.js — 텍스트 컴포넌트를 canvas 에 그리는 **단 하나의** 구현.
//
// 왜 있나: 예전엔 Template Editor 가 HTML/CSS 로, Studio(=mp4 출력) 가 canvas 로 **각자** 글자를
//   그렸다. 두 구현이 조금씩 달라서 (자간 무시 · 자동 줄바꿈 없음 · 취소선 없음 · 축소 화면의
//   px 값 미환산 · 최소 글꼴 크기 고정 …) 에디터에서 본 것과 녹화 결과가 어긋났다.
//   이제 에디터도 이 파일로 canvas 에 그린다 → 같은 코드 = 같은 그림.
//   (playlist-renderer / clock-renderer 가 이미 쓰던 패턴과 동일.)
//
// 어디서 쓰나:
//   1. studio.js           미리보기 + 실제 mp4 출력
//   2. template-editor.js  편집 캔버스의 텍스트 컴포넌트 (bleed canvas)

import { drawTextPanel, textAreaFor } from './text-panel.js';

export function substituteVars(content, vars) {
  return String(content || '')
    .replace(/\{\{trackTitle\}\}/g, vars?.trackTitle || '')
    .replace(/\{\{trackNumber\}\}/g, String(vars?.trackNumber || 1))
    .replace(/\{\{totalTracks\}\}/g, String(vars?.totalTracks || 1));
}

// capitalize 는 \b\w 로 하면 "don't" → "Don'T" 가 된다. 글자·숫자·아포스트로피가 아닌 것
// 뒤에 오는 첫 글자만 올린다 (CSS text-transform: capitalize 와 같은 결과).
export function applyTextTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') {
    return text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre, ch) => pre + ch.toUpperCase());
  }
  return text;
}

export function fontSpecFor(c, fallbackSize = 72, fallbackFamily = 'Playfair Display, serif') {
  return `${c.italic ? 'italic ' : ''}${c.bold ? 'bold ' : ''}${c.fontSize || fallbackSize}px ${c.fontFamily || fallbackFamily}`;
}

export function applyLetterSpacing(ctx, c) {
  // Chrome 99+. 없는 브라우저에선 조용히 자간 0 — 어차피 패널은 Chrome(WebCodecs) 전용.
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${c.letterSpacing ?? 0}px`;
}

// ─── 줄 나누기 ────────────────────────────────────────────────────
// 60fps 로 몇 시간씩 도는 렌더 루프에서 매 프레임 measureText 를 수십 번 부르지 않도록 캐시.
// 웹폰트가 늦게 도착하면 폭이 달라지므로 그때 통째로 비운다.
const _layoutCache = new Map();
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => _layoutCache.clear());
}

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

// 줄바꿈 가능 단위로 쪼갠다: 공백 / 하이픈 뒤 / 한중일 글자 사이.
function breakUnits(paragraph) {
  const units = [];
  const words = paragraph.split(' ');
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    if (!word) continue;
    let buf = '';
    let first = true;
    const flush = () => {
      if (!buf) return;
      units.push({ text: buf, space: first && units.length > 0 });
      first = false;
      buf = '';
    };
    for (const ch of word) {
      if (CJK.test(ch)) { flush(); buf = ch; flush(); continue; }
      buf += ch;
      if (ch === '-' || ch === '–' || ch === '—') flush();
    }
    flush();
  }
  return units;
}

/**
 * text 를 화면 줄 배열로. ctx.font / letterSpacing 은 호출 전에 설정돼 있어야 한다.
 *   autoWrap=true  : \n 에서 끊고, maxWidth 를 넘으면 단어 단위로 접는다. 한 단어가 폭보다
 *                    길면 글자 단위로 끊는다. 연속 공백은 하나로 (CSS pre-line 과 동일).
 *   autoWrap=false : \n 에서만 끊는다.
 */
export function layoutTextLines(ctx, text, maxWidth, autoWrap) {
  const paragraphs = String(text).split('\n');
  if (!autoWrap || !(maxWidth > 0)) return paragraphs;

  const key = `${ctx.font}|${ctx.letterSpacing || ''}|${maxWidth}|${text}`;
  const hit = _layoutCache.get(key);
  if (hit) return hit;

  const fits = (s) => ctx.measureText(s).width <= maxWidth + 0.01;
  const lines = [];
  for (const raw of paragraphs) {
    const para = raw.replace(/[ \t]+/g, ' ').trim();
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const u of breakUnits(para)) {
      const cand = line ? line + (u.space ? ' ' : '') + u.text : u.text;
      if (fits(cand)) { line = cand; continue; }
      if (line) lines.push(line);
      line = u.text;
      // 단어 하나가 박스보다 길다 → 글자 단위로 끊는다 (word-wrap: break-word)
      while (!fits(line) && [...line].length > 1) {
        const chars = [...line];
        let n = chars.length - 1;
        while (n > 1 && !fits(chars.slice(0, n).join(''))) n--;
        lines.push(chars.slice(0, n).join(''));
        line = chars.slice(n).join('');
      }
    }
    lines.push(line);
  }

  if (_layoutCache.size > 300) _layoutCache.clear();
  _layoutCache.set(key, lines);
  return lines;
}

// 'middle' 기준선에서 알파벳 기준선까지의 거리 (밑줄·취소선 위치용).
const _baselineCache = new Map();
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => _baselineCache.clear());
}
function alphabeticOffsetFromMiddle(ctx) {
  const key = ctx.font;
  if (_baselineCache.has(key)) return _baselineCache.get(key);
  const prev = ctx.textBaseline;
  ctx.textBaseline = 'alphabetic';
  const a = ctx.measureText('x').fontBoundingBoxAscent;
  ctx.textBaseline = 'middle';
  const m = ctx.measureText('x').fontBoundingBoxAscent;
  ctx.textBaseline = prev;
  const off = Number.isFinite(a - m) ? a - m : 0;
  if (_baselineCache.size > 100) _baselineCache.clear();
  _baselineCache.set(key, off);
  return off;
}

/**
 * 텍스트 컴포넌트 한 개를 world 좌표(1920×1080)로 그린다.
 * @param opts { allowBackdrop=true } — 에디터는 canvas 밑의 배경을 떠올 수 없어 false 로 부른다.
 */
export function drawTextComponent(ctx, c, vars, opts = {}) {
  // 배경 패널을 텍스트보다 먼저. 내용이 비어도 패널은 그린다 — '글자 놓을 빈 공간 확보'가
  // 목적이라 {{trackTitle}} 이 빈 곡에서 패널만 사라지면 레이아웃이 튄다.
  // 컴포넌트 투명도는 패널에도 건다 (글자만 흐려지고 상자는 멀쩡한 어색함 방지).
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  drawTextPanel(ctx, c, { x: c.x, y: c.y, w: c.width, h: c.height }, { allowBackdrop: opts.allowBackdrop !== false });
  ctx.restore();

  const text = applyTextTransform(substituteVars(c.content || '', vars), c.textTransform || 'none');
  if (!text) return;

  const area = textAreaFor(c);   // 패딩 반영 (패널 꺼져 있으면 컴포넌트 영역 그대로)
  const fs = c.fontSize || 72;
  const autoWrap = c.autoWrap !== false;

  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  ctx.font = fontSpecFor(c);
  applyLetterSpacing(ctx, c);
  ctx.fillStyle = c.color || '#FFFFFF';
  ctx.textBaseline = 'middle';

  // autoWrap 끔 = "고정": 박스 폭을 넘는 글자는 잘라낸다 (세로는 안 자름).
  if (!autoWrap) {
    ctx.beginPath();
    ctx.rect(area.x, area.y - 100000, area.width, 200000);
    ctx.clip();
  }

  if (!isDarkHex(c.color) && (c.glowIntensity ?? 1) > 0) {
    const glow = c.glowIntensity ?? 1;
    ctx.shadowColor = `rgba(212,175,55,${Math.min(1, 0.5 + glow * 0.3)})`;
    ctx.shadowBlur = Math.round(20 * glow);
  }

  const lines = layoutTextLines(ctx, text, area.width, autoWrap);
  const lh = fs * (c.lineHeight ?? 1.2);
  const startY = area.y + area.height / 2 - (lh * lines.length) / 2 + lh / 2;
  const align = c.textAlign || 'center';
  const decoT = Math.max(1, fs * 0.06);
  const baseOff = (c.underline || c.strikethrough) ? alphabeticOffsetFromMiddle(ctx) : 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const w = ctx.measureText(line).width;
    // 박스보다 긴 줄은 정렬과 무관하게 왼쪽에서 시작한다 (잘릴 때 앞부분이 보이도록).
    let left;
    if (w > area.width || align === 'left') left = area.x;
    else if (align === 'right') left = area.x + area.width - w;
    else left = area.x + (area.width - w) / 2;
    const y = startY + i * lh;
    ctx.textAlign = 'left';
    ctx.fillText(line, left, y);
    if (c.underline) ctx.fillRect(left, y + baseOff + fs * 0.08, w, decoT);
    if (c.strikethrough) ctx.fillRect(left, y + baseOff - fs * 0.27, w, decoT);
  }
  ctx.restore();
}

function isDarkHex(hex) {
  if (!hex || typeof hex !== 'string') return false;
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((ch) => ch + ch).join('');
  if (m.length !== 6) return true;   // 예전 studio.js 와 동일: 못 읽는 색은 검정 취급 → 글로우 없음
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 110;
}
