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
  drawStateOnCanvas as drawNPState,
} from './now-playing-animations.js';
import { drawPlaylist } from './playlist-renderer.js';
import { drawClock } from './clock-renderer.js';
import { getAmplitudes, drawCustomVisualizer, isCustomStyle } from './visualizer-styles.js';
import { drawTextComponent } from './text-renderer.js';
import { LoopVideo, createSmoothClock } from './loop-video.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const DEFAULT_FPS = 30;
const SUPPORTED_FPS = [30, 60];
// Phase 4-D-7: 영상 인코더 선택.
//   'software'          = CPU(openh264) 강제 — NVENC hang 경로를 아예 안 탄다. 장시간 렌더 기본값.
//   'hardware'          = GPU 강제 (빠르지만 2026-08-24 사건의 원인).
//   'hardware-fallback' = GPU 로 시작하되 죽으면 CPU 로 자동 전환해 이어서 렌더 (Phase 4-D-8).
//   'auto'              = 브라우저 판단 (WebCodecs 기본값 = no-preference).
const DEFAULT_ENCODER_MODE = 'software';
const ENCODER_MODES = ['software', 'hardware', 'hardware-fallback', 'auto'];
function accelForMode(mode) {
  if (mode === 'software') return 'prefer-software';
  if (mode === 'hardware' || mode === 'hardware-fallback') return 'prefer-hardware';
  return 'no-preference';
}
const SS_KEY = 'pjl.studio.session';

// Phase 4-D-4 polish: fps 별 권장 비트레이트 (1920×1080 jazz lounge 기준).
function bitrateForFps(fps) {
  return fps === 60 ? 12_000_000 : 8_000_000;
}

const studio = {
  initialized: false,
  session: null,             // { buildId, videoId, title, template, tracks, totalDurationSec }
  components: [],            // template 의 components[] (adaptTemplate 결과)
  bgImg: null,               // HTMLImageElement (background)
  // 배경 루프 영상 (템플릿 config_json.backgroundVideo.key) — 있으면 bgImg 대신 그린다.
  bgVideo: null,             // LoopVideo
  bgClock: createSmoothClock(),
  _captureDriven: false,     // 녹화 캡처 루프가 프레임마다 직접 그리는 중 (setInterval 렌더는 쉰다)
  _bgTime: null,             // 캡처 루프가 정해 준 배경 시각(초). null 이면 미리보기 시계.

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
  npLastTrackIdx: -1,         // 곡 변경 감지용

  // Playlist (한 영상에 1개만) — canvas-only.
  plComp: null,              // template 의 playlist 컴포넌트
  plTracks: [],              // [{ title, durationSec }, ...] — session 에서 자동 채움
  plCurrentIdx: 0,

  // Clock (한 영상에 1개만) — canvas-only.
  clockComp: null,           // template 의 clock 컴포넌트

  // 재생 상태
  playing: false,
  renderIntervalId: null,    // setInterval 기반 (Phase 4-D-4 fix v2: 백그라운드 throttle 회피 — RAF 폐기)

  // FPS (Phase 4-D-4 polish)
  fps: DEFAULT_FPS,          // 미리보기/녹화 둘 다 사용. 녹화 시작 시점에 recordingFps 로 스냅샷.
  recordingFps: null,        // 녹화 중에만 set — 녹화 도중 fps 가 바뀌어도 무시되도록 분리.

  // 인코더 선택 (Phase 4-D-7) — fps 와 같은 스냅샷 패턴.
  encoderMode: DEFAULT_ENCODER_MODE,
  recordingEncoder: null,    // 실제로 채택된 모드. 녹화 중에만 set.

  // Phase 4-D-8: GPU → CPU 자동 폴백.
  //   _fallbackConfig 가 있을 때만 폴백이 가능하다 (녹화 시작 전에 소프트웨어 지원을 실측해 채운다).
  //   GPU 인코더가 죽으면 _needFallback 이 켜지고, 캡처 루프가 다음 프레임 직전에 인코더를 갈아끼운다.
  _fallbackConfig: null,     // 폴백용 VideoEncoderConfig (prefer-software, GPU 와 **같은 코덱**)
  _needFallback: false,      // 교체 요청 플래그 (markEncoderDead 가 켬)
  _fallbackDone: false,      // 이미 한 번 갈아탔다 — 두 번은 없다 (CPU 마저 죽으면 그건 진짜 중단)
  _fallbackUsed: false,      // 이 녹화에서 폴백이 실제로 일어났나 (완료 문구/로그용)
  _fallbackReason: null,     // GPU 가 죽은 사유

  // 녹화
  recording: false,
  recCancelled: false,
  wakeLock: null,            // navigator.wakeLock.request('screen') 결과 (녹화 중 화면 sleep 방지)
  visibilityListenerBound: false,

  // 녹화 창 최상위 고정 (Windows 전용 — 서버가 Win32 SetWindowPos 로 처리)
  _topmostHwnd: null,        // 고정된 창 핸들 (해제 시 필요)
  _prevTitle: null,          // 녹화 전 document.title (마커 제거용)

  // Phase 4-D-6: File System Access 스트리밍 저장 (RAM 에 1.8GB blob 안 쌓음 → 비주얼라이저 다수도 안정)
  _saveHandle: null,         // 녹화 시작 시 showSaveFilePicker() 로 확보한 파일 핸들
  _writable: null,           // FileSystemWritableFileStream (녹화 내내 열려 있음)
  _writeChain: null,         // onData write 직렬화용 promise 체인
  _writeError: null,         // 스트리밍 write 중 발생한 첫 에러

  // Phase 4-D-7: 인코더 사망 감지 (2026-08-24 GPU 워치독 kill 사건 대응)
  //   NVENC(하드웨어 H.264)가 hang → Chromium GPU 워치독이 GPU 프로세스를 강제 종료 →
  //   WebCodecs VideoEncoder 가 죽는데, 예전엔 error 콜백이 console 출력만 해서
  //   backpressure while 루프가 영원히 돌며 몇 시간이고 조용히 먹통이 됐음.
  //   이제 사망을 여기 기록하고 recCancelled 를 켜서 즉시 빠져나온 뒤 부분 저장한다.
  _encError: null,           // 사망 사유 (Error) — null 이면 정상
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

// 텍스트 렌더는 text-renderer.js — Template Editor 와 **같은 코드**로 그린다 (미리보기 = 녹화).

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
  // 에디터(.te-progress-track: border-radius 999px)와 같은 알약 모양. 예전엔 6px 고정이라
  // 굵은 바에서 모서리가 달랐다.
  //   모서리는 진짜 원호(ctx.roundRect)로 — quadraticCurve 근사는 CSS 보다 각져 보인다.
  const pill = (x, y, w, h) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  };
  pill(c.x, c.y, c.width, c.height);
  ctx.fill();
  // fill — 에디터처럼 트랙 모양 안으로 잘라 넣는다 (overflow: hidden).
  if (progress > 0) {
    ctx.clip();
    ctx.fillStyle = c.fillColor || '#D4AF37';
    pill(c.x, c.y, c.width * progress, c.height);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Visualizer 컴포지팅 ──────────────────────────────────────────
function drawVisualizerComponent(ctx, c) {
  const am = studio.visInstances.get(c.id);
  // Phase 4-D-3-D-1: visualizerStyle 따라 분기.
  // - bars / line : AudioMotion 자체 그리기 결과 (am.canvas) 를 drawImage.
  // - 그 외 custom 스타일 : am.getBars() 데이터로 메인 canvas 에 직접 그리기.
  //   목록은 visualizer-styles.js 의 isCustomStyle 한 곳에서만 관리한다. 예전엔 여기에 3개를
  //   손으로 적어 놔서, 나중에 추가된 5개(aurora-hills / capsule-bars / reflection-bars /
  //   peak-dots / smoke)가 에디터에선 제 모양인데 Studio·mp4 에선 **AudioMotion 기본 막대**로 나갔다.
  const isCustom = isCustomStyle(c.visualizerStyle);

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
    // Phase 4-D-3-D-1 polish: glow 는 c.glowColor 를 직접 사용 (자동 매칭 X).
    ctx.shadowColor = c.glowColor || '#D4AF37';
    ctx.shadowBlur = glow;
  }
  ctx.drawImage(amCv, c.x, c.y, c.width, c.height);
  ctx.restore();
}

// ─── 한 frame 그리기 ──────────────────────────────────────────────
// Task 3: 컴포넌트 회전 — 중심점 기준으로 캔버스 좌표계를 회전시킨다.
//   각 draw 를 ctx.save()/applyCompRotation()/...draw.../ctx.restore() 로 감싸 사용.
//   rotation(deg) 이 없으면(0/undefined) no-op → 기존 렌더와 동일.
function applyCompRotation(ctx, c) {
  if (!c || !c.rotation) return;
  const cx = c.x + (c.width || 0) / 2;
  const cy = c.y + (c.height || 0) / 2;
  ctx.translate(cx, cy);
  ctx.rotate((c.rotation * Math.PI) / 180);
  ctx.translate(-cx, -cy);
}

