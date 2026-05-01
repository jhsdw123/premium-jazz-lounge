// Phase 4-D-3-B: Playlist 렌더러.
//
// 5 layouts:
//   numbered   → "1. Track" 세로
//   dot        → "Track · Track · Track" 가로 wrap
//   slash      → "Track | Track | Track" 가로 wrap (형님 시그니처)
//   box        → 5줄 세로, 현재 곡 가운데 큼직, 위/아래 거리 따라 fade
//   timecode   → "00:00 - Track" 세로 (누적 시간)
//
// canvas-only — DOM 사용 X. 미리보기 = 녹화 결과 100% 일치.
//
// 사용:
//   import { drawPlaylist } from './playlist-renderer.js';
//   drawPlaylist(ctx, playlistComp, [{title, durationSec}, ...], currentIdx);

// ─── 폰트/스타일 helpers ────────────────────────────────────────

function buildFontSpec(comp, isHighlight) {
  const bold = isHighlight && comp.highlightEnabled
    ? (comp.highlightBold ?? comp.bold)
    : !!comp.bold;
  const italic = isHighlight && comp.highlightEnabled
    ? (comp.highlightItalic ?? comp.italic)
    : !!comp.italic;
  const fontSize = isHighlight && comp.highlightEnabled && comp.highlightFontSize
    ? comp.highlightFontSize
    : (comp.fontSize || 28);
  const family = comp.fontFamily || 'system-ui, sans-serif';
  let spec = '';
  if (italic) spec += 'italic ';
  spec += bold ? '700 ' : '400 ';
  spec += `${fontSize}px ${family}`;
  return { spec, fontSize };
}

function applyTrackStyle(ctx, comp, idx, currentIdx) {
  const isCurrent = !!comp.highlightEnabled && idx === currentIdx;
  const { spec, fontSize } = buildFontSpec(comp, isCurrent);
  ctx.font = spec;
  ctx.fillStyle = isCurrent ? (comp.highlightColor || '#D4AF37') : (comp.color || '#FFFFFF');

  // glow
  const glow = Math.max(0, comp.glow ?? 0);
  if (glow > 0) {
    ctx.shadowColor = isCurrent ? (comp.highlightColor || comp.glowColor || '#D4AF37')
                                : (comp.glowColor || '#D4AF37');
    ctx.shadowBlur = isCurrent ? glow * 1.4 : glow;
  } else {
    ctx.shadowBlur = 0;
  }

  return { isCurrent, fontSize };
}

function drawUnderline(ctx, text, x, y, fontSize, align) {
  const m = ctx.measureText(text);
  const w = m.width;
  let lx = x;
  if (align === 'center') lx = x - w / 2;
  else if (align === 'right') lx = x - w;
  // shadow 가 underline 까지 번지지 않도록 잠깐 끔
  const prevBlur = ctx.shadowBlur;
  ctx.shadowBlur = 0;
  ctx.fillRect(lx, y + fontSize * 0.15, w, Math.max(2, fontSize * 0.06));
  ctx.shadowBlur = prevBlur;
}

function alignToCanvasAlign(textAlign) {
  return textAlign === 'left' ? 'left' : textAlign === 'right' ? 'right' : 'center';
}

function alignXAnchor(comp) {
  const align = comp.textAlign || 'center';
  if (align === 'left') return comp.x;
  if (align === 'right') return comp.x + comp.width;
  return comp.x + comp.width / 2;
}

// ─── Layout A: numbered (세로 1. 2. 3.) ──────────────────────────

