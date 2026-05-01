// Premium Jazz Lounge — Studio (Phase 4-D-2)
// 1920×1080 canvas + AudioMotion + WebCodecs mp4 export.
// 옛날 index.html (C:\Users\User\Desktop\Youtube_webapp\index.html) 의 export 파이프라인을
// 가져와 본 컨트롤 패널의 Studio 탭에 통합.
//
// 의존성:
//   - mp4-muxer (CDN, index.html 에서 globalThis.Mp4Muxer 로 로드)
//   - audiomotion-analyzer (jsdelivr ESM)
//   - WebCodecs (Chrome 102+, Edge 102+)

import AudioMotionAnalyzer from 'https://cdn.jsdelivr.net/npm/audiomotion-analyzer@4/+esm';
import {
  createController as createNPController,
  applyStateToElement as applyNPState,
  drawStateOnCanvas as drawNPState,
} from './now-playing-animations.js';
import { drawPlaylist } from './playlist-renderer.js';
import { drawClock } from './clock-renderer.js';
import { getAmplitudes, drawCustomVisualizer } from './visualizer-styles.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const FPS = 30;
const SS_KEY = 'pjl.studio.session';

const studio = {
  initialized: false,
  session: null,             // { buildId, videoId, title, template, tracks, totalDurationSec }
  components: [],            // template 의 components[] (adaptTemplate 결과)
  bgImg: null,               // HTMLImageElement (background)

  // 오디오
  audioCtx: null,
  audioElement: null,
  audioSource: null,         // MediaElementAudioSourceNode
  currentTrackIdx: -1,
  trackElapsed: 0,           // 현재 곡 안에서의 elapsed sec
  globalElapsed: 0,          // 전체 누적 sec

  // 비주얼라이저
  visInstances: new Map(),   // compId → AudioMotionAnalyzer
  visCanvases: new Map(),    // compId → AudioMotion 의 canvas (composite 용)

  // NowPlaying (한 영상에 1개만)
  npComp: null,              // template 의 nowplaying 컴포넌트
  npCtrl: null,               // animation controller
  npElement: null,            // DOM overlay div (live preview 용)
  npLastTrackIdx: -1,         // 곡 변경 감지용

  // Playlist (한 영상에 1개만) — canvas-only.
  plComp: null,              // template 의 playlist 컴포넌트
  plTracks: [],              // [{ title, durationSec }, ...] — session 에서 자동 채움
  plCurrentIdx: 0,

  // Clock (한 영상에 1개만) — canvas-only.
  clockComp: null,           // template 의 clock 컴포넌트

  // 재생 상태
  playing: false,
  rafId: null,

  // 녹화
  recording: false,
  recCancelled: false,
};

// ─── 색상 유틸 (template-editor.js 와 동일 로직) ────────────────────
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
function isDarkColor(hex) {
  if (!hex) return false;
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 110;
}

// ─── 옛/새 schema 어댑터 (Editor 와 동일 결과 산출) ────────────────
function adaptTemplate(cfg) {
  const components = Array.isArray(cfg?.components) ? cfg.components.slice() : [];
  // 옛 schema 변환은 Editor 에서 저장 시점에 새 schema 로 마이그레이션됨 (대부분).
  // 본 함수는 새 schema 만 가정.
  return components;
}

// ─── Time format ──────────────────────────────────────────────────
function fmt(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Empty / Main toggle ──────────────────────────────────────────
function showEmpty() {
  $('#studioEmpty').hidden = false;
  $('#studioMain').hidden = true;
}
function showMain() {
  $('#studioEmpty').hidden = true;
  $('#studioMain').hidden = false;
}

// ─── Background image preload ─────────────────────────────────────
function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ─── 텍스트 렌더 (Canvas 2D) ──────────────────────────────────────
function substituteVars(content, ctx) {
  return String(content || '')
    .replace(/\{\{trackTitle\}\}/g, ctx.trackTitle || '')
    .replace(/\{\{trackNumber\}\}/g, String(ctx.trackNumber || 1))
    .replace(/\{\{totalTracks\}\}/g, String(ctx.totalTracks || 1));
}

function applyTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/\b\w/g, (m) => m.toUpperCase());
  return text;
}