function renderFrame() {
  const cv = $('#studioCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // 1) 배경
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  // 영상 배경: 미리보기는 오디오 위치를 따라가고, 녹화는 캡처 루프가 프레임 번호로 정한 시각을 쓴다.
  let bgDrawn = false;
  if (studio.bgVideo) {
    if (studio._bgTime == null) {
      const el = studio.audioElement;
      const media = (studio.session?.tracks?.[studio.currentTrackIdx]?.startSec || 0) + (el?.currentTime || 0);
      studio.bgVideo.tick(studio.bgClock.now(media, !!el && studio.playing && !el.paused));
    }
    bgDrawn = studio.bgVideo.draw(ctx, CANVAS_W, CANVAS_H);
  }
  if (!bgDrawn && studio.bgImg) {
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
    ctx.save();
    applyCompRotation(ctx, c);
    if (c.type === 'text') drawTextComponent(ctx, c, varsCtx);
    else if (c.type === 'image') drawImageComponent(ctx, c);
    else if (c.type === 'progress') drawProgressComponent(ctx, c, varsCtx);
    else if (c.type === 'visualizer') drawVisualizerComponent(ctx, c);
    ctx.restore();
    // NowPlaying 은 항상 마지막 (overlay) — 별도 처리 (DOM + canvas 동기화)
    // Playlist 도 별도 (canvas-only, 곡 idx 가 state)
  }

  // 3-b) Playlist — canvas-only. 미리보기/녹화 동일 (DOM overlay 없음).
  if (studio.plComp && studio.plTracks.length > 0) {
    ctx.save();
    applyCompRotation(ctx, studio.plComp);
    drawPlaylist(ctx, studio.plComp, studio.plTracks, studio.plCurrentIdx);
    ctx.restore();
  }

  // 3-c) Clock — canvas-only. 곡당 elapsed = audio.currentTime.
  //              loadTrack 에서 audio.src 바꾸면 자동으로 0 으로 리셋 → 곡당 리셋.
  //              녹화 시에도 captureTrackFramesLive 가 실시간 재생하므로 동일하게 정확.
  if (studio.clockComp) {
    const elapsed = studio.audioElement?.currentTime || 0;
    ctx.save();
    applyCompRotation(ctx, studio.clockComp);
    drawClock(ctx, studio.clockComp, elapsed);
    ctx.restore();
  }

  // 4) NowPlaying — 항상 canvas 에 그린다.
  //    예전엔 미리보기=DOM overlay / 녹화=canvas 로 갈라져 있어서 Studio 안에서조차
  //    '본 것'과 'mp4' 가 달랐다 (DOM 은 자간 적용·세로 중앙 기준이 canvas 와 다름).
  if (studio.npComp && studio.npCtrl) {
    ctx.save();
    applyCompRotation(ctx, studio.npComp);
    drawNPState(ctx, studio.npCtrl.stateAt(), studio.npComp);
    ctx.restore();
  }
}

// ─── NowPlaying 셋업 / 트리거 ─────────────────────────────────────
function setupNowPlaying() {
  destroyNowPlaying();
  const npComp = studio.components.find((c) => c.type === 'nowplaying');
  if (!npComp) return;
  studio.npComp = npComp;
  studio.npCtrl = createNPController(npComp);

  // DOM overlay 는 없다 — renderFrame 이 canvas 에 직접 그린다 (미리보기 = 녹화).
}

function destroyNowPlaying() {
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
    // Phase 4-D fix: 음역대 (Hz) / dB 축은 mp4 에 들어가지 않도록 default off.
    //   schema 에 필드 없는 기존 컴포넌트도 ?? false 로 자동 적용.
    showScaleX: c.showScaleX ?? false,
    showScaleY: c.showScaleY ?? false,
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
    // Phase 4-D-3-D-1 polish: colorMode 따라 동적 gradient 등록.
    const gradName = registerVisualizerGradient(am, c);
    try { am.setOptions({ gradient: gradName }); } catch {}
    studio.visInstances.set(c.id, am);
    studio.visCanvases.set(c.id, am.canvas);
  }
}

// Editor 의 registerVisualizerGradient 와 동일 로직 (Studio 도 사용).
function registerVisualizerGradient(am, c) {
  if (c.colorMode === 'preset') return c.gradient || 'rainbow';
  const gradName = `pjl-${c.id}`;
  let colorStops;
  if (c.colorMode === 'gradient' && Array.isArray(c.gradientStops) && c.gradientStops.length >= 2) {
    const sorted = [...c.gradientStops].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    colorStops = sorted.map((s) => ({
      pos: Math.max(0, Math.min(1, (s.position ?? 0) / 100)),
      color: s.color || '#FFFFFF',
    }));
  } else {
    const col = c.color || '#D4AF37';
    colorStops = [{ pos: 0, color: col }, { pos: 1, color: col }];
  }
  try {
    am.registerGradient(gradName, { bgColor: '#000', colorStops });
  } catch (e) {
    console.warn('[AudioMotion] registerGradient 실패:', e?.message || e);
    return c.gradient || 'rainbow';
  }
  return gradName;
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
  // 녹화 중엔 startRecording 의 트랙 루프가 곡 진행·finalize 를 전담한다.
  //   audio 'ended' 는 마지막 곡에서 프레임 루프보다 먼저 튈 수 있어(비주얼라이저 부하로 드리프트),
  //   여기서 finishRecording 을 부르면 프레임이 아직 인코딩 중인데 muxer 를 finalize/close 해버려
  //   → 이중 finalize/close, 잘린/깨진 mp4, 저장 실패. 그래서 녹화 중엔 무시.
  if (studio.recording) return;

  const tracks = studio.session?.tracks || [];
  const next = studio.currentTrackIdx + 1;
  if (next >= tracks.length) {
    studio.playing = false;
    setStatus('전체 곡 재생 완료');
    // 마지막 곡 — NowPlaying 페이드아웃
    if (studio.npCtrl) studio.npCtrl.startOut();
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

// ─── 렌더 루프 — setInterval 기반 (Phase 4-D-4 fix v2) ───────────
// requestAnimationFrame 은 백그라운드 탭에서 throttle (보통 1Hz) → 9분 영상 중간에
// 1분 30초 화면 정지 발생. setInterval 은 백그라운드에서도 (Chrome 기준) 1초당 1회까지
// 안정적으로 호출됨 + 활성 탭이라면 정확히 33ms 간격. RAF 보다 훨씬 견고.
// 완벽한 해결책은 OffscreenCanvas + Worker 이지만 우선 setInterval 로 적용.
function startRenderLoop() {
  if (studio.renderIntervalId) return;
  // Phase 4-D-4 polish: studio.fps 따라 페이싱. 60fps 면 16.67ms.
  // 영상 배경으로 녹화 중일 땐 캡처 루프가 프레임마다 직접 그린다 — 여기서 또 그리면 배경이 앞서 나간다.
  studio.renderIntervalId = setInterval(() => { if (!studio._captureDriven) renderFrame(); }, 1000 / studio.fps);
}

function stopRenderLoop() {
  if (studio.renderIntervalId) {
    clearInterval(studio.renderIntervalId);
    studio.renderIntervalId = null;
  }
}

// Phase 4-D-4 polish: fps 변경 시 render loop 재시작 (녹화 중엔 무시 — recordingFps 가 lock).
function applyFpsChange(newFps) {
  if (!SUPPORTED_FPS.includes(newFps)) return;
  if (studio.recording) {
    console.warn('[Studio] 녹화 중 fps 변경 무시 — recordingFps 유지');
    return;
  }
  studio.fps = newFps;
  const fpsLabel = $('#studioCanvasFps');
  if (fpsLabel) fpsLabel.textContent = String(newFps);
  if (studio.renderIntervalId) {
    stopRenderLoop();
    startRenderLoop();
  }
}

// ─── WakeLock + Visibility 감시 (Phase 4-D-4 fix v2) ─────────────
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    console.warn('[REC] WakeLock API 미지원 (구형 브라우저)');
    return;
  }
  try {
    studio.wakeLock = await navigator.wakeLock.request('screen');
    studio.wakeLock.addEventListener('release', () => {
      console.log('[REC] WakeLock released');
    });
    console.log('[REC] WakeLock acquired (화면 sleep 방지)');
  } catch (e) {
    console.warn('[REC] WakeLock 획득 실패:', e?.message || e);
  }
}

function releaseWakeLock() {
  if (!studio.wakeLock) return;
  try { studio.wakeLock.release(); } catch {}
  studio.wakeLock = null;
}