function drawPlaylistNumbered(ctx, comp, tracks, currentIdx) {
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = alignToCanvasAlign(comp.textAlign);
  const xAnchor = alignXAnchor(comp);
  const lineH = (comp.fontSize || 28) * (comp.lineHeight || 1.5);
  let y = comp.y;
  for (let i = 0; i < tracks.length; i++) {
    const { isCurrent, fontSize } = applyTrackStyle(ctx, comp, i, currentIdx);
    const text = `${i + 1}. ${tracks[i].title || ''}`;
    ctx.fillText(text, xAnchor, y);
    if (isCurrent && comp.highlightUnderline) {
      drawUnderline(ctx, text, xAnchor, y, fontSize, comp.textAlign || 'center');
    }
    y += lineH;
    if (y > comp.y + comp.height + lineH) break;  // 박스 밖 자르기
  }
  ctx.restore();
}

// ─── Layout B/C: dot/slash (가로 wrap, separator 만 다름) ──────

function drawWrappedHorizontal(ctx, comp, tracks, currentIdx, separator) {
  ctx.save();
  ctx.textBaseline = 'top';
  const lineH = (comp.fontSize || 28) * (comp.lineHeight || 1.5);
  const align = comp.textAlign || 'center';
  const maxWidth = comp.width;

  // Pass 1: line wrap. 각 line = [{ idx, text, sep, w }] — separator 폭 포함.
  // 폭은 highlight 여부 따라 폰트가 다를 수 있으므로 곡별로 measure.
  const lines = [[]];
  let curLineW = 0;

  for (let i = 0; i < tracks.length; i++) {
    applyTrackStyle(ctx, comp, i, currentIdx);
    const title = tracks[i].title || '';
    const wTitle = ctx.measureText(title).width;
    // separator 는 highlight 가 아닌 기본 스타일로 그릴 거니 기본 폰트로 measure.
    let wSep = 0;
    if (lines[lines.length - 1].length > 0) {
      ctx.font = buildFontSpec(comp, false).spec;
      wSep = ctx.measureText(separator).width;
    }
    const itemW = wTitle + wSep;

    if (curLineW + itemW > maxWidth && lines[lines.length - 1].length > 0) {
      lines.push([]);
      curLineW = 0;
      // 새 line 의 첫 요소엔 separator 안 붙임
      lines[lines.length - 1].push({ idx: i, title, sep: '', wTitle, wSep: 0 });
      curLineW = wTitle;
    } else {
      lines[lines.length - 1].push({
        idx: i, title,
        sep: lines[lines.length - 1].length > 0 ? separator : '',
        wTitle, wSep,
      });
      curLineW += itemW;
    }
  }

  // line 별 총 폭 계산 (textAlign 에 따른 시작 X 결정)
  let y = comp.y;
  for (const line of lines) {
    const lineW = line.reduce((a, it) => a + it.wTitle + it.wSep, 0);
    let x;
    if (align === 'left') x = comp.x;
    else if (align === 'right') x = comp.x + comp.width - lineW;
    else x = comp.x + (comp.width - lineW) / 2;

    // canvas textAlign='left' 로 고정 — 항목별 누적 x 계산이 쉬워짐
    ctx.textAlign = 'left';

    for (const item of line) {
      // separator (기본 스타일)
      if (item.sep) {
        applyTrackStyle(ctx, comp, -1, currentIdx);  // -1 = 강조 안 됨
        ctx.fillText(item.sep, x, y);
        x += item.wSep;
      }
      // title (강조 여부 적용)
      const { isCurrent, fontSize } = applyTrackStyle(ctx, comp, item.idx, currentIdx);
      ctx.fillText(item.title, x, y);
      if (isCurrent && comp.highlightUnderline) {
        // textAlign='left' 라 anchor=시작점 → drawUnderline 의 'left' branch
        drawUnderline(ctx, item.title, x, y, fontSize, 'left');
      }
      x += item.wTitle;
    }
    y += lineH;
    if (y > comp.y + comp.height + lineH) break;
  }

  ctx.restore();
}

const drawPlaylistDot = (ctx, comp, tracks, idx) =>
  drawWrappedHorizontal(ctx, comp, tracks, idx, ' · ');
const drawPlaylistSlash = (ctx, comp, tracks, idx) =>
  drawWrappedHorizontal(ctx, comp, tracks, idx, ' | ');