function drawTextComponent(ctx, c, varsCtx) {
  const text = applyTransform(substituteVars(c.content || '', varsCtx), c.textTransform || 'none');
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  let fs = '';
  if (c.bold) fs += 'bold ';
  if (c.italic) fs += 'italic ';
  ctx.font = `${fs}${c.fontSize || 72}px ${c.fontFamily || 'Playfair Display, serif'}`;
  ctx.fillStyle = c.color || '#FFFFFF';
  ctx.textBaseline = 'middle';
  const align = c.textAlign || 'center';
  ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
  if (!isDarkColor(c.color) && (c.glowIntensity ?? 1) > 0) {
    const glow = c.glowIntensity ?? 1;
    ctx.shadowColor = `rgba(212,175,55,${Math.min(1, 0.5 + glow * 0.3)})`;
    ctx.shadowBlur = Math.round(20 * glow);
  }
  const lh = (c.fontSize || 72) * (c.lineHeight ?? 1.2);
  const lines = text.split('\n');
  const totalH = lh * lines.length;
  const startY = c.y + c.height / 2 - totalH / 2 + lh / 2;
  let drawX = c.x + c.width / 2;
  if (align === 'left') drawX = c.x;
  else if (align === 'right') drawX = c.x + c.width;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], drawX, startY + i * lh);
    if (c.underline) {
      const m = ctx.measureText(lines[i]).width;
      let lx = align === 'center' ? drawX - m / 2 : align === 'right' ? drawX - m : drawX;
      ctx.fillRect(lx, startY + i * lh + (c.fontSize || 72) * 0.5, m, (c.fontSize || 72) * 0.06);
    }
  }
  ctx.restore();
}