// ─── 녹화 창 최상위 고정 (Windows) ────────────────────────────────
// 브라우저는 스스로 always-on-top 이 될 수 없음 → 탭 타이틀에 '[PJL-REC]' 마커를
// 넣고 로컬 서버에 요청하면, 서버가 Win32 SetWindowPos(HWND_TOPMOST) 로 그 창을
// OS 레벨 최상위로 고정. 다른 창을 아무리 띄워도 녹화 창이 가려지지 않음.
// 실패해도 녹화는 정상 진행 (rAF shim 이 1차 방어선) — 경고 로그만 남김.
async function pinRecordingWindow() {
  studio._prevTitle = document.title;
  document.title = `[PJL-REC] ${document.title}`;
  // OS 창 타이틀에 반영될 시간 확보 후 서버가 타이틀로 창을 찾음.
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = await fetch('/api/window/topmost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok && j.hwnd) {
      studio._topmostHwnd = j.hwnd;
      console.log(`[REC] 📌 녹화 창 최상위 고정 (hwnd=${j.hwnd})`);
    } else {
      console.warn('[REC] 창 최상위 고정 실패 (녹화는 계속):', j.error || `HTTP ${r.status}`);
    }
  } catch (e) {
    console.warn('[REC] 창 최상위 고정 실패 (녹화는 계속):', e?.message || e);
  }
}

async function unpinRecordingWindow() {
  if (studio._prevTitle != null) {
    document.title = studio._prevTitle;
    studio._prevTitle = null;
  }
  const hwnd = studio._topmostHwnd;
  studio._topmostHwnd = null;
  if (!hwnd) return;
  try {
    await fetch('/api/window/topmost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: false, hwnd }),
    });
    console.log('[REC] 📌 창 최상위 고정 해제');
  } catch (e) {
    console.warn('[REC] 창 최상위 해제 실패:', e?.message || e);
  }
}

function showVisibilityWarning() {
  const el = $('#studioVisibilityWarning');
  if (el) el.hidden = false;
}
function hideVisibilityWarning() {
  const el = $('#studioVisibilityWarning');
  if (el) el.hidden = true;
}

function bindVisibilityWatcher() {
  if (studio.visibilityListenerBound) return;
  studio.visibilityListenerBound = true;
  document.addEventListener('visibilitychange', async () => {
    if (!studio.recording) return;
    if (document.hidden) {
      console.warn('[REC] ⚠️ 녹화 탭 백그라운드/가려짐 — rAF shim 폴백으로 계속 진행 (탭 음소거만 금지)');
      showVisibilityWarning();
    } else {
      console.log('[REC] 녹화 탭 활성화 복귀');
      hideVisibilityWarning();
      // WakeLock 은 탭 백그라운드 진입 시 자동 release. 복귀 시 재획득 필요.
      if (!studio.wakeLock) {
        await acquireWakeLock();
      }
    }
  });
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

// 세션에 구워진 signed URL 재발급 — 배경 이미지 + 각 곡 오디오.
//   서버 만료가 둘 다 1시간이라, Builder→Studio 후 1시간 지나 부팅한 세션은
//   URL 이 죽어있음(배경 안 뜸 / 소리 깨짐). 부팅 시점에 새로 받아 교체.
async function refreshSessionUrls(session) {
  // 1) 템플릿 배경 — id 로 재조회하면 서버(signTemplateBg)가 새로 서명해 준다.
  const tplId = session.template?.id;
  if (tplId != null) {
    try {
      const r = await fetch(`/api/templates/${tplId}`);
      const j = await r.json();
      if (r.ok && j.template) session.template = j.template;
    } catch (e) {
      console.warn('[studio] 템플릿 배경 URL 재발급 실패 — 캐시 사용:', e?.message || e);
    }
  }
  // 2) 각 곡 오디오 URL 재발급 (미리보기 재생 + 녹화 시작 시점 대비).
  await Promise.all((session.tracks || []).map(async (t) => {
    if (t?.id == null) return;
    try {
      const r = await fetch(`/api/tracks/${t.id}/audio-url`);
      const j = await r.json();
      if (r.ok && j.ok && j.url) t.audioUrl = j.url;
    } catch (e) {
      console.warn(`[studio] 오디오 URL 재발급 실패 (track ${t.id}) — 캐시 사용:`, e?.message || e);
    }
  }));
}

async function bootSession(session) {
  studio.session = session;

  // Phase 4-D-6: 오래된 세션의 만료 URL 을 부팅 시 새로 발급받아 교체.
  await refreshSessionUrls(session);

  const tpl = session.template || {};
  studio.components = adaptTemplate(tpl.config_json || {});
  studio.bgImg = await loadImage(tpl.background_image_url);
  // 배경 루프 영상 — 폴더에서 지워졌거나 못 읽으면 배경 그림으로 남는다.
  const bgKey = tpl.config_json?.backgroundVideo?.key;
  if (bgKey) {
    try {
      studio.bgVideo = await LoopVideo.load(bgKey, setStatus);
      setStatus(`🎞 배경 영상: ${bgKey} (${studio.bgVideo.meta.source})`);
    } catch (e) {
      console.warn('[studio] 배경 영상 로드 실패:', e);
      setStatus(`⚠ 배경 영상 로드 실패 (${bgKey}): ${e.message}`);
    }
  }

  // 메타 표시
  $('#studioMetaTitle').textContent = session.title || '—';
  $('#studioMetaTrackCount').textContent = String(session.tracks?.length || 0);
  $('#studioMetaDuration').textContent = fmt(session.totalDurationSec || 0);
  $('#studioMetaTemplate').textContent = (tpl.name || '(기본)') + (studio.bgVideo ? ` · 🎞 ${bgKey}` : '');
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
    bindVisibilityWatcher();
    studio.initialized = true;
  }
  // 예약 렌더가 세션을 직접 부팅하는 중 — 여기서 또 부팅하면 두 벌이 겹친다.
  if (studio._queueBoot) {
    showMain();
    return;
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
  studio.bgVideo?.destroy();
  studio.bgVideo = null;
  studio._captureDriven = false;
  studio._bgTime = null;
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

  // Phase 4-D-4 polish: fps dropdown — DOM 초기 값을 studio.fps 와 동기화 + change 바인딩.
  const fpsSelect = $('#studioFpsSelect');
  if (fpsSelect) {
    fpsSelect.value = String(studio.fps);
    fpsSelect.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      applyFpsChange(v);
    });
  }
  // Phase 4-D-7: encoder dropdown — 같은 패턴 (DOM 초기값 동기화 + change 바인딩).
  const encSelect = $('#studioEncoderSelect');
  if (encSelect) {
    encSelect.value = studio.encoderMode;
    encSelect.addEventListener('change', (e) => {
      const v = e.target.value;
      if (!ENCODER_MODES.includes(v)) return;
      // 녹화 중 변경은 무시 — recordingEncoder 가 이미 lock (fps 와 동일 규칙).
      if (studio.recording) {
        console.warn('[Studio] 녹화 중 encoder 변경 무시 — recordingEncoder 유지');
        e.target.value = studio.recordingEncoder || studio.encoderMode;
        return;
      }
      studio.encoderMode = v;
      console.log(`[Studio] 인코더 모드 → ${v}`);
    });
  }
  // 초기 캔버스 메타 라벨 동기화
  const fpsLabel = $('#studioCanvasFps');
  if (fpsLabel) fpsLabel.textContent = String(studio.fps);
}

// ─── WebCodecs mp4 export ─────────────────────────────────────────
// Phase 4-D-7: 요청한 인코더 모드가 실제로 되는지 미리 확인한다.
//   hardwareAcceleration 은 브라우저/코덱 조합에 따라 거부될 수 있고, 그 경우
//   configure() 가 그 자리에서 던져 녹화가 시작조차 못 한다 → 미리 확인해서 폴백.
async function resolveVideoEncoderConfig(fps, bitrate, mode) {
  const base = {
    width: CANVAS_W,
    height: CANVAS_H,
    bitrate,
    framerate: fps,
    latencyMode: 'quality',
  };
  // Phase 4-D-7 fix: 소프트웨어 H.264 는 **Main profile 을 인코딩하지 못한다.**
  //   Chromium 번들 인코더(openh264)는 baseline / constrained baseline 만 지원해서
  //   'prefer-software' + avc1.4d..(Main) 조합은 isConfigSupported 가 false 를 준다.
  //   → 예전 구현은 그대로 no-preference 로 떨어졌고, 결국 **다시 NVENC 를 타서**
  //     소프트웨어를 골라도 GPU hang 이 그대로 재현됐다 (2026-08-24 03:04 렌더).
  //   그래서 소프트웨어 모드에서는 baseline 후보들을 순서대로 시도한다.
  //   1080p60 은 level 4.2 필요 (4.0 은 1080p30 까지) → 뒤 2자리 2a = level 4.2.
  const SOFTWARE_CODECS = [
    'avc1.42E02A',  // constrained baseline L4.2 — openh264 가 가장 확실히 받는 형태
    'avc1.42002A',  // baseline L4.2
    'avc1.4D002A',  // Main L4.2 — 소프트웨어가 Main 을 지원하는 구현이면 이게 최선
  ];
  const HARDWARE_CODECS = ['avc1.4D002A', 'avc1.42E02A'];
  // Phase 4-D-8: 폴백 모드는 **처음부터 baseline** 으로 GPU 인코딩한다.
  //   mp4-muxer 는 두 번째 decoderConfig 를 Object.assign 으로 덮어쓰고(avcC 는 하나뿐),
  //   annexb(인밴드 SPS/PPS)를 지원하지 않는다 → 중간에 프로파일이 바뀌면 **앞부분이 깨진다.**
  //   GPU(Main) → CPU(baseline) 전환은 정확히 그 경우라, 아예 양쪽을 baseline 으로 맞춰둔다.
  //   화질 손해(CABAC 없음)는 이 콘텐츠에선 무의미 — 12Mbps 목표에 실측 1.75Mbps 로 나온다.
  const FALLBACK_READY_CODECS = ['avc1.42E02A', 'avc1.42002A'];

  const accel = accelForMode(mode);
  const candidates = mode === 'software' ? SOFTWARE_CODECS
    : mode === 'hardware-fallback' ? FALLBACK_READY_CODECS
    : HARDWARE_CODECS;
  for (const codec of candidates) {
    const cfg = { ...base, codec, hardwareAcceleration: accel };
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup?.supported) return { config: cfg, mode, fellBack: false };
    } catch (e) {
      console.warn(`[REC] isConfigSupported(${codec}, ${accel}) 실패:`, e?.message || e);
    }
  }

  // 요청한 가속 모드로는 어떤 코덱도 안 됨 → 가속 지정 없이 재시도.
  //   주의: 소프트웨어를 원했는데 여기로 오면 하드웨어(NVENC)를 타게 된다.
  //   그건 조용히 넘길 일이 아니라 호출부가 크게 경고해야 하는 상황이다.
  for (const codec of ['avc1.4D002A', 'avc1.42E02A']) {
    const cfg = { ...base, codec, hardwareAcceleration: 'no-preference' };
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup?.supported) {
        console.warn(`[REC] '${mode}' 로는 인코더를 못 잡음 — no-preference/${codec} 로 폴백`);
        return { config: cfg, mode: 'auto', fellBack: true };
      }
    } catch (e) {
      console.warn(`[REC] isConfigSupported(${codec}, no-preference) 실패:`, e?.message || e);
    }
  }
  // 최후: 검증 없이 기존 기본값 — configure() 가 던지면 거기서 잡힌다.
  return { config: { ...base, codec: 'avc1.4D002A' }, mode: 'auto', fellBack: true };
}