// ─── Layout D: box (현재 곡 가운데, 위/아래 fade) ────────────────

function drawPlaylistBox(ctx, comp, tracks, currentIdx) {
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = alignToCanvasAlign(comp.textAlign);
  const xAnchor = alignXAnchor(comp);

  const lineH = (comp.fontSize || 28) * (comp.lineHeight || 1.5);
  // 5줄: idx-2, idx-1, idx, idx+1, idx+2
  const offsets = [-2, -1, 0, 1, 2];
  const opacityByOffset = { '-2': 0.4, '-1': 0.7, '0': 1.0, '1': 0.7, '2': 0.4 };

  const cy = comp.y + comp.height / 2;
  const startY = cy - 2 * lineH;

  const baseAlpha = comp.opacity ?? 1;

  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i];
    const trackIdx = currentIdx + off;
    if (trackIdx < 0 || trackIdx >= tracks.length) continue;

    const { isCurrent, fontSize } = applyTrackStyle(ctx, comp, trackIdx, currentIdx);
    ctx.globalAlpha = baseAlpha * (opacityByOffset[String(off)] ?? 0.4);
    const y = startY + i * lineH;
    const text = tracks[trackIdx].title || '';
    ctx.fillText(text, xAnchor, y);
    if (isCurrent && comp.highlightUnderline) {
      drawUnderline(ctx, text, xAnchor, y - fontSize / 2, fontSize, comp.textAlign || 'center');
    }
  }
  ctx.restore();
}

// ─── Layout E: timecode (세로, 누적 시간) ────────────────────────

function formatTimecode(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function drawPlaylistTimecode(ctx, comp, tracks, currentIdx) {
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = alignToCanvasAlign(comp.textAlign);
  const xAnchor = alignXAnchor(comp);
  const lineH = (comp.fontSize || 28) * (comp.lineHeight || 1.5);
  let cumSec = 0;
  let y = comp.y;
  for (let i = 0; i < tracks.length; i++) {
    const { isCurrent, fontSize } = applyTrackStyle(ctx, comp, i, currentIdx);
    const tc = formatTimecode(cumSec);
    const text = `${tc} - ${tracks[i].title || ''}`;
    ctx.fillText(text, xAnchor, y);
    if (isCurrent && comp.highlightUnderline) {
      drawUnderline(ctx, text, xAnchor, y, fontSize, comp.textAlign || 'center');
    }
    cumSec += tracks[i].durationSec || 0;
    y += lineH;
    if (y > comp.y + comp.height + lineH) break;
  }
  ctx.restore();
}

// ─── 통합 entry ──────────────────────────────────────────────────

export function drawPlaylist(ctx, comp, tracks, currentIdx) {
  if (!comp || comp.type !== 'playlist') return;
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  ctx.save();
  ctx.globalAlpha = comp.opacity ?? 1;
  // letterSpacing 은 canvas 기본 미지원 — 무시 (필요 시 글자별 measure 로 구현 가능).
  switch (comp.layout) {
    case 'numbered': drawPlaylistNumbered(ctx, comp, tracks, currentIdx); break;
    case 'dot':      drawPlaylistDot(ctx, comp, tracks, currentIdx); break;
    case 'slash':    drawPlaylistSlash(ctx, comp, tracks, currentIdx); break;
    case 'box':      drawPlaylistBox(ctx, comp, tracks, currentIdx); break;
    case 'timecode': drawPlaylistTimecode(ctx, comp, tracks, currentIdx); break;
    default:         drawPlaylistSlash(ctx, comp, tracks, currentIdx); break;
  }
  ctx.restore();
}

// 개별 layout exports (테스트/검증용)
export {
  drawPlaylistNumbered,
  drawPlaylistDot,
  drawPlaylistSlash,
  drawPlaylistBox,
  drawPlaylistTimecode,
  formatTimecode,
};