function drawImageComponent(ctx, c) {
  if (!c._imgObj) return;
  const img = c._imgObj;
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  const fit = c.fit || 'contain';
  const ar = img.naturalWidth / img.naturalHeight;
  const target = c.width / c.height;
  let dw = c.width, dh = c.height, dx = c.x, dy = c.y;
  if (fit === 'contain') {
    if (ar > target) { dh = c.width / ar; dy = c.y + (c.height - dh) / 2; }
    else { dw = c.height * ar; dx = c.x + (c.width - dw) / 2; }
  } else if (fit === 'cover') {
    if (ar > target) { dw = c.height * ar; dx = c.x + (c.width - dw) / 2; }
    else { dh = c.width / ar; dy = c.y + (c.height - dh) / 2; }
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

function drawProgressComponent(ctx, c, varsCtx) {
  const progress = Math.max(0, Math.min(1, varsCtx.totalProgress ?? varsCtx.trackProgress ?? 0));
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  // bg
  ctx.fillStyle = c.bgColor || 'rgba(255,255,255,0.1)';
  const r = Math.min(c.height / 2, 6);
  roundedRect(ctx, c.x, c.y, c.width, c.height, r);
  ctx.fill();
  // fill
  ctx.fillStyle = c.fillColor || '#D4AF37';
  if (progress > 0) {
    roundedRect(ctx, c.x, c.y, c.width * progress, c.height, r);
    ctx.fill();
  }
  ctx.restore();
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
}

// ─── Visualizer 컴포지팅 ──────────────────────────────────────────
function drawVisualizerComponent(ctx, c) {
  const am = studio.visInstances.get(c.id);
  // Phase 4-D-3-D-1: visualizerStyle 따라 분기.
  // - bars / line : AudioMotion 자체 그리기 결과 (am.canvas) 를 drawImage.
  // - wave-time / mirror / mirror-fill : am.getBars() 데이터로 메인 canvas 에 직접 그리기.
  const isCustom = c.visualizerStyle === 'wave-time'
    || c.visualizerStyle === 'mirror'
    || c.visualizerStyle === 'mirror-fill';

  if (isCustom) {
    if (!am) return;
    const amps = getAmplitudes(am);
    drawCustomVisualizer(ctx, c, amps, c.x, c.y, c.width, c.height);
    return;
  }

  const amCv = studio.visCanvases.get(c.id);
  if (!amCv) return;
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  const glow = c.glow ?? 0;
  if (glow > 0) {
    ctx.shadowColor = c.colorMode === 'gradient' ? '#D4AF37' : (c.color || '#D4AF37');
    ctx.shadowBlur = glow;
  }
  ctx.drawImage(amCv, c.x, c.y, c.width, c.height);
  ctx.restore();
}

// ─── 한 frame 그리기 ──────────────────────────────────────────────
function renderFrame() {
  const cv = $('#studioCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // 1) 배경
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (studio.bgImg) {
    const img = studio.bgImg;
    const ar = img.naturalWidth / img.naturalHeight;
    const target = CANVAS_W / CANVAS_H;
    let dw = CANVAS_W, dh = CANVAS_H, dx = 0, dy = 0;
    if (ar > target) { dw = CANVAS_H * ar; dx = (CANVAS_W - dw) / 2; }
    else { dh = CANVAS_W / ar; dy = (CANVAS_H - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // 2) 변수 컨텍스트
  const tracks = studio.session?.tracks || [];
  const idx = studio.currentTrackIdx >= 0 ? studio.currentTrackIdx : 0;
  const cur = tracks[idx];
  const trackTitle = cur?.title || '';
  const trackProgress = cur && cur.durationSec > 0 ? studio.trackElapsed / cur.durationSec : 0;
  const totalProgress = studio.session?.totalDurationSec > 0
    ? studio.globalElapsed / studio.session.totalDurationSec
    : 0;
  const varsCtx = {
    trackTitle,
    trackNumber: idx + 1,
    totalTracks: tracks.length,
    trackProgress,
    totalProgress,
  };

  // 3) 컴포넌트
  for (const c of studio.components) {
    if (c.type === 'text') drawTextComponent(ctx, c, varsCtx);
    else if (c.type === 'image') drawImageComponent(ctx, c);
    else if (c.type === 'progress') drawProgressComponent(ctx, c, varsCtx);
    else if (c.type === 'visualizer') drawVisualizerComponent(ctx, c);
    // NowPlaying 은 항상 마지막 (overlay) — 별도 처리 (DOM + canvas 동기화)
    // Playlist 도 별도 (canvas-only, 곡 idx 가 state)
  }

  // 3-b) Playlist — canvas-only. 미리보기/녹화 동일 (DOM overlay 없음).
  if (studio.plComp && studio.plTracks.length > 0) {
    drawPlaylist(ctx, studio.plComp, studio.plTracks, studio.plCurrentIdx);
  }

  // 3-c) Clock — canvas-only. 곡당 elapsed = audio.currentTime.
  //              loadTrack 에서 audio.src 바꾸면 자동으로 0 으로 리셋 → 곡당 리셋.
  //              녹화 시에도 captureTrackFramesLive 가 실시간 재생하므로 동일하게 정확.
  if (studio.clockComp) {
    const elapsed = studio.audioElement?.currentTime || 0;
    drawClock(ctx, studio.clockComp, elapsed);
  }

  // 4) NowPlaying — 모드별 분기.
  //    재생(미리보기): DOM overlay 만 갱신 (canvas 에 안 그림 → DOM+canvas 이중 표시 방지).
  //    녹화: DOM 숨김 + canvas 에 그리기 (mp4 capture 대상은 canvas).
  if (studio.npComp && studio.npCtrl) {
    const state = studio.npCtrl.stateAt();
    if (studio.recording) {
      if (studio.npElement) studio.npElement.style.visibility = 'hidden';
      drawNPState(ctx, state, studio.npComp);
    } else {
      if (studio.npElement) {
        studio.npElement.style.visibility = '';
        applyNPState(studio.npElement, state, studio.npComp);
      }
    }
  }
}

// ─── NowPlaying 셋업 / 트리거 ─────────────────────────────────────
function setupNowPlaying() {
  destroyNowPlaying();
  const npComp = studio.components.find((c) => c.type === 'nowplaying');
  if (!npComp) return;
  studio.npComp = npComp;
  studio.npCtrl = createNPController(npComp);

  // DOM overlay div — 캔버스 위에 absolute. 캔버스 표시 크기와 동일 비율로 좌표 매핑.
  // host: #studioVisHost (이미 absolute 로 캔버스 위 덮음, pointer-events:none)
  const host = $('#studioVisHost');
  if (!host) return;
  const div = document.createElement('div');
  div.dataset.npRole = 'overlay';
  // canvas world coords 1920×1080 → host % 좌표로 변환
  const leftPct = (npComp.x / CANVAS_W) * 100;
  const topPct = (npComp.y / CANVAS_H) * 100;
  const wPct = (npComp.width / CANVAS_W) * 100;
  const hPct = (npComp.height / CANVAS_H) * 100;
  // fontSize 도 host 의 % 폭 기준으로 스케일 (대략 — 정확한 1:1 은 아니지만 미리보기용)
  const align = npComp.textAlign || 'center';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  div.style.cssText = `
    position:absolute;
    left:${leftPct}%; top:${topPct}%;
    width:${wPct}%; height:${hPct}%;
    display:flex; align-items:center; justify-content:${justify};
    font-family:${npComp.fontFamily || 'system-ui, sans-serif'};
    font-weight:${npComp.bold ? '700' : '400'};
    font-style:${npComp.italic ? 'italic' : 'normal'};
    text-decoration:${npComp.underline ? 'underline' : 'none'};
    color:${npComp.color || '#FFFFFF'};
    text-transform:${npComp.textTransform || 'none'};
    letter-spacing:${npComp.letterSpacing ?? 0}px;
    white-space:nowrap; overflow:visible;
    pointer-events:none; user-select:none;
    opacity:0;
  `;
  // fontSize 는 컨테이너 % 와 무관하게 절대 px (canvas world 기준).
  // 실제 화면 표시는 host 가 캔버스 width 에 맞게 스케일 되므로 vw 로 환산.
  // host 의 width = canvas 의 표시 width. font-size 는 (npComp.fontSize / 1920) * host.clientWidth.
  // 정확한 것은 ResizeObserver 로 해야 하지만, 우선 vw 단위로 근사:
  div.style.fontSize = `calc((${npComp.fontSize || 48} / ${CANVAS_W}) * 100cqw)`;
  div.style.containerType = 'inline-size';

  // host 자체가 container — div 안에 못 두니 host 의 contentBox 를 컨테이너로 쓰려면
  // host 에 containerType 적용. 하지만 host 는 다른 용도로도 쓰임 → 별도 wrapper.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;container-type:inline-size;pointer-events:none;';
  wrap.appendChild(div);
  host.appendChild(wrap);
  studio.npElement = div;
  studio._npWrap = wrap;
}

function destroyNowPlaying() {
  if (studio._npWrap) {
    try { studio._npWrap.remove(); } catch {}
    studio._npWrap = null;
  }
  studio.npElement = null;
  studio.npComp = null;
  studio.npCtrl = null;
  studio.npLastTrackIdx = -1;
}

// ─── Playlist 셋업 / 트리거 (canvas-only) ────────────────────────
function setupPlaylist() {
  destroyPlaylist();
  const plComp = studio.components.find((c) => c.type === 'playlist');
  if (!plComp) return;
  studio.plComp = plComp;
  // session.tracks 에서 { title, durationSec } 추출. 없으면 previewTracks fallback.
  const sessionTracks = studio.session?.tracks || [];
  if (sessionTracks.length > 0) {
    studio.plTracks = sessionTracks.map((t) => ({
      title: t.title || '',
      durationSec: t.durationSec || 0,
    }));
  } else {
    studio.plTracks = (plComp.previewTracks || []).map((t) =>
      typeof t === 'string' ? { title: t, durationSec: 180 } : t
    );
  }
  studio.plCurrentIdx = 0;
}

function destroyPlaylist() {
  studio.plComp = null;
  studio.plTracks = [];
  studio.plCurrentIdx = 0;
}

// 곡 변경 — Playlist 의 강조 idx 갱신. renderFrame 다음 frame 에서 자동 반영.
function onTrackChangeForPlaylist(newIdx) {
  if (!studio.plComp) return;
  studio.plCurrentIdx = newIdx;
}

// ─── Clock 셋업 (canvas-only) ────────────────────────────────────
// 곡당 리셋: audio.currentTime 이 자동으로 곡 시작 시점에 0 으로 reset 됨
//             (loadTrack 에서 audio.src 바꾸면서). 별도 state 불필요.
function setupClock() {
  destroyClock();
  studio.clockComp = studio.components.find((c) => c.type === 'clock') || null;
}
function destroyClock() {
  studio.clockComp = null;
}

// 곡 변경 시 NowPlaying 트리거 — loadTrack 에서 호출.
function onTrackChangeForNP(newIdx) {
  if (!studio.npCtrl || !studio.npComp) return;
  const tracks = studio.session?.tracks || [];
  const newTrack = tracks[newIdx];
  if (!newTrack) return;
  const now = performance.now();

  // 첫 곡: 바로 in. 그 외: out → in (out 끝나면 자동으로 in 시작)
  if (studio.npLastTrackIdx < 0 || studio.npCtrl.phase === 'idle') {
    studio.npCtrl.startIn(newTrack.title, now);
  } else {
    // out 시작 → out 끝나면 in 시작 (chained)
    studio.npCtrl.startOut(now);
    const outDur = studio.npComp.fadeOutMs ?? 500;
    setTimeout(() => {
      // 트랙이 그 사이 또 바뀌었어도 최신 idx 의 title 사용
      const cur = studio.session?.tracks?.[studio.currentTrackIdx];
      const t = cur?.title || newTrack.title;
      studio.npCtrl.startIn(t, performance.now());
    }, outDur);
  }

  studio.npLastTrackIdx = newIdx;
}

// ─── AudioMotion 인스턴스 (visualizer 컴포넌트마다) ──────────────
function audioMotionOptions(c) {
  // Phase 4-D-3-D-1 — Editor 의 audioMotionOptions 와 동일 매핑.
  const effectiveMode = c.visualizerStyle === 'line' ? 10 : (c.mode ?? 3);
  return {
    mode: effectiveMode,
    gradient: c.gradient ?? 'rainbow',
    mirror: c.mirror ?? 0,
    radial: !!c.radial,
    reflexRatio: c.reflexRatio ?? 0,
    reflexAlpha: c.reflexAlpha ?? 1,
    showPeaks: c.showPeaks ?? true,
    showBgColor: false,
    overlay: true,
    ledBars: !!c.ledBars,
    lumiBars: !!c.lumiBars,
    alphaBars: !!c.alphaBars,
    outlineBars: !!c.outlineBars,
    roundBars: !!c.roundBars,
    fillAlpha: c.visualizerStyle === 'line' ? (c.fillOpacity ?? 0.3) : (c.fillAlpha ?? 1),
    lineWidth: c.visualizerStyle === 'line' ? (c.lineWidth ?? 3) : (c.barLineWidth ?? 0),
    minFreq: c.minFreq ?? 30,
    maxFreq: c.maxFreq ?? 20000,
    minDecibels: c.minDecibels ?? -85,
    maxDecibels: c.maxDecibels ?? -25,
    smoothing: c.smoothing ?? 0.5,
    weightingFilter: c.weightingFilter ?? 'D',
    frequencyScale: c.frequencyScale ?? 'log',
    channelLayout: c.channelLayout ?? 'single',
    useCanvas: true,
  };
}

function ensureAudioContext() {
  if (studio.audioCtx) return;
  studio.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
}

function ensureAudioElement() {
  if (studio.audioElement) return;
  ensureAudioContext();
  const a = new Audio();
  a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  studio.audioElement = a;
  studio.audioSource = studio.audioCtx.createMediaElementSource(a);
  studio.audioSource.connect(studio.audioCtx.destination);
  a.addEventListener('ended', onTrackEnded);
  a.addEventListener('timeupdate', onTimeUpdate);
}

function attachVisualizers() {
  // 기존 인스턴스 모두 destroy
  for (const am of studio.visInstances.values()) {
    try { am.destroy(); } catch {}
  }
  studio.visInstances.clear();
  studio.visCanvases.clear();

  const host = $('#studioVisHost');
  if (host) host.innerHTML = '';

  for (const c of studio.components) {
    if (c.type !== 'visualizer') continue;
    // visualizer 마다 hidden div container — AudioMotion 이 자체 canvas 만듦.
    // visible 가 아닌 (호스트는 pointer-events:none) 곳에 두지만, AudioMotion 의 canvas 는
    // ResizeObserver 로 컨테이너 크기에 따름. 그래서 컨테이너 크기를 컴포넌트 크기로 설정.
    const container = document.createElement('div');
    container.style.cssText = `position:absolute;left:0;top:0;width:${c.width}px;height:${c.height}px;visibility:hidden;`;
    host.appendChild(container);

    const am = new AudioMotionAnalyzer(container, {
      ...audioMotionOptions(c),
      audioCtx: studio.audioCtx,
      source: studio.audioSource || undefined,
      connectSpeakers: false,
    });
    studio.visInstances.set(c.id, am);
    studio.visCanvases.set(c.id, am.canvas);
  }
}

// ─── 곡 자동 진행 ─────────────────────────────────────────────────
function loadTrack(idx) {
  const tracks = studio.session?.tracks || [];
  if (idx < 0 || idx >= tracks.length) return false;
  const t = tracks[idx];
  if (!t.audioUrl) {
    setStatus(`⚠ 곡 ${idx + 1} (${t.title}) 의 audio URL 없음 → skip`);
    return false;
  }
  studio.currentTrackIdx = idx;
  studio.audioElement.src = t.audioUrl;
  studio.audioElement.load();
  studio.trackElapsed = 0;
  updateProgressUI();
  // NowPlaying 트리거 — out → in chained
  onTrackChangeForNP(idx);
  // Playlist 강조 갱신
  onTrackChangeForPlaylist(idx);
  return true;
}

function onTrackEnded() {
  const tracks = studio.session?.tracks || [];
  const next = studio.currentTrackIdx + 1;
  if (next >= tracks.length) {
    studio.playing = false;
    setStatus('전체 곡 재생 완료');
    // 마지막 곡 — NowPlaying 페이드아웃
    if (studio.npCtrl) studio.npCtrl.startOut();
    if (studio.recording) {
      finishRecording().catch((e) => console.error('녹화 완료 실패:', e));
    }
    return;
  }
  if (loadTrack(next) && studio.playing) {
    studio.audioElement.play().catch((e) => console.warn('autoplay 실패:', e.message));
  }
}

function onTimeUpdate() {
  const t = studio.session?.tracks?.[studio.currentTrackIdx];
  if (!t) return;
  studio.trackElapsed = studio.audioElement.currentTime;
  studio.globalElapsed = t.startSec + studio.trackElapsed;
  updateProgressUI();
}

function updateProgressUI() {
  const tracks = studio.session?.tracks || [];
  const total = studio.session?.totalDurationSec || 0;
  const idx = studio.currentTrackIdx;
  $('#studioTrackPos').textContent = `${Math.max(1, idx + 1)}/${tracks.length}`;
  $('#studioCurrentTrackTitle').textContent = tracks[idx]?.title || '—';
  $('#studioElapsed').textContent = fmt(studio.globalElapsed);
  $('#studioTotal').textContent = fmt(total);
  const pct = total > 0 ? Math.min(100, (studio.globalElapsed / total) * 100) : 0;
  const bar = $('#studioProgress');
  if (bar) bar.style.width = `${pct}%`;
}

function setStatus(msg) {
  const el = $('#studioStatus');
  if (el) el.textContent = msg;
}

// ─── 재생 컨트롤 ──────────────────────────────────────────────────
async function play() {
  if (!studio.session?.tracks?.length) return;
  ensureAudioElement();
  if (studio.audioCtx.state === 'suspended') {
    try { await studio.audioCtx.resume(); } catch {}
  }
  if (studio.currentTrackIdx < 0) {
    if (!loadTrack(0)) return;
  }
  studio.playing = true;
  try {
    await studio.audioElement.play();
    setStatus(`▶ 재생 중`);
  } catch (e) {
    setStatus(`재생 실패: ${e.message}`);
    studio.playing = false;
  }
  updateButtons();
}

function pause() {
  studio.audioElement?.pause();
  studio.playing = false;
  setStatus('⏸ 일시정지');
  updateButtons();
}

function stop() {
  if (studio.audioElement) {
    studio.audioElement.pause();
    studio.audioElement.currentTime = 0;
  }
  studio.playing = false;
  studio.currentTrackIdx = -1;
  studio.trackElapsed = 0;
  studio.globalElapsed = 0;
  if (studio.npCtrl) {
    studio.npCtrl.reset();
    studio.npLastTrackIdx = -1;
  }
  setStatus('⏹ 정지');
  updateProgressUI();
  updateButtons();
}

function nextTrack() {
  if (!studio.session?.tracks?.length) return;
  const next = studio.currentTrackIdx + 1;
  if (next >= studio.session.tracks.length) return;
  if (loadTrack(next) && studio.playing) {
    studio.audioElement.play().catch(() => {});
  }
}

function updateButtons() {
  $('#studioPlayBtn').disabled = studio.playing;
  $('#studioPauseBtn').disabled = !studio.playing;
  $('#studioStopBtn').disabled = !studio.audioElement || studio.currentTrackIdx < 0;
  $('#studioNextBtn').disabled = !studio.session?.tracks?.length
    || studio.currentTrackIdx >= (studio.session.tracks.length - 1);
}

// ─── RAF 루프 — 매 frame 캔버스 그리기 ──────────────────────────
function startRenderLoop() {
  if (studio.rafId) return;
  const tick = () => {
    renderFrame();
    studio.rafId = requestAnimationFrame(tick);
  };
  studio.rafId = requestAnimationFrame(tick);
}

function stopRenderLoop() {
  if (studio.rafId) {
    cancelAnimationFrame(studio.rafId);
    studio.rafId = null;
  }
}

// ─── Image 컴포넌트 사전 로드 ─────────────────────────────────────
async function preloadImages() {
  const imgComps = studio.components.filter((c) => c.type === 'image' && c.src);
  await Promise.all(imgComps.map(async (c) => {
    c._imgObj = await loadImage(c.src);
  }));
}

// ─── Studio 진입 / 세션 로드 ──────────────────────────────────────
async function loadSession() {
  const raw = sessionStorage.getItem(SS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function bootSession(session) {
  studio.session = session;
  const tpl = session.template || {};
  studio.components = adaptTemplate(tpl.config_json || {});
  studio.bgImg = await loadImage(tpl.background_image_url);

  // 메타 표시
  $('#studioMetaTitle').textContent = session.title || '—';
  $('#studioMetaTrackCount').textContent = String(session.tracks?.length || 0);
  $('#studioMetaDuration').textContent = fmt(session.totalDurationSec || 0);
  $('#studioMetaTemplate').textContent = tpl.name || '(기본)';
  $('#studioCanvasTitle').textContent = session.title || '(미리보기)';

  // 이미지 + AudioMotion + NowPlaying + Playlist + Clock 준비
  await preloadImages();
  ensureAudioElement();
  attachVisualizers();
  setupNowPlaying();
  setupPlaylist();
  setupClock();
  updateProgressUI();
  updateButtons();
  startRenderLoop();
}

window.studioOnEnter = async function studioOnEnter() {
  if (!studio.initialized) {
    bindControls();
    studio.initialized = true;
  }
  const session = await loadSession();
  if (!session) {
    showEmpty();
    return;
  }
  // 같은 buildId 라면 이미 부팅된 거 → render loop 만 보장
  if (studio.session?.buildId === session.buildId && studio.audioElement) {
    showMain();
    startRenderLoop();
    return;
  }
  // 새 세션 — 기존 정리 후 부팅
  teardown();
  showMain();
  await bootSession(session);
};

function teardown() {
  stopRenderLoop();
  if (studio.audioElement) {
    try { studio.audioElement.pause(); } catch {}
    try { studio.audioElement.removeAttribute('src'); studio.audioElement.load(); } catch {}
    studio.audioElement.removeEventListener('ended', onTrackEnded);
    studio.audioElement.removeEventListener('timeupdate', onTimeUpdate);
    studio.audioElement = null;
  }
  if (studio.audioSource) {
    try { studio.audioSource.disconnect(); } catch {}
    studio.audioSource = null;
  }
  for (const am of studio.visInstances.values()) {
    try { am.destroy(); } catch {}
  }
  studio.visInstances.clear();
  studio.visCanvases.clear();
  destroyNowPlaying();
  destroyPlaylist();
  destroyClock();
  studio.session = null;
  studio.components = [];
  studio.bgImg = null;
  studio.currentTrackIdx = -1;
  studio.trackElapsed = 0;
  studio.globalElapsed = 0;
  studio.playing = false;
}

// ─── 이벤트 바인딩 ────────────────────────────────────────────────
function bindControls() {
  $('#studioPlayBtn')?.addEventListener('click', () => play());
  $('#studioPauseBtn')?.addEventListener('click', () => pause());
  $('#studioStopBtn')?.addEventListener('click', () => stop());
  $('#studioNextBtn')?.addEventListener('click', () => nextTrack());

  $('#studioRecordBtn')?.addEventListener('click', () => startRecording());
  $('#studioStopRecBtn')?.addEventListener('click', () => {
    studio.recCancelled = true;
    setRecStatus('🛑 중지 요청 — 현재 frame 마무리 후 저장');
  });

  $('#studioResetBtn')?.addEventListener('click', () => {
    if (!confirm('현재 영상 프로젝트를 종료하고 새로 시작합니다. 계속?')) return;
    sessionStorage.removeItem(SS_KEY);
    teardown();
    showEmpty();
  });
}

// ─── WebCodecs mp4 export ─────────────────────────────────────────
function setRecStatus(msg) {
  const el = $('#studioRecStatus');
  if (el) el.innerHTML = msg;
}

async function startRecording() {
  if (studio.recording) return;
  if (!studio.session?.tracks?.length) {
    setRecStatus('⚠ 세션이 없습니다');
    return;
  }
  if (typeof window.VideoEncoder !== 'function' || typeof window.AudioEncoder !== 'function') {
    setRecStatus('⚠ WebCodecs 미지원 — Chrome 102+ / Edge 102+ 필요');
    return;
  }
  if (typeof globalThis.Mp4Muxer === 'undefined') {
    setRecStatus('⚠ mp4-muxer 가 로드되지 않음 — 페이지 새로고침');
    return;
  }

  studio.recording = true;
  studio.recCancelled = false;
  $('#studioRecordBtn').hidden = true;
  $('#studioStopRecBtn').hidden = false;

  const cv = $('#studioCanvas');
  const muxerTarget = new globalThis.Mp4Muxer.ArrayBufferTarget();
  const muxer = new globalThis.Mp4Muxer.Muxer({
    target: muxerTarget,
    video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  const vEnc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('VideoEncoder error:', e),
  });
  vEnc.configure({
    codec: 'avc1.4d002a',
    width: CANVAS_W,
    height: CANVAS_H,
    bitrate: 8_000_000,
    framerate: FPS,
    latencyMode: 'quality',
  });

  const aEnc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error('AudioEncoder error:', e),
  });
  aEnc.configure({
    codec: 'mp4a.40.2',
    numberOfChannels: 2,
    sampleRate: 48000,
    bitrate: 128_000,
  });

  studio._enc = { muxer, muxerTarget, vEnc, aEnc };

  const tracks = studio.session.tracks;
  const totalDur = studio.session.totalDurationSec;

  setRecStatus(`🎬 녹화 시작 — 총 ${tracks.length}곡 / ${fmt(totalDur)}<br>곡당 실시간 진행`);

  // 트랙 순차로 녹화 — 각 트랙: 오디오 디코드 + 인코드 + 실시간 영상 프레임 캡처
  let globalTime = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (studio.recCancelled) break;
    const t = tracks[i];
    setRecStatus(`🎬 [${i + 1}/${tracks.length}] ${t.title} 준비…`);
    try {
      // 1) 오디오 다운로드 + 디코드
      const ab = await fetch(t.audioUrl).then((r) => r.arrayBuffer());
      const audioBuffer = await studio.audioCtx.decodeAudioData(ab);
      const trackDur = Math.min(audioBuffer.duration, t.durationSec);

      // 2) 오디오 인코딩 (offline — 한 번에 다 인코드)
      await encodeAudioSegment(aEnc, audioBuffer, trackDur, globalTime);

      // 3) 영상 프레임 — 실시간 재생 + 매 30fps 프레임 캡처
      setRecStatus(`🎬 [${i + 1}/${tracks.length}] ${t.title} 영상 캡처 중…`);
      await captureTrackFramesLive(vEnc, cv, i, trackDur, globalTime);

      globalTime += trackDur;
    } catch (e) {
      console.error(`녹화 실패 (track ${t.id}):`, e);
      setRecStatus(`⚠ [${i + 1}/${tracks.length}] ${t.title} 실패: ${e.message}`);
    }
  }

  await finishRecording();
}

async function captureTrackFramesLive(vEnc, canvas, trackIdx, trackDur, globalTimeOffset) {
  if (!loadTrack(trackIdx)) return;
  studio.playing = true;
  if (studio.audioCtx.state === 'suspended') await studio.audioCtx.resume();
  await studio.audioElement.play();

  const totalFrames = Math.floor(trackDur * FPS);
  const keyFrameInterval = FPS * 3;
  const frameInterval = 1000 / FPS;
  const startWall = performance.now();

  for (let f = 0; f < totalFrames; f++) {
    if (studio.recCancelled) break;

    // 30fps 페이싱 — 다음 frame 의 wall-clock 까지 대기
    const targetWall = startWall + f * frameInterval;
    const now = performance.now();
    if (targetWall > now) {
      await new Promise((r) => setTimeout(r, targetWall - now));
    }

    // encoder backpressure
    while (vEnc.encodeQueueSize > 25) {
      await new Promise((r) => setTimeout(r, 0));
      if (studio.recCancelled) break;
    }
    if (studio.recCancelled) break;

    // RAF 가 알아서 캔버스 갱신 중. 현재 frame 그대로 캡처.
    const localTime = f / FPS;
    const ts = Math.round((globalTimeOffset + localTime) * 1e6);
    try {
      const vf = new VideoFrame(canvas, { timestamp: ts });
      vEnc.encode(vf, { keyFrame: f % keyFrameInterval === 0 });
      vf.close();
    } catch (e) {
      console.warn('VideoFrame 인코드 실패:', e.message);
    }

    if (f % 90 === 0) {
      const pct = Math.floor((f / totalFrames) * 100);
      setRecStatus(`🎬 [곡 ${trackIdx + 1}] ${pct}%  (frame ${f}/${totalFrames})`);
    }
  }

  studio.audioElement.pause();
}

async function encodeAudioSegment(encoder, buffer, duration, timeOffset) {
  const sr = buffer.sampleRate;
  const totalSamples = Math.floor(duration * sr);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const chunkSize = 40000;
  for (let i = 0; i < totalSamples; i += chunkSize) {
    if (studio.recCancelled) break;
    const len = Math.min(chunkSize, totalSamples - i);
    const p0 = ch0.slice(i, i + len);
    const p1 = ch1.slice(i, i + len);
    const data = new Float32Array(len * 2);
    data.set(p0, 0);
    data.set(p1, len);
    const ts = Math.round((timeOffset * 1e6) + ((i / sr) * 1e6));
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: sr,
      numberOfFrames: len,
      numberOfChannels: 2,
      timestamp: ts,
      data,
    });
    encoder.encode(ad);
    ad.close();
  }
}

async function finishRecording() {
  const enc = studio._enc;
  if (!enc) return;
  setRecStatus('💾 finalizing…');
  try {
    await enc.vEnc.flush();
    await enc.aEnc.flush();
    enc.muxer.finalize();

    const blob = new Blob([enc.muxerTarget.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = (studio.session?.title || 'pjl').replace(/[^a-zA-Z0-9가-힣\s_\-]/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${safeTitle}_${stamp}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    setRecStatus(`✅ 저장 완료 (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.error('finalize 실패:', e);
    setRecStatus(`⚠ 저장 실패: ${e.message}`);
  } finally {
    studio.recording = false;
    studio.recCancelled = false;
    studio._enc = null;
    $('#studioRecordBtn').hidden = false;
    $('#studioStopRecBtn').hidden = true;
  }
}