// Phase 4-D-8: 폴백용 소프트웨어 config 를 **녹화 시작 전에** 실측해 둔다.
//   자리를 비운 사이 GPU 가 죽고 나서야 "소프트웨어도 안 되네" 를 알게 되면 폴백은 무의미하다.
//   avcC 박스는 파일에 하나뿐이므로 **GPU 와 같은 코덱 문자열**로 잡히는 경우만 안전하다.
//   같은 코덱이 안 되면 같은 profile(앞 2자리 = 42 baseline)까지는 허용하되 경고를 남긴다.
async function resolveSoftwareFallbackConfig(gpuConfig) {
  const wanted = gpuConfig.codec;
  const sameProfile = (a, b) => a.slice(5, 7).toLowerCase() === b.slice(5, 7).toLowerCase();
  const candidates = [wanted, 'avc1.42E02A', 'avc1.42002A'];
  for (const codec of candidates) {
    const cfg = { ...gpuConfig, codec, hardwareAcceleration: 'prefer-software' };
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (!sup?.supported) continue;
      if (codec !== wanted) {
        if (!sameProfile(codec, wanted)) {
          // profile 이 다르면 갈아탄 뒤 avcC 가 덮여 앞부분이 깨진다 → 폴백을 포기하는 게 낫다.
          console.warn(`[REC] 폴백 후보 ${codec} 는 GPU(${wanted}) 와 profile 이 달라 건너뜀`);
          continue;
        }
        console.warn(`[REC] 폴백 코덱이 GPU 와 다름 (${wanted} → ${codec}) — profile 은 같아 진행`);
      }
      return cfg;
    } catch (e) {
      console.warn(`[REC] 폴백 isConfigSupported(${codec}) 실패:`, e?.message || e);
    }
  }
  return null;
}

// Phase 4-D-8: VideoEncoder 생성 한 곳으로 — 폴백 때 같은 배선으로 새로 만들어야 한다.
//   error 콜백은 **자기가 현역일 때만** 사망을 보고한다. 교체된 옛 인코더가 close() 직후
//   뒤늦게 error 를 뱉는 경우가 있고, 그걸 그대로 받으면 방금 살린 녹화를 도로 중단시킨다.
function createVideoEncoder(config, muxer) {
  let self;
  self = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      if (studio._enc && studio._enc.vEnc !== self) {
        console.warn('[REC] 교체된 옛 VideoEncoder 의 뒤늦은 error — 무시:', e?.message || e);
        return;
      }
      markEncoderDead('VideoEncoder', e);
    },
  });
  self.configure(config);
  return self;
}

function canFallbackNow() {
  return !!studio._fallbackConfig && !studio._fallbackDone && !studio.recCancelled;
}

// Phase 4-D-8: 죽은 GPU 인코더를 CPU 인코더로 갈아끼운다. muxer 는 그대로 유지 —
//   같은 mp4 에 이어서 쓴다 (코덱/profile 을 baseline 으로 맞춰뒀기에 avcC 가 덮여도 호환).
//   죽은 인코더에 flush() 를 걸면 reject 되므로 하지 않는다 → 큐에 남은 몇 프레임은 포기.
function swapToSoftwareEncoder() {
  const enc = studio._enc;
  const old = enc.vEnc;
  try {
    if (old && old.state !== 'closed') old.close();
  } catch (e) {
    console.warn('[REC] 죽은 인코더 close 실패 (무시):', e?.message || e);
  }
  // 두 번째 폴백은 없다 — 여기서 실패하든 성공하든 이번 녹화의 폴백 기회는 소진된다.
  //   (먼저 세워둬야 아래 markEncoderDead 가 canFallbackNow()=false 를 보고 진짜 중단으로 간다.)
  studio._fallbackDone = true;
  studio._needFallback = false;
  let fresh;
  try {
    fresh = createVideoEncoder(studio._fallbackConfig, enc.muxer);
  } catch (e) {
    // 시작 전 isConfigSupported 는 통과했는데 실제 configure 가 던진 경우 — 더 할 수 있는 게 없다.
    console.error('[REC] 소프트웨어 인코더 생성 실패 — 폴백 포기:', e);
    markEncoderDead('VideoEncoder(폴백 생성 실패)', e);
    return null;
  }
  enc.vEnc = fresh;
  studio._fallbackUsed = true;
  console.warn(`[REC] ✅ 소프트웨어 인코더로 전환 완료 (${studio._fallbackConfig.codec}) — 렌더 계속`);
  setRecStatus(
    '🔄 GPU 인코더가 죽어 <b>CPU 인코더로 전환</b>했습니다 — 렌더는 계속됩니다.<br>' +
    `사유: ${studio._fallbackReason || '알 수 없음'}`
  );
  return fresh;
}

// Phase 4-D-7: 인코더 사망 판정 — 어디서 감지했든 여기 한 곳으로 모은다.
//   호출 즉시 recCancelled 를 켜므로 캡처 루프 / 곡 루프가 다음 체크에서 빠져나오고,
//   finishRecording() 이 지금까지 인코딩된 분량을 정상 mp4 로 마감한다.
//   자리를 비운 사이 죽어도 알아채도록 탭 제목에 마커를 붙인다.
//   Phase 4-D-8: 단, **영상 인코더 + 폴백 가능** 이면 중단하지 않고 교체를 요청한다.
function markEncoderDead(which, err) {
  const msg = err?.message || String(err || 'unknown');
  if (which === 'VideoEncoder' && canFallbackNow()) {
    if (!studio._needFallback) {
      studio._needFallback = true;
      studio._fallbackReason = msg;
      console.warn(`[REC] ${which} 사망 — 소프트웨어 인코더로 전환 예약:`, err);
      setRecStatus(`⚠ GPU 인코더 사망 (${msg})<br>CPU 인코더로 전환 중…`);
    }
    return;  // recCancelled 를 켜지 않는다 — 캡처 루프가 다음 프레임 직전에 갈아끼운다.
  }
  console.error(`[REC] ${which} 사망 — 녹화 중단:`, err);
  if (!studio._encError) {
    studio._encError = new Error(`${which} 사망: ${msg}`);
    // 탭 제목 마커는 여기서 안 붙인다 — 녹화 중 제목은 pinRecordingWindow() 가
    // `[PJL-REC] …` 로 점유 중이고 unpinRecordingWindow() 가 되돌려 지워버린다.
    // 자리 비운 사이 알아채라고 남기는 마커는 finishRecording() 마감 후에 붙인다.
    setRecStatus(
      `⚠ ${which} 가 죽었습니다 (${msg})<br>` +
      (studio._fallbackUsed
        // Phase 4-D-8: 이미 CPU 로 갈아탄 뒤라면 GPU hang 이 아니다 — 오진 문구를 띄우지 않는다.
        ? '이미 CPU 인코더로 전환한 뒤였습니다 (두 번째 폴백은 없음) — 여기까지 분량을 저장합니다.'
        : 'GPU 하드웨어 인코더 hang 으로 추정 — 여기까지 분량을 저장합니다.')
    );
  }
  studio.recCancelled = true;
}

function setRecStatus(msg) {
  const el = $('#studioRecStatus');
  if (el) el.innerHTML = msg;
}

// opts.sink — 예약 렌더용. { name, write({position,data}), close(), abort() } 를 주면 저장 창을
//   띄우지 않고 거기로 흘려보낸다 (FileSystemWritableFileStream 과 같은 모양 → 아래 경로 그대로).
async function startRecording(opts = {}) {
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

  // Phase 4-D-6: 저장 위치를 '지금'(사용자 클릭 제스처가 살아있는 이 순간) 확보.
  //   → 30분 뒤 자리를 비워도/탭이 백그라운드여도 자동 다운로드 차단 없이 디스크로 직접 저장.
  //   → mp4 조각을 스트리밍으로 바로 파일에 흘려보내 RAM 에 1.8GB blob 을 안 쌓음
  //     (비주얼라이저 6개+ 처럼 무거운 구성에서 메모리 초과 크래시 방지 — 이게 진짜 병목이었음).
  //   showSaveFilePicker 는 secure context 필요(localhost 는 OK), Chrome/Edge 지원.
  // 재진입 차단(더블클릭 레이스): showSaveFilePicker/createWritable await 동안 두 번째 클릭이
  //   또 다른 녹화 파이프라인을 띄우면 studio._writable/_enc 등을 덮어써 스트림 충돌 → mp4 깨짐.
  //   맨 위 guard `if (studio.recording) return` 이 막도록 await 전에 동기적으로 잠근다.
  studio.recording = true;
  studio._saveHandle = null;
  studio._writable = null;
  studio._writeChain = Promise.resolve();
  studio._writeError = null;
  studio._recTrackErrors = [];
  if (opts.sink) {
    studio._writable = opts.sink;
    studio._saveHandle = { name: opts.sink.name };
  } else if (typeof window.showSaveFilePicker === 'function') {
    const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle0 = (studio.session?.title || 'pjl').replace(/[^a-zA-Z0-9가-힣\s_\-]/g, '_').slice(0, 60);
    try {
      studio._saveHandle = await window.showSaveFilePicker({
        suggestedName: `${safeTitle0}_${stamp0}.mp4`,
        startIn: 'downloads',
        types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      // createWritable 은 swap 파일에 쓰고 close() 시점에 원본을 교체 → 크래시 나도 기존 파일 보존.
      studio._writable = await studio._saveHandle.createWritable();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        studio.recording = false; // 잠금 해제 — 다시 시작 가능
        setRecStatus('저장 위치 선택 취소 — 녹화 시작 안 함');
        return;
      }
      // 미지원/기타 오류 → in-memory blob 자동 다운로드 폴백으로 진행.
      console.warn('[REC] File System Access 실패 — 자동 다운로드 폴백:', e?.message || e);
      studio._saveHandle = null;
      studio._writable = null;
    }
  }

  studio.recording = true;
  studio.recCancelled = false;
  // Phase 4-D-4 polish: fps 스냅샷 — 이 녹화 한 건 동안 고정. UI 가 바뀌어도 영향 없음.
  studio.recordingFps = studio.fps;
  const recFps = studio.recordingFps;
  const recBitrate = bitrateForFps(recFps);
  // Phase 4-D-7: 인코더 모드도 같은 시점에 스냅샷 + 실지원 확인.
  studio.recordingEncoder = studio.encoderMode;
  const wantedMode = studio.encoderMode;   // vConf.fellBack 이 recordingEncoder 를 덮으므로 원본 보관
  const vConf = await resolveVideoEncoderConfig(recFps, recBitrate, studio.recordingEncoder);
  if (vConf.fellBack) {
    const wanted = studio.recordingEncoder;
    studio.recordingEncoder = vConf.mode;
    // 소프트웨어를 원했는데 폴백됐다 = 결국 GPU(NVENC)를 탄다 = hang 위험 그대로.
    // 조용히 넘기면 30분 뒤에야 알게 되므로 시작 전에 크게 경고하고 잠깐 멈춘다.
    if (wanted === 'software') {
      console.error('[REC] ⚠ 소프트웨어 인코더를 못 잡음 — GPU 인코더로 진행됨 (hang 위험)');
      setRecStatus(
        '⚠ <b>소프트웨어 인코더를 쓸 수 없어 GPU 인코더로 진행합니다.</b><br>' +
        '이 브라우저가 CPU H.264 인코딩을 지원하지 않습니다 — 장시간 렌더 중 GPU hang 위험이 남아 있습니다.<br>' +
        '5초 뒤 시작합니다. 중단하려면 지금 페이지를 새로고침하세요.'
      );
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      setRecStatus(`ℹ 요청한 인코더를 쓸 수 없어 '${vConf.mode}' 로 진행합니다`);
    }
  }

  // Phase 4-D-8: 자동 폴백 준비. 매 녹화마다 상태를 초기화한다 (앞 녹화의 잔재가 남으면
  //   _fallbackDone=true 로 굳어 이번 녹화가 폴백 기회를 잃는다).
  studio._fallbackConfig = null;
  studio._needFallback = false;
  studio._fallbackDone = false;
  studio._fallbackUsed = false;
  studio._fallbackReason = null;
  if (wantedMode === 'hardware-fallback') {
    studio._fallbackConfig = await resolveSoftwareFallbackConfig(vConf.config);
    if (studio._fallbackConfig) {
      console.log(
        `[REC] 자동 폴백 준비 완료 — GPU ${vConf.config.codec} 사망 시 CPU ${studio._fallbackConfig.codec} 로 전환`
      );
    } else {
      // 폴백을 믿고 자리를 비우는 게 이 모드의 존재 이유다. 불가능하면 반드시 지금 알려야 한다.
      console.error('[REC] ⚠ 자동 폴백 불가 — 이 브라우저에서 소프트웨어 인코더를 못 잡음');
      setRecStatus(
        '⚠ <b>자동 폴백을 쓸 수 없습니다</b> — 이 브라우저가 CPU H.264 인코딩을 지원하지 않습니다.<br>' +
        'GPU 인코더로만 진행하며, 죽으면 그 지점까지만 저장됩니다 (하드웨어 모드와 동일).<br>' +
        '5초 뒤 시작합니다. 중단하려면 지금 페이지를 새로고침하세요.'
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  $('#studioRecordBtn').hidden = true;
  $('#studioStopRecBtn').hidden = false;
  const fpsSelect = $('#studioFpsSelect');
  if (fpsSelect) fpsSelect.disabled = true;
  const encSelect = $('#studioEncoderSelect');
  if (encSelect) encSelect.disabled = true;

  // Phase 4-D-4 fix v2: WakeLock 으로 화면 sleep 방지 + 현재 visibility 즉시 점검.
  await acquireWakeLock();
  // 녹화 창을 OS 최상위로 고정 — 듀얼모니터에서 다른 창이 덮어도 안 가려짐.
  await pinRecordingWindow();
  if (document.hidden) showVisibilityWarning();

  const cv = $('#studioCanvas');

  // Phase 4-D-4 fix: ArrayBufferTarget + 'in-memory' 는 ~1.5GB+ 영상에서
  // finalize 시 단일 ArrayBuffer 합치기 실패 (RangeError). StreamTarget 으로
  // 청크별 누적 + Blob 변환 — 큰 파일도 메모리 안정.
  // fastStart:false → metadata at end (sequential append-only writes).
  const muxerChunks = [];
  let muxerMaxEnd = 0;
  const muxerTarget = new globalThis.Mp4Muxer.StreamTarget({
    onData(data, position) {
      // muxer 가 buffer 재사용 가능 → 즉시 복사
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      if (studio._writable) {
        // 스트리밍 저장: 조각이 나오는 즉시 디스크로 write (RAM 누적 X).
        //   write 는 async 이므로 순서 보장을 위해 promise 체인으로 직렬화.
        studio._writeChain = studio._writeChain
          .then(() => studio._writable.write({ type: 'write', position, data: copy }))
          .catch((e) => { if (!studio._writeError) studio._writeError = e; });
      } else {
        // 폴백: 메모리에 쌓아 finalize 때 Blob 다운로드.
        muxerChunks.push({ data: copy, position });
      }
      const end = position + data.byteLength;
      if (end > muxerMaxEnd) muxerMaxEnd = end;
    },
    chunked: true,
    chunkSize: 16 * 1024 * 1024,  // default 16 MiB
  });
  const muxer = new globalThis.Mp4Muxer.Muxer({
    target: muxerTarget,
    video: { codec: 'avc', width: CANVAS_W, height: CANVAS_H, frameRate: recFps },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });

  // Phase 4-D-8: 앞 녹화의 _enc 가 남아 있으면 createVideoEncoder 의 '현역 확인'이
  //   새 인코더를 남의 것으로 오판해 error 를 삼킨다 → 생성 전에 지운다.
  studio._enc = null;
  const vEnc = createVideoEncoder(vConf.config, muxer);
  console.log(
    `[REC] 영상 인코더 = ${vConf.mode} (hardwareAcceleration=${vConf.config.hardwareAcceleration}, codec=${vConf.config.codec})`
  );

  const aEnc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => markEncoderDead('AudioEncoder', e),
  });
  aEnc.configure({
    codec: 'mp4a.40.2',
    numberOfChannels: 2,
    sampleRate: 48000,
    bitrate: 128_000,
  });

  studio._enc = { muxer, muxerChunks, getMuxerMaxEnd: () => muxerMaxEnd, vEnc, aEnc };

  const tracks = studio.session.tracks;
  const totalDur = studio.session.totalDurationSec;

  const encLabel = studio.recordingEncoder === 'software' ? '소프트웨어(CPU)'
    : studio.recordingEncoder === 'hardware' ? '하드웨어(GPU)'
    : studio.recordingEncoder === 'hardware-fallback'
      ? (studio._fallbackConfig ? '하드웨어(GPU) + 자동 폴백' : '하드웨어(GPU) · 폴백 불가')
      : '자동';
  setRecStatus(
    `🎬 녹화 시작 — 총 ${tracks.length}곡 / ${fmt(totalDur)} @ ${recFps}fps · 인코더 ${encLabel}<br>곡당 실시간 진행`
  );

  // 트랙 순차로 녹화 — 각 트랙: 오디오 디코드 + 인코드 + 실시간 영상 프레임 캡처
  let globalTime = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (studio.recCancelled) break;
    const t = tracks[i];
    setRecStatus(`🎬 [${i + 1}/${tracks.length}] ${t.title} 준비…`);
    try {
      // 1) 오디오 다운로드 + 디코드
      //    녹화 직전 오디오 URL 을 새로 발급 — 긴 녹화 도중 1시간 만료로 뒷곡이 죽는 것 방지.
      try {
        const ur = await fetch(`/api/tracks/${t.id}/audio-url`);
        const uj = await ur.json();
        if (ur.ok && uj.ok && uj.url) t.audioUrl = uj.url;
      } catch (e) {
        console.warn(`[REC] 오디오 URL 재발급 실패 (track ${t.id}) — 기존 URL 사용:`, e?.message || e);
      }
      const ab = await fetch(t.audioUrl).then((r) => r.arrayBuffer());
      const audioBuffer = await studio.audioCtx.decodeAudioData(ab);
      const trackDur = Math.min(audioBuffer.duration, t.durationSec);

      // 2) 오디오 인코딩 (offline — 한 번에 다 인코드)
      await encodeAudioSegment(aEnc, audioBuffer, trackDur, globalTime);

      // 3) 영상 프레임 — 실시간 재생 + 매 fps 프레임 캡처
      setRecStatus(`🎬 [${i + 1}/${tracks.length}] ${t.title} 영상 캡처 중…`);
      // Phase 4-D-8: 폴백으로 교체됐을 수 있으므로 **항상 현재 인코더**를 넘긴다 (vEnc 는 초기값일 뿐).
      await captureTrackFramesLive(studio._enc.vEnc, cv, i, trackDur, globalTime, recFps);

      globalTime += trackDur;
    } catch (e) {
      console.error(`녹화 실패 (track ${t.id}):`, e);
      studio._recTrackErrors.push(`${t.title}: ${e?.message || e}`);
      // Phase 4-D-7: 인코더 사망이 원인이면 markEncoderDead 가 띄운 안내를 덮지 않는다.
      //   (죽은 인코더에 encode 하면 여기로 InvalidStateError 가 떨어진다.)
      if (!studio._encError) {
        setRecStatus(`⚠ [${i + 1}/${tracks.length}] ${t.title} 실패: ${e.message}`);
      }
    }
  }

  await finishRecording();
}

async function captureTrackFramesLive(vEncInit, canvas, trackIdx, trackDur, globalTimeOffset, fps) {
  if (!loadTrack(trackIdx)) return;
  studio.playing = true;
  if (studio.audioCtx.state === 'suspended') await studio.audioCtx.resume();
  await studio.audioElement.play();

  const totalFrames = Math.floor(trackDur * fps);
  const keyFrameInterval = fps * 3;          // 3초마다 keyframe (fps 와 무관하게 시간 기준)
  const frameInterval = 1000 / fps;
  const startWall = performance.now();
  // Phase 4-D-4 fix v2: backpressure 임계값 25→5 — 인코더가 밀리는 즉시 캡처를 늦춤.
  // 60fps 에선 frame 이 2배라 queue 도 빠르게 차오르므로 동일 임계값 유지 (latency 짧음).
  const MAX_QUEUE_SIZE = 5;
  // Phase 4-D-7: 큐가 이 시간 동안 안 빠지면 인코더 사망으로 판정.
  //   GPU 프로세스가 워치독에 kill 되면 encodeQueueSize 가 영영 안 내려가고
  //   error 콜백조차 안 오는 경우가 있어 시간 기준 탈출구가 반드시 필요하다.
  //   실시간 캡처라 정상이면 큐는 수십 ms 안에 빠진다 — 10초면 넉넉히 사망.
  const QUEUE_STALL_MS = 10_000;
  // VideoFrame 생성/encode 가 연속 실패하면 GPU 컨텍스트 유실로 본다 (1초치).
  const MAX_ENCODE_FAIL_STREAK = fps;
  let encodeFailStreak = 0;
  // 진단 로그 — 1초당 1회 출력 (fps 무관하게 빈도 일정).
  const logInterval = fps;
  const statusInterval = fps * 3;            // status 텍스트는 3초마다

  // Phase 4-D-8: 인코더는 렌더 도중 교체될 수 있다 (GPU 사망 → CPU).
  let vEnc = vEncInit;
  let forceKeyFrame = false;   // 교체 직후 첫 프레임은 반드시 keyframe 이어야 한다.
  let justSwapped = false;     // 방금 갈아탔나 — 아래 '따라잡기' f 점프의 트리거.

  // 영상 배경이면 캡처 루프가 직접 그린다: 찍는 프레임마다 배경의 정확히 그 시각 프레임을 올리고
  //   곧바로 캔버스를 그려 찍는다. (setInterval 렌더와 캡처가 따로 돌면 두 60Hz 가 어긋나
  //   배경이 가끔 한 프레임씩 겹치거나 건너뛴다.) 배경 그림만 쓰는 템플릿은 예전 그대로다.
  const bgVideo = studio.bgVideo;
  studio._captureDriven = !!bgVideo;

  // 교체가 예약돼 있으면 지금 갈아끼운다. 갈아탔으면 true.
  const maybeSwapEncoder = () => {
    if (!studio._needFallback) return false;
    const fresh = swapToSoftwareEncoder();
    if (!fresh) return false;   // 교체 실패 — swapToSoftwareEncoder 가 이미 중단 처리했다.
    vEnc = fresh;
    forceKeyFrame = true;
    encodeFailStreak = 0;
    return true;
  };

  for (let f = 0; f < totalFrames; f++) {
    if (studio.recCancelled) break;
    // 디스크 write 실패(디스크 참/USB 분리/read-only) 감지 시 즉시 중단 — 30분 다 돌고 실패 방지.
    if (studio._writeError) { studio.recCancelled = true; break; }
    // Phase 4-D-7: 인코더 사망 감지 — error 콜백이 이미 켰거나, state 로 직접 확인.
    if (studio._encError) break;
    // Phase 4-D-8: 사망 보고가 들어와 있으면 중단이 아니라 교체로 처리한다.
    if (studio._needFallback) {
      if (maybeSwapEncoder()) justSwapped = true;
      else break;   // 교체까지 실패 = 더는 살릴 방법이 없다
    }
    if (vEnc.state !== 'configured') {
      markEncoderDead('VideoEncoder', new Error(`state=${vEnc.state}`));
      if (maybeSwapEncoder()) justSwapped = true;
      else break;
    }

    // Phase 4-D-8: 교체에 걸린 시간만큼 프레임을 건너뛴다.
    //   오디오는 이미 offline 인코딩됐고 캔버스는 audioElement 재생 위치를 따라 그려지므로,
    //   밀린 프레임을 몰아서 넣으면 그 구간만 같은 그림이 복제되고 이후 A/V 가 어긋난다.
    //   현재 wall-clock 에 해당하는 f 로 점프하면 그 구간은 정지 화면이 되지만 싱크는 유지된다.
    if (justSwapped) {
      const catchUp = Math.floor((performance.now() - startWall) / frameInterval);
      if (catchUp > f) {
        console.warn(`[REC] 인코더 교체로 ${catchUp - f}프레임 건너뜀 (f ${f} → ${catchUp}) — A/V 싱크 유지`);
        f = catchUp;
      }
      justSwapped = false;
      if (f >= totalFrames) break;
    }

    // 페이싱 — 다음 frame 의 wall-clock 까지 대기
    const targetWall = startWall + f * frameInterval;
    const now = performance.now();
    if (targetWall > now) {
      await new Promise((r) => setTimeout(r, targetWall - now));
    }

    // encoder backpressure — 단, 영원히 기다리지 않는다 (Phase 4-D-7).
    const stallStart = performance.now();
    while (vEnc.encodeQueueSize > MAX_QUEUE_SIZE) {
      if (studio.recCancelled) break;
      // 인코더가 닫혔으면 큐는 절대 안 빠진다 → 즉시 사망 판정.
      if (vEnc.state !== 'configured') {
        markEncoderDead('VideoEncoder', new Error(`state=${vEnc.state} (인코더가 닫힘)`));
        break;
      }
      // 살아있는 척하며 멈춘 경우 (GPU 프로세스 kill 직후) → 시간으로 잡는다.
      if (performance.now() - stallStart > QUEUE_STALL_MS) {
        markEncoderDead(
          'VideoEncoder',
          new Error(`인코더 큐가 ${QUEUE_STALL_MS / 1000}초간 안 빠짐 (queue=${vEnc.encodeQueueSize})`)
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    if (studio.recCancelled) break;
    // Phase 4-D-8: 위 while 에서 사망 판정이 났으면 죽은 인코더에 encode 하기 전에 갈아끼운다.
    //   (여기서 교체하면 이번 프레임부터 바로 새 인코더로 들어간다 — 한 프레임도 안 버린다.)
    if (studio._needFallback) {
      if (maybeSwapEncoder()) justSwapped = true;
      else break;   // 교체까지 실패 = 더는 살릴 방법이 없다
    } else if (studio._encError) {
      break;
    }

    // 캔버스는 setInterval 루프에서 매 (1000/fps)ms 갱신 중. 현재 frame 그대로 캡처.
    const localTime = f / fps;
    const ts = Math.round((globalTimeOffset + localTime) * 1e6);
    if (bgVideo) {
      studio._bgTime = globalTimeOffset + localTime;
      await bgVideo.ensure(studio._bgTime);
      renderFrame();
    }
    try {
      const vf = new VideoFrame(canvas, { timestamp: ts });
      vEnc.encode(vf, { keyFrame: forceKeyFrame || f % keyFrameInterval === 0 });
      vf.close();
      forceKeyFrame = false;
      encodeFailStreak = 0;
    } catch (e) {
      console.warn('VideoFrame 인코드 실패:', e.message);
      // Phase 4-D-7: 한두 번은 일시적일 수 있으나 계속 실패하면 GPU/인코더가 죽은 것.
      //   (예전엔 여기서 warn 만 하고 끝까지 돌아 빈 영상이 나왔음.)
      if (++encodeFailStreak >= MAX_ENCODE_FAIL_STREAK) {
        markEncoderDead('VideoEncoder', new Error(`연속 ${encodeFailStreak}프레임 인코드 실패: ${e.message}`));
        if (maybeSwapEncoder()) justSwapped = true;
        else break;
      }
    }

    // Phase 4-D-4 fix v2: 매 1초 마다 진단 로그 — throttle / 인코더 밀림 / 메모리 누수 추적.
    if (f % logInterval === 0) {
      const queueSize = vEnc.encodeQueueSize;
      const memMB = performance.memory?.usedJSHeapSize
        ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0)
        : '?';
      const elapsedSec = (f / fps).toFixed(1);
      const wallSec = ((performance.now() - startWall) / 1000).toFixed(1);
      const drift = (wallSec - elapsedSec).toFixed(1);
      // Phase 4-D-8: enc= 를 같이 찍는다 — 어느 인코더로 돌고 있었는지 로그만 보고 확정할 수 있게.
      //   (2026-08-24 사건 때 이걸 안 찍어서 '하드웨어였나 소프트웨어였나' 를 사후에 알 수 없었다.)
      const encTag = studio._fallbackUsed ? 'CPU(폴백)' : (studio.recordingEncoder || '?');
      console.log(
        `[REC] fps=${fps} enc=${encTag} track=${trackIdx + 1} frame=${f}/${totalFrames} time=${elapsedSec}s wall=${wallSec}s drift=${drift}s queue=${queueSize} mem=${memMB}MB hidden=${document.hidden}`
      );
    }

    if (f % statusInterval === 0) {
      const pct = Math.floor((f / totalFrames) * 100);
      setRecStatus(`🎬 [곡 ${trackIdx + 1}] ${pct}%  (frame ${f}/${totalFrames}) @ ${fps}fps`);
    }
  }

  studio._captureDriven = false;
  studio._bgTime = null;
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
    // Phase 4-D-7: 인코더가 닫혔으면 더 밀어넣지 않는다.
    if (encoder.state !== 'configured') {
      markEncoderDead('AudioEncoder', new Error(`state=${encoder.state}`));
      break;
    }
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

// Phase 4-D-5-A: mp4 export 성공 직후 호출 — 곡 사용 이력을 백엔드에 기록.
// videoId 는 클라이언트 측 ID (현재 시각). 백엔드에 별도 video 테이블 join 없이 추적 가능.
async function recordTrackUsage(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const videoId = `vid_${stamp}`;
  const records = tracks
    .filter((t) => t && t.id != null)
    .map((t, idx) => ({
      track_id: t.id,
      video_id: videoId,
      track_position: idx + 1,
    }));
  if (!records.length) return;
  const r = await fetch('/api/tracks/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${txt}`);
  }
  const j = await r.json();
  console.log(`[REC] 사용 이력 ${j.recorded || records.length} 곡 기록 (videoId=${videoId})`);
}

// File System Access 폴백 — 강화된 자동 다운로드.
//   앵커를 DOM 에 append 후 click + revoke 를 넉넉히 지연 → 대용량 blob 저장 안정화
//   (기존엔 append 없이 5초 후 revoke → 대용량/백그라운드에서 간헐 실패).
function downloadBlobFallback(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeTitle = (studio.session?.title || 'pjl').replace(/[^a-zA-Z0-9가-힣\s_\-]/g, '_').slice(0, 60);
  a.href = url;
  a.download = `${safeTitle}_${stamp}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// mp4 저장 성공 직후 — DB 프로젝트 상태를 'done'(export 완료)으로 전환.
//   draft 로만 남던 유령 프로젝트와 실제로 영상이 나온 것을 구분하기 위함.
async function markVideoDone(videoId) {
  if (!videoId) return;
  try {
    await fetch(`/api/videos/${videoId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
  } catch (e) {
    console.warn('[REC] 영상 상태(done) 갱신 실패:', e?.message || e);
  }
}

// Phase 4-D-7: flush 는 "되면 좋고" — 실패해도 지금까지 인코딩된 분량은 살린다.
async function safeFlush(enc, name) {
  if (!enc) return;
  if (enc.state === 'closed') {
    console.warn(`[REC] ${name} 이미 closed — flush 생략`);
    return;
  }
  try {
    await enc.flush();
  } catch (e) {
    console.warn(`[REC] ${name} flush 실패 (무시하고 마감 진행):`, e?.message || e);
  }
}

async function finishRecording() {
  const enc = studio._enc;
  if (!enc) return;
  if (studio._finishing) return;  // 이중 호출 방지 (동시 진입 차단)
  studio._finishing = true;
  setRecStatus(studio._encError ? '💾 인코더 사망 — 여기까지 분량 마감 중…' : '💾 finalizing…');
  // Phase 4-D-8: 폴백이 있었으면 완료 문구에 남긴다 — 결과물은 온전하지만 '무슨 일이 있었는지'는 알아야 한다.
  const fbNote = studio._fallbackUsed
    ? `<br>🔄 렌더 도중 GPU→CPU 인코더 전환이 있었습니다 (사유: ${studio._fallbackReason || '알 수 없음'})`
    : '';
  if (studio._fallbackUsed) {
    console.warn(`[REC] 이 녹화는 자동 폴백을 사용했습니다 — 사유: ${studio._fallbackReason}`);
  }
  // 예약 렌더가 결과를 읽는다 (studio._lastResult). saved = 파일이 디스크에 온전히 마감됨.
  let saved = false;
  let failMsg = null;
  try {
    // Phase 4-D-7: 죽은 인코더에 flush() 를 걸면 reject 된다.
    //   예전엔 그게 catch 로 튀어 _writable.abort() → **녹화분 전체 삭제**로 이어졌다.
    //   flush 실패는 삼키고 muxer 에 이미 들어간 chunk 로 finalize 를 진행한다.
    await safeFlush(enc.vEnc, 'VideoEncoder');
    await safeFlush(enc.aEnc, 'AudioEncoder');
    enc.muxer.finalize();

    if (studio._writable) {
      // ── 스트리밍 저장 경로 (File System Access) ──────────────────────────
      // onData 가 녹화 내내 디스크로 직접 write 함. 남은 write 완료 대기 후 close.
      // 1.8GB blob 을 RAM 에 만들지 않으므로 비주얼라이저 다수(6개+)에도 메모리 안정.
      await studio._writeChain;
      if (studio._writeError) throw studio._writeError;
      // 한 프레임도 안 써졌으면(시작 직후 정지) 빈 파일 → 폐기(0바이트 방지).
      if (enc.getMuxerMaxEnd() === 0) {
        try { await studio._writable.abort(); } catch {}
        setRecStatus('저장할 내용이 없어 취소됨');
        return;
      }
      // 정지(recCancelled)여도 지금까지 인코딩+finalize 된 부분은 유효한 mp4 → 저장한다.
      await studio._writable.close();
      saved = true;
      const mb = (enc.getMuxerMaxEnd() / 1048576).toFixed(1);
      const fname = studio._saveHandle?.name || 'video.mp4';
      if (studio._encError) {
        setRecStatus(
          `⚠ 인코더 사망으로 중단 — 여기까지만 저장됨: ${fname} (${mb} MB)<br>` +
          `사유: ${studio._encError.message}`
        );
      } else {
        const partial = studio.recCancelled ? ' (정지 — 부분 저장)' : '';
        setRecStatus(`✅ 저장 완료${partial} — ${fname} (${mb} MB)${fbNote}`);
      }
    } else {
      // ── 폴백: in-memory Blob + 자동 다운로드 (File System Access 미지원/취소 시) ──
      // Phase 4-D-4 fix: StreamTarget 청크 → Blob (단일 ArrayBuffer 합치지 않음).
      // fastStart:false 이므로 sequential append-only 가 보장되지만, 안전을 위해 정렬 + 검증.
      const writes = enc.muxerChunks;
      writes.sort((a, b) => a.position - b.position);

      let sequential = true;
      let expectedPos = 0;
      for (const w of writes) {
        if (w.position !== expectedPos) { sequential = false; break; }
        expectedPos += w.data.byteLength;
      }

      let blob;
      if (sequential) {
        blob = new Blob(writes.map((w) => w.data), { type: 'video/mp4' });
      } else {
        console.warn('[muxer] non-sequential writes 감지 — sparse buffer fallback');
        const total = enc.getMuxerMaxEnd();
        const buf = new Uint8Array(total);
        for (const w of writes) buf.set(w.data, w.position);
        blob = new Blob([buf], { type: 'video/mp4' });
      }

      if (!blob || blob.size === 0) {
        setRecStatus('저장할 내용이 없어 취소됨');
        return;
      }
      // 정지여도 지금까지 걸 다운로드 (부분 저장).
      downloadBlobFallback(blob);
      saved = true;
      const mb2 = (blob.size / 1024 / 1024).toFixed(1);
      if (studio._encError) {
        setRecStatus(`⚠ 인코더 사망으로 중단 — 여기까지만 저장됨 (${mb2} MB)<br>사유: ${studio._encError.message}`);
      } else {
        const partial = studio.recCancelled ? ' (정지 — 부분 저장)' : '';
        setRecStatus(`✅ 저장 완료${partial} (${mb2} MB)${fbNote}`);
      }
    }

    // Phase 4-D-7: 인코더가 죽어 반쪽만 나온 건 '완성'이 아니다.
    //   곡 사용 이력을 박아버리면 안 쓴 곡이 소진 처리되고,
    //   status=done 이 되면 유령 draft 와 구분이 안 된다 → 둘 다 건너뛴다.
    if (studio._encError) {
      console.warn('[REC] 인코더 사망 — 사용 이력/done 처리 건너뜀 (재렌더 필요)');
      return;
    }

    // Phase 4-D-5-A: 사용 이력 기록 — 저장 성공 시점에만.
    // 취소/예외 시점엔 위에서 return 되거나 catch 로 빠지므로 여기 도달 X.
    try {
      await recordTrackUsage(studio.session?.tracks || []);
    } catch (e) {
      console.warn('[REC] 사용 이력 기록 실패:', e?.message || e);
    }
    // 저장 성공 → DB 상태 draft → done 으로 전환 (유령 draft 와 구분).
    await markVideoDone(studio.session?.videoId);
  } catch (e) {
    console.error('finalize 실패:', e);
    saved = false;
    failMsg = e?.message || String(e);
    // Phase 4-D-7: abort() 는 swap 파일을 폐기해 **녹화분 전체를 날린다**.
    //   먼저 close() 로 디스크에 남기고, 그것마저 실패할 때만 abort.
    //   moov 가 없으면 그냥은 재생 안 되지만 untrunc 등으로 복구할 여지는 남는다.
    let rescued = false;
    try {
      await studio._writeChain;
      if (studio._writable && enc.getMuxerMaxEnd() > 0) {
        await studio._writable.close();
        rescued = true;
      }
    } catch (e2) {
      console.warn('[REC] 부분 저장 close 실패 — 폐기:', e2?.message || e2);
      try { await studio._writable?.abort(); } catch {}
    }
    if (rescued) {
      const mb = (enc.getMuxerMaxEnd() / 1048576).toFixed(1);
      setRecStatus(
        `⚠ 마감 실패: ${e.message}<br>` +
        `녹화분 ${mb} MB 는 디스크에 남겼습니다 (moov 누락 — 그대로는 재생 불가).`
      );
    } else {
      setRecStatus(`⚠ 저장 실패: ${e.message}`);
    }
  } finally {
    // Phase 4-D-7: 초기화하기 전에 사망 여부를 잡아둔다 (아래 제목 마커용).
    const diedMsg = studio._encError?.message || null;
    studio._lastResult = {
      saved,
      cancelled: !!studio.recCancelled && !diedMsg,
      died: diedMsg,
      error: failMsg,
      bytes: enc.getMuxerMaxEnd(),
      trackErrors: studio._recTrackErrors || [],
      fallbackUsed: !!studio._fallbackUsed,
    };
    studio.recording = false;
    studio.recCancelled = false;
    studio.recordingFps = null;
    studio.recordingEncoder = null;
    studio._enc = null;
    studio._writable = null;
    studio._writeChain = null;
    studio._writeError = null;
    studio._encError = null;
    studio._saveHandle = null;
    studio._finishing = false;
    releaseWakeLock();
    unpinRecordingWindow(); // fire-and-forget — 실패해도 저장엔 영향 없음
    // unpin 은 첫 await 전에 document.title 을 동기적으로 되돌린다 → 그 직후에 마커를 얹어야
    // 지워지지 않는다. 자리를 비운 사이 죽어도 탭 제목만 보고 바로 알아챌 수 있다.
    if (diedMsg) document.title = `⚠ 인코더 사망 — ${document.title}`;
    hideVisibilityWarning();
    $('#studioRecordBtn').hidden = false;
    $('#studioStopRecBtn').hidden = true;
    const fpsSelect = $('#studioFpsSelect');
    if (fpsSelect) fpsSelect.disabled = false;
    const encSelect = $('#studioEncoderSelect');
    if (encSelect) encSelect.disabled = false;
  }
}

// ─── Phase 4-D-8: 자동 폴백 수동 테스트 훅 ─────────────────────────────
// studio.js 는 ESM 이라 콘솔에서 내부 함수를 부를 수 없다. 그런데 폴백은 GPU 가 실제로
// 죽어야 발동하고 그건 마음대로 재현되지 않는다(산발적) → 그 경로를 강제로 태울 수단을 남긴다.
//   pjlKillEncoder()  렌더 중 실행 → GPU 사망으로 보고 → 폴백 준비됐으면 CPU 로 전환하고 계속
//   pjlStudio         상태 객체 (recordingEncoder / _fallback* 플래그 확인용)
window.pjlKillEncoder = (reason = '수동 테스트 강제 사망') => {
  if (!studio.recording) { console.warn('[REC] 녹화 중이 아닙니다 — 무시'); return; }
  console.warn('[REC] 수동 테스트: 인코더 사망을 강제 보고합니다');
  markEncoderDead('VideoEncoder', new Error(reason));
};
window.pjlStudio = studio;

// ─── 예약 렌더 진입점 (render-queue.js) ───────────────────────────────
// 세션을 Studio 에 올리고 → 저장 창 없이 sink 로 녹화 → 결과(studio._lastResult)를 돌려준다.
// 사람이 [Studio 로 이동] → [녹화] 를 누르는 것과 같은 코드를 탄다. 다른 것은 저장 위치뿐.
window.pjlStudioRunQueued = async function pjlStudioRunQueued(session, sink, { fps } = {}) {
  if (studio.recording) throw new Error('이미 녹화 중입니다');
  if (!studio.initialized) {
    bindControls();
    bindVisibilityWatcher();
    studio.initialized = true;
  }
  studio._queueBoot = true;
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(session));
    window.switchTab?.('studio');
    teardown();
    showMain();
    await bootSession(session);
  } finally {
    studio._queueBoot = false;
  }
  // 자는 동안 도는 렌더다 — 배경 영상이 안 올라왔으면 엉뚱한 화면으로 30분을 굽지 말고 실패로 남긴다.
  const bgKey = session.template?.config_json?.backgroundVideo?.key;
  if (bgKey && !studio.bgVideo) throw new Error(`배경 영상을 못 불러옴: ${bgKey}`);
  if (fps && fps !== studio.fps) {
    applyFpsChange(fps);
    const sel = $('#studioFpsSelect');
    if (sel) sel.value = String(fps);
  }
  studio._lastResult = null;
  await startRecording({ sink });
  return studio._lastResult;
};
