// 이펙트 필터 — 화면 전체에 얹는 분위기 효과 (비·눈·보케·필름 그레인 …).
//
// Template Editor 와 Studio(=mp4) 가 **이 파일 하나로** 그린다 (CLAUDE.md 규칙 9: 미리보기 = 녹화).
//
// 그리는 약속:
//   · drawEffect(ctx, fx, W, H, dt) 는 **비어 있는 투명 레이어**에 보통 합성(source-over)으로 그린다.
//     레이어 안에서는 source-in / destination-in 같은 마스크를 마음껏 써도 된다 (밑 그림을 안 건드리니까).
//   · 그 레이어를 밑 그림에 얹을 때 blend(screen·overlay …)와 opacity 를 건다.
//     Studio 는 drawEffectsOnto() 가 임시 canvas 에 그린 뒤 얹고, 에디터는 이펙트마다 canvas 를 두고
//     CSS mix-blend-mode 로 얹는다 — 두 쪽 모두 "레이어를 통째로 얹는" 같은 계산이다.
//   · 시간은 dt(초)로 흐른다. Studio 는 1/fps 고정(녹화가 밀려도 영상 속 속도는 일정),
//     에디터는 실제 흐른 시간.
//
// 템플릿 저장 형태: config_json.effects = [{ id, type, enabled, layer, opacity, blend, ...값 }]
//   layer 'front' = 모든 것 위 · 'back' = 배경 바로 위(글자·비주얼라이저 뒤).
//
// 새 이펙트를 넣으려면 EFFECT_TYPES 에 한 덩어리(label · blend · params · draw)만 추가하면 된다 —
// 에디터의 목록과 슬라이더는 params 표에서 저절로 만들어진다.

const TAU = Math.PI * 2;
const rand = Math.random;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexToRgb(hex) {
  let h = String(hex || '#FFFFFF').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(a, 0, 1)})`;
const mixRgb = (a, b, k) => [
  Math.round(a[0] + (b[0] - a[0]) * k),
  Math.round(a[1] + (b[1] - a[1]) * k),
  Math.round(a[2] + (b[2] - a[2]) * k),
];

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

// ─── 미리 구워 두는 그림 (스프라이트) ─────────────────────────────
// 입자마다 radial gradient 를 새로 만들면 수백 개에서 느려진다 → 한 번 굽고 drawImage.
const _sprites = new Map();
function cached(key, build) {
  let s = _sprites.get(key);
  if (!s) {
    if (_sprites.size > 160) _sprites.clear();
    s = build();
    _sprites.set(key, s);
  }
  return s;
}

// 부드러운 점. softness 0 = 또렷한 원, 1 = 가운데부터 풀리는 빛.
function softDot(rgb, softness) {
  const q = Math.round(clamp(softness, 0, 1) * 10);
  return cached(`dot|${rgb}|${q}`, () => {
    const S = 64;
    const cv = makeCanvas(S, S);
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, rgba(rgb, 1));
    grad.addColorStop(clamp((1 - q / 10) * 0.85, 0.01, 0.9), rgba(rgb, 1));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return cv;
  });
}

// 보케 한 알 — 가운데는 옅고 가장자리가 살짝 밝은 렌즈 빛망울.
function bokehDisc(rgb, softness, ring) {
  const qs = Math.round(clamp(softness, 0, 1) * 10);
  const qr = Math.round(clamp(ring, 0, 1) * 10);
  return cached(`bokeh|${rgb}|${qs}|${qr}`, () => {
    const S = 160;
    const c = S / 2;
    const cv = makeCanvas(S, S);
    const g = cv.getContext('2d');
    const edge = clamp(0.97 - (qs / 10) * 0.8, 0.12, 0.97);
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, rgba(rgb, 0.55));
    grad.addColorStop(edge, rgba(rgb, 0.7));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    if (qr > 0) {
      g.strokeStyle = rgba(rgb, (qr / 10) * 0.75);
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(c, c, Math.max(4, c * edge - 2), 0, TAU);
      g.stroke();
    }
    return cv;
  });
}

// 필름 그레인 타일 — 회색 잡음. overlay 로 얹으면 128(중간 회색)은 아무 영향이 없다.
function grainTiles() {
  return cached('grain', () => {
    const tiles = [];
    for (let k = 0; k < 4; k++) {
      const S = 256;
      const cv = makeCanvas(S, S);
      const g = cv.getContext('2d');
      const img = g.createImageData(S, S);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (rand() + rand() + rand() - 1.5) * 150;   // 종 모양 분포 (필름 입자 느낌)
        img.data[i] = img.data[i + 1] = img.data[i + 2] = clamp(v, 0, 255);
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      tiles.push(cv);
    }
    return tiles;
  });
}

// 안개 결 — 부드러운 덩어리를 흩뿌린 흰 그림. 가로로 이어 붙여도 이음새가 없다.
function fogTexture(seed) {
  return cached(`fog|${seed}`, () => {
    const TW = 1024;
    const TH = 512;
    const cv = makeCanvas(TW, TH);
    const g = cv.getContext('2d');
    for (let i = 0; i < 70; i++) {
      const r = 70 + rand() * 150;
      const cx = rand() * TW;
      const cy = TH * (0.2 + rand() * 0.6);
      const a = 0.05 + rand() * 0.1;
      for (const ox of [-TW, 0, TW]) {
        if (cx + ox + r < 0 || cx + ox - r > TW) continue;
        const grad = g.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, r);
        grad.addColorStop(0, `rgba(255,255,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(cx + ox - r, cy - r, r * 2, r * 2);
      }
    }
    return cv;
  });
}

// 입자 수를 목표에 맞춘다. 새로 생기는 건 make(true) = 화면 전체에 흩뿌려 놓기(처음부터 가득).
function fitCount(list, n, make) {
  while (list.length < n) list.push(make(true));
  if (list.length > n) list.length = n;
  return list;
}

// ─── 이펙트 정의 ──────────────────────────────────────────────────
// params: { key, label, min, max, step, def, suffix? } = 슬라이더
//         { key, label, type: 'color', def }           = 색
//         { key, label, type: 'select', options, def } = 고르기
//         { key, label, type: 'bool', def }            = 체크

export const EFFECT_TYPES = {
  // ── 날씨 ──────────────────────────────────────────────────────
  rain: {
    label: '🌧 비',
    blend: 'screen',
    params: [
      { key: 'amount', label: '양', min: 0.02, max: 1, step: 0.01, def: 0.35 },
      { key: 'speed', label: '속도', min: 0.2, max: 3, step: 0.05, def: 1 },
      { key: 'angle', label: '방향 (기울기)', min: -60, max: 60, step: 1, def: 12, suffix: '°' },
      { key: 'length', label: '빗줄기 길이', min: 0.2, max: 4, step: 0.05, def: 1.5 },
      { key: 'thickness', label: '빗줄기 굵기', min: 0.5, max: 5, step: 0.1, def: 1.4 },
      { key: 'depth', label: '원근 (멀고 가까움)', min: 0, max: 1, step: 0.05, def: 0.7 },
      { key: 'splash', label: '바닥 물 튐', min: 0, max: 1, step: 0.05, def: 0.3 },
      { key: 'lightning', label: '번개', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'color', label: '색', type: 'color', def: '#CFE3FF' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const ang = (p('angle') * Math.PI) / 180;
      const dx = Math.sin(ang);
      const dy = Math.cos(ang);
      const reach = H * Math.tan(Math.abs(ang));
      const xMin = dx > 0 ? -reach : 0;
      const xMax = dx < 0 ? W + reach : W;
      const depth = p('depth');
      const make = (anywhere) => ({
        x: xMin + rand() * (xMax - xMin),
        y: anywhere ? rand() * H : -rand() * H * 0.25 - 20,
        z: 1 - depth * (1 - (0.3 + Math.pow(rand(), 1.6) * 0.7)),
      });
      const drops = fitCount(st.drops || (st.drops = []), Math.round(p('amount') * 900), make);
      const speed = 1500 * p('speed');
      const lenK = 30 * p('length') * (0.6 + 0.4 * p('speed'));
      const thick = p('thickness');
      const rgb = hexToRgb(p('color'));
      const splashAmt = p('splash');
      if (!st.splashes) st.splashes = [];

      // 깊이 세 묶음으로 나눠 한 번에 긋는다 (묶음마다 굵기·진하기가 다르다)
      const buckets = [[], [], []];
      for (const d of drops) {
        const v = speed * (0.55 + 0.45 * d.z);
        d.x += dx * v * dt;
        d.y += dy * v * dt;
        const len = lenK * (0.5 + d.z);
        if (d.y - len * dy > H) {
          if (splashAmt > 0 && st.splashes.length < 160 && rand() < splashAmt * d.z * 0.6) {
            st.splashes.push({ x: d.x - (d.y - H) * Math.tan(ang), y: H - rand() * H * 0.05 * (1.2 - d.z), life: 1, z: d.z });
          }
          Object.assign(d, make(false));
          continue;
        }
        buckets[d.z > 0.75 ? 2 : d.z > 0.5 ? 1 : 0].push(d, len);
      }
      ctx.lineCap = 'round';
      for (let b = 0; b < 3; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        const z = 0.4 + b * 0.3;
        ctx.strokeStyle = rgba(rgb, 0.22 + 0.55 * z);
        ctx.lineWidth = Math.max(0.5, thick * (0.45 + 0.6 * z));
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) {
          const d = list[i];
          const len = list[i + 1];
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - dx * len, d.y - dy * len);
        }
        ctx.stroke();
      }
      // 바닥에서 튀는 물 — 납작하게 퍼지는 고리
      for (let i = st.splashes.length - 1; i >= 0; i--) {
        const s = st.splashes[i];
        s.life -= dt * 4.5;
        if (s.life <= 0) { st.splashes.splice(i, 1); continue; }
        const r = (1 - s.life) * 16 * (0.5 + s.z);
        ctx.strokeStyle = rgba(rgb, s.life * 0.55);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, r, r * 0.32, 0, Math.PI, TAU);
        ctx.stroke();
      }
      // 번개 — 가끔 번쩍, 두세 번 깜빡이며 사그라든다
      const lightning = p('lightning');
      if (lightning > 0 && rand() < lightning * 0.14 * dt) { st.flash = 1; st.flashSeed = rand() * 10; }
      if (st.flash > 0.01) {
        st.flash *= Math.exp(-dt * 5);
        const flicker = 0.6 + 0.4 * Math.sin(st.t * 55 + (st.flashSeed || 0));
        ctx.fillStyle = `rgba(215, 228, 255, ${clamp(st.flash * flicker * 0.5, 0, 1)})`;
        ctx.fillRect(0, 0, W, H);
      }
    },
  },

  snow: {
    label: '❄ 눈',
    blend: 'normal',
    params: [
      { key: 'amount', label: '양', min: 0.02, max: 1, step: 0.01, def: 0.35 },
      { key: 'speed', label: '속도', min: 0.1, max: 3, step: 0.05, def: 1 },
      { key: 'wind', label: '방향 (바람)', min: -1.5, max: 1.5, step: 0.05, def: 0.2 },
      { key: 'size', label: '눈송이 크기', min: 0.3, max: 3, step: 0.05, def: 1.2 },
      { key: 'sway', label: '흔들림', min: 0, max: 3, step: 0.05, def: 1 },
      { key: 'softness', label: '흐림 (초점 밖)', min: 0, max: 1, step: 0.05, def: 0.6 },
      { key: 'depth', label: '원근 (멀고 가까움)', min: 0, max: 1, step: 0.05, def: 0.8 },
      { key: 'color', label: '색', type: 'color', def: '#FFFFFF' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const depth = p('depth');
      const make = (anywhere) => ({
        x: rand() * W,
        y: anywhere ? rand() * H : -20,
        z: 1 - depth * (1 - (0.15 + Math.pow(rand(), 1.8) * 0.85)),
        ph: rand() * TAU,
        r: 0.7 + rand() * 0.6,
      });
      const flakes = fitCount(st.flakes || (st.flakes = []), Math.round(p('amount') * 600), make);
      const speed = p('speed');
      const wind = p('wind');
      const sway = p('sway');
      const size = p('size');
      const soft = p('softness');
      const rgb = hexToRgb(p('color'));
      // 가까운 눈은 또렷하게, 먼 눈은 흐리게 — 두 가지 스프라이트
      const near = softDot(rgb, soft * 0.6);
      const far = softDot(rgb, clamp(soft * 0.6 + 0.4, 0, 1));
      for (const f of flakes) {
        f.ph += dt * (0.8 + f.z);
        f.y += 90 * speed * (0.35 + f.z) * dt;
        f.x += (wind * 160 * speed * (0.35 + f.z) + Math.sin(f.ph) * sway * 25 * (0.5 + f.z)) * dt;
        const s = (2 + 7 * f.z * f.z) * size * f.r;
        if (f.y - s > H) { Object.assign(f, make(false)); continue; }
        if (f.x < -s * 2) f.x += W + s * 4;
        else if (f.x > W + s * 2) f.x -= W + s * 4;
        ctx.globalAlpha = 0.3 + 0.7 * f.z;
        ctx.drawImage(f.z > 0.55 ? near : far, f.x - s, f.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    },
  },

  fog: {
    label: '🌫 안개',
    blend: 'normal',
    params: [
      { key: 'density', label: '짙기', min: 0.05, max: 1, step: 0.01, def: 0.45 },
      { key: 'speed', label: '흐르는 속도', min: 0, max: 3, step: 0.05, def: 1 },
      { key: 'direction', label: '방향', type: 'select', options: [['1', '오른쪽으로 →'], ['-1', '← 왼쪽으로']], def: '1' },
      { key: 'position', label: '위치', type: 'select', options: [['bottom', '아래에 깔림'], ['top', '위에 걸림'], ['full', '화면 전체']], def: 'bottom' },
      { key: 'coverage', label: '덮는 높이', min: 0.15, max: 1, step: 0.01, def: 0.55 },
      { key: 'scale', label: '결 크기', min: 0.5, max: 3, step: 0.05, def: 1 },
      { key: 'color', label: '색', type: 'color', def: '#E8EEF5' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const pos = p('position');
      const band = pos === 'full' ? H : H * p('coverage');
      const top = pos === 'bottom' ? H - band : 0;
      const dir = Number(p('direction')) < 0 ? -1 : 1;
      const speed = p('speed');
      const scale = p('scale');
      const density = p('density');
      st.scroll = (st.scroll ?? 0) + dt * speed * dir;
      for (let j = 0; j < 3; j++) {
        const tex = fogTexture(j);
        const tileH = band * (1.15 + j * 0.12);
        const tileW = tileH * 2 * scale;
        const bob = Math.sin(st.t * 0.12 * (1 + j * 0.3) + j * 2) * band * 0.04;
        let off = (st.scroll * (22 + j * 17) + j * tileW * 0.37) % tileW;
        if (off > 0) off -= tileW;
        ctx.globalAlpha = clamp(density * (0.9 - j * 0.15), 0, 1);
        for (let x = off; x < W; x += tileW) {
          ctx.drawImage(tex, x, top - (tileH - band) / 2 + bob, tileW + 1, tileH);
        }
      }
      ctx.globalAlpha = 1;
      // 흰 결에 색 입히기 (레이어 안이라 밑 그림은 안 건드린다)
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = p('color');
      ctx.fillRect(0, 0, W, H);
      // 위(또는 아래)로 갈수록 풀리게
      if (pos !== 'full') {
        ctx.globalCompositeOperation = 'destination-in';
        const g = pos === 'bottom'
          ? ctx.createLinearGradient(0, top, 0, H)
          : ctx.createLinearGradient(0, band, 0, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.55, 'rgba(0,0,0,0.85)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },

  // ── 빛 ────────────────────────────────────────────────────────
  bokeh: {
    label: '✨ 보케 라이트',
    blend: 'screen',
    params: [
      { key: 'count', label: '개수', min: 3, max: 80, step: 1, def: 22 },
      { key: 'size', label: '크기', min: 0.2, max: 4, step: 0.05, def: 1 },
      { key: 'sizeVar', label: '크기 들쭉날쭉', min: 0, max: 1, step: 0.05, def: 0.7 },
      { key: 'speed', label: '움직이는 속도', min: 0, max: 4, step: 0.05, def: 1 },
      { key: 'softness', label: '빛 번짐', min: 0, max: 1, step: 0.05, def: 0.45 },
      { key: 'ring', label: '테두리 선명도', min: 0, max: 1, step: 0.05, def: 0.25 },
      { key: 'brightness', label: '밝기', min: 0.05, max: 1, step: 0.01, def: 0.45 },
      { key: 'twinkle', label: '숨쉬기 (밝아졌다 어두워짐)', min: 0, max: 1, step: 0.05, def: 0.5 },
      { key: 'color', label: '색 1', type: 'color', def: '#FFD9A0' },
      { key: 'color2', label: '색 2', type: 'color', def: '#FF9E6B' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const make = () => ({
        x: rand() * W, y: rand() * H,
        r: rand(), k: Math.floor(rand() * 5) / 4,
        ang: rand() * TAU, v: 0.4 + rand() * 0.8,
        ph: rand() * TAU, tw: 0.25 + rand() * 0.6, a: 0.45 + rand() * 0.55,
      });
      const list = fitCount(st.list || (st.list = []), Math.round(p('count')), make);
      const size = p('size');
      const sizeVar = p('sizeVar');
      const speed = 16 * p('speed');
      const soft = p('softness');
      const ring = p('ring');
      const bright = p('brightness');
      const tw = p('twinkle');
      const c1 = hexToRgb(p('color'));
      const c2 = hexToRgb(p('color2'));
      for (const b of list) {
        // 방향이 아주 천천히 바뀐다 → 직선이 아니라 떠다니는 느낌
        b.ang += Math.sin(st.t * 0.21 + b.ph) * 0.35 * dt;
        b.x += Math.cos(b.ang) * speed * b.v * dt;
        b.y += Math.sin(b.ang) * speed * b.v * dt;
        const r = 90 * size * (1 - sizeVar + sizeVar * (0.25 + b.r * 1.5));
        if (b.x < -r) b.x += W + r * 2; else if (b.x > W + r) b.x -= W + r * 2;
        if (b.y < -r) b.y += H + r * 2; else if (b.y > H + r) b.y -= H + r * 2;
        const breathe = 1 - tw * 0.85 * (0.5 + 0.5 * Math.sin(st.t * b.tw + b.ph));
        ctx.globalAlpha = clamp(bright * b.a * breathe, 0, 1);
        ctx.drawImage(bokehDisc(mixRgb(c1, c2, b.k), soft, ring), b.x - r, b.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    },
  },

  lightleak: {
    label: '🔆 라이트 리크 (빛샘)',
    blend: 'screen',
    params: [
      { key: 'intensity', label: '세기', min: 0.05, max: 1, step: 0.01, def: 0.45 },
      { key: 'size', label: '크기', min: 0.3, max: 2.5, step: 0.05, def: 1 },
      { key: 'speed', label: '움직이는 속도', min: 0, max: 4, step: 0.05, def: 1 },
      { key: 'edge', label: '가장자리 쪽으로', min: 0, max: 1, step: 0.05, def: 0.7 },
      { key: 'color', label: '색 1', type: 'color', def: '#FF8A3D' },
      { key: 'color2', label: '색 2', type: 'color', def: '#FFD36B' },
      { key: 'color3', label: '색 3', type: 'color', def: '#FF4F6D' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      st.ph = (st.ph ?? rand() * 100) + dt * p('speed');
      const cols = [hexToRgb(p('color')), hexToRgb(p('color2')), hexToRgb(p('color3'))];
      const reach = 0.25 + p('edge') * 0.4;      // 중심에서 얼마나 멀리 도는가
      const base = Math.max(W, H) * 0.5 * p('size');
      const intensity = p('intensity');
      for (let i = 0; i < 3; i++) {
        const cx = W * (0.5 + reach * Math.sin(st.ph * (0.11 + i * 0.03) + i * 2.1));
        const cy = H * (0.5 + reach * Math.cos(st.ph * (0.08 + i * 0.025) + i * 3.7));
        const r = base * (0.8 + 0.25 * Math.sin(st.ph * 0.17 + i * 1.3));
        const a = intensity * (0.6 + 0.4 * Math.sin(st.ph * 0.23 + i * 4.1));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, rgba(cols[i], a));
        g.addColorStop(0.45, rgba(cols[i], a * 0.45));
        g.addColorStop(1, rgba(cols[i], 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
    },
  },

  lightrays: {
    label: '🌤 빛줄기',
    blend: 'screen',
    params: [
      { key: 'intensity', label: '세기', min: 0.05, max: 1, step: 0.01, def: 0.35 },
      { key: 'count', label: '줄기 수', min: 2, max: 16, step: 1, def: 7 },
      { key: 'origin', label: '빛 나오는 자리 (좌↔우)', min: -0.2, max: 1.2, step: 0.01, def: 0.2 },
      { key: 'angle', label: '방향', min: -70, max: 70, step: 1, def: 25, suffix: '°' },
      { key: 'spread', label: '퍼지는 폭', min: 10, max: 120, step: 1, def: 55, suffix: '°' },
      { key: 'length', label: '길이', min: 0.3, max: 1.6, step: 0.05, def: 1 },
      { key: 'speed', label: '일렁임 속도', min: 0, max: 4, step: 0.05, def: 1 },
      { key: 'color', label: '색', type: 'color', def: '#FFE7B8' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      st.ph = (st.ph ?? 0) + dt * p('speed');
      const K = Math.round(p('count'));
      const ox = W * p('origin');
      const oy = -H * 0.18;
      const base = Math.PI / 2 - (p('angle') * Math.PI) / 180;    // 아래쪽 기준
      const spread = (p('spread') * Math.PI) / 180;
      const L = Math.hypot(W, H) * 1.15 * p('length');
      const rgb = hexToRgb(p('color'));
      const intensity = p('intensity');
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, L);
      g.addColorStop(0, rgba(rgb, 1));
      g.addColorStop(0.5, rgba(rgb, 0.45));
      g.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = g;
      for (let i = 0; i < K; i++) {
        const h = (Math.sin(i * 12.9898) * 43758.5453) % 1;       // 줄기마다 고정된 무작위
        const hh = Math.abs(h);
        const th = base + (K > 1 ? i / (K - 1) - 0.5 : 0) * spread + Math.sin(st.ph * 0.13 + i * 1.9) * 0.02;
        const w = (spread / K) * (0.45 + hh * 0.9);
        const a = intensity * (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(st.ph * (0.3 + hh * 0.45) + i * 2.3)));
        // 폭이 다른 쐐기를 세 겹 겹쳐 가장자리를 부드럽게
        for (const [wk, ak] of [[1, 0.3], [0.6, 0.35], [0.28, 0.35]]) {
          ctx.globalAlpha = clamp(a * ak, 0, 1);
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.lineTo(ox + Math.cos(th - (w * wk) / 2) * L, oy + Math.sin(th - (w * wk) / 2) * L);
          ctx.lineTo(ox + Math.cos(th + (w * wk) / 2) * L, oy + Math.sin(th + (w * wk) / 2) * L);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },
  },

  // ── 떠다니는 입자 ─────────────────────────────────────────────
  dust: {
    label: '🌟 반짝이는 먼지',
    blend: 'screen',
    params: [
      { key: 'amount', label: '양', min: 0.02, max: 1, step: 0.01, def: 0.3 },
      { key: 'size', label: '크기', min: 0.3, max: 4, step: 0.05, def: 1 },
      { key: 'speed', label: '떠다니는 속도', min: 0, max: 4, step: 0.05, def: 1 },
      { key: 'rise', label: '위로 떠오름', min: -1, max: 1, step: 0.05, def: 0.3 },
      { key: 'twinkle', label: '반짝임', min: 0, max: 1, step: 0.05, def: 0.7 },
      { key: 'color', label: '색', type: 'color', def: '#FFE9C0' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const make = () => ({
        x: rand() * W, y: rand() * H, z: 0.2 + rand() * 0.8,
        ang: rand() * TAU, ph: rand() * TAU, tw: 0.6 + rand() * 2.2,
      });
      const list = fitCount(st.list || (st.list = []), Math.round(p('amount') * 420), make);
      const speed = 22 * p('speed');
      const rise = p('rise') * 26 * p('speed');
      const size = p('size');
      const tw = p('twinkle');
      const sprite = softDot(hexToRgb(p('color')), 0.75);
      for (const d of list) {
        d.ang += Math.sin(st.t * 0.5 + d.ph) * 0.9 * dt;
        d.x += Math.cos(d.ang) * speed * d.z * dt;
        d.y += (Math.sin(d.ang) * speed * d.z - rise * d.z) * dt;
        const s = (1.5 + 4.5 * d.z) * size;
        if (d.x < -s) d.x += W + s * 2; else if (d.x > W + s) d.x -= W + s * 2;
        if (d.y < -s) d.y += H + s * 2; else if (d.y > H + s) d.y -= H + s * 2;
        const sparkle = Math.pow(0.5 + 0.5 * Math.sin(st.t * d.tw + d.ph), 3);
        ctx.globalAlpha = clamp((0.2 + 0.8 * d.z) * (1 - tw + tw * sparkle), 0, 1);
        ctx.drawImage(sprite, d.x - s, d.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    },
  },

  embers: {
    label: '🔥 불티',
    blend: 'screen',
    params: [
      { key: 'amount', label: '양', min: 0.02, max: 1, step: 0.01, def: 0.3 },
      { key: 'speed', label: '올라가는 속도', min: 0.1, max: 4, step: 0.05, def: 1 },
      { key: 'drift', label: '방향 (바람)', min: -1.5, max: 1.5, step: 0.05, def: 0.2 },
      { key: 'size', label: '크기', min: 0.3, max: 4, step: 0.05, def: 1 },
      { key: 'glow', label: '빛 번짐', min: 0, max: 3, step: 0.05, def: 1 },
      { key: 'life', label: '오래 가는 정도', min: 0.3, max: 3, step: 0.05, def: 1 },
      { key: 'color', label: '색 (갓 피어난)', type: 'color', def: '#FFC46B' },
      { key: 'color2', label: '색 (사그라드는)', type: 'color', def: '#FF4B1F' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const lifeK = p('life');
      const make = (anywhere) => ({
        x: rand() * W,
        y: anywhere ? rand() * H : H + rand() * 40,
        life: anywhere ? rand() : 1,
        rate: 1 / ((3 + rand() * 5) * lifeK),
        v: 50 + rand() * 110, r: 0.6 + rand() * 0.9, ph: rand() * TAU,
      });
      const list = fitCount(st.list || (st.list = []), Math.round(p('amount') * 280), make);
      const speed = p('speed');
      const drift = p('drift');
      const size = p('size');
      const glow = p('glow');
      const c1 = hexToRgb(p('color'));
      const c2 = hexToRgb(p('color2'));
      // 색은 수명에 따라 5단계 (스프라이트를 입자마다 굽지 않게)
      const cores = [];
      const halos = [];
      for (let k = 0; k < 5; k++) {
        const rgb = mixRgb(c2, c1, k / 4);
        cores.push(softDot(rgb, 0.35));
        halos.push(softDot(rgb, 1));
      }
      for (const e of list) {
        e.life -= e.rate * dt;
        e.ph += dt * 2.2;
        e.y -= e.v * speed * dt;
        e.x += (drift * 70 * speed + Math.sin(e.ph) * 26) * dt;
        if (e.life <= 0 || e.y < -30) { Object.assign(e, make(false)); continue; }
        if (e.x < -30) e.x += W + 60; else if (e.x > W + 30) e.x -= W + 60;
        const k = clamp(Math.round(e.life * 4), 0, 4);
        const flick = 0.7 + 0.3 * Math.sin(st.t * 17 + e.ph * 3);
        const a = Math.pow(e.life, 0.7) * flick;
        const s = (1.6 + 2.6 * e.r) * size;
        if (glow > 0) {
          const gs = s * 4.5 * glow;
          ctx.globalAlpha = clamp(a * 0.3, 0, 1);
          ctx.drawImage(halos[k], e.x - gs, e.y - gs, gs * 2, gs * 2);
        }
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.drawImage(cores[k], e.x - s, e.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    },
  },

  fireflies: {
    label: '🪲 반딧불',
    blend: 'screen',
    params: [
      { key: 'count', label: '개수', min: 3, max: 150, step: 1, def: 35 },
      { key: 'speed', label: '날아다니는 속도', min: 0, max: 4, step: 0.05, def: 1 },
      { key: 'size', label: '크기', min: 0.3, max: 4, step: 0.05, def: 1 },
      { key: 'glow', label: '빛 번짐', min: 0, max: 3, step: 0.05, def: 1 },
      { key: 'blink', label: '깜빡이는 속도', min: 0.1, max: 4, step: 0.05, def: 1 },
      { key: 'area', label: '날아다니는 높이 (아래부터)', min: 0.2, max: 1, step: 0.01, def: 0.75 },
      { key: 'color', label: '색', type: 'color', def: '#D9FF7A' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const top = H * (1 - p('area'));
      const make = () => ({
        x: rand() * W, y: top + rand() * (H - top),
        ang: rand() * TAU, v: 18 + rand() * 30, ph: rand() * TAU,
        rate: 0.5 + rand() * 0.9, turn: 0,
      });
      const list = fitCount(st.list || (st.list = []), Math.round(p('count')), make);
      const speed = p('speed');
      const size = p('size');
      const glow = p('glow');
      const blink = p('blink');
      const rgb = hexToRgb(p('color'));
      const core = softDot(rgb, 0.3);
      const halo = softDot(rgb, 1);
      for (const f of list) {
        // 방향을 조금씩 틀며 헤맨다
        f.turn += (rand() - 0.5) * 6 * dt;
        f.turn *= 1 - Math.min(1, dt * 1.5);
        f.ang += f.turn * dt * 3;
        f.x += Math.cos(f.ang) * f.v * speed * dt;
        f.y += Math.sin(f.ang) * f.v * speed * dt;
        if (f.x < -20) f.x += W + 40; else if (f.x > W + 20) f.x -= W + 40;
        if (f.y < top) { f.y = top; f.ang = Math.abs(f.ang % TAU); }
        else if (f.y > H + 10) { f.y = H + 10; f.ang = -Math.abs(f.ang % TAU); }
        const b = Math.pow(Math.max(0, Math.sin(st.t * f.rate * blink + f.ph)), 2.5);
        if (b < 0.02) continue;
        const s = 3 * size;
        if (glow > 0) {
          const gs = s * 7 * glow;
          ctx.globalAlpha = clamp(b * 0.45, 0, 1);
          ctx.drawImage(halo, f.x - gs, f.y - gs, gs * 2, gs * 2);
        }
        ctx.globalAlpha = b;
        ctx.drawImage(core, f.x - s, f.y - s, s * 2, s * 2);
      }
      ctx.globalAlpha = 1;
    },
  },

  stars: {
    label: '⭐ 별 (반짝임 + 별똥별)',
    blend: 'screen',
    params: [
      { key: 'amount', label: '별 수', min: 0.02, max: 1, step: 0.01, def: 0.35 },
      { key: 'size', label: '크기', min: 0.3, max: 4, step: 0.05, def: 1 },
      { key: 'twinkle', label: '반짝임', min: 0, max: 1, step: 0.05, def: 0.7 },
      { key: 'speed', label: '반짝이는 속도', min: 0.1, max: 4, step: 0.05, def: 1 },
      { key: 'area', label: '하늘 높이 (위부터)', min: 0.1, max: 1, step: 0.01, def: 0.65 },
      { key: 'shooting', label: '별똥별', min: 0, max: 1, step: 0.05, def: 0.25 },
      { key: 'color', label: '색', type: 'color', def: '#FFFFFF' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const make = () => ({ u: rand(), v: Math.pow(rand(), 1.4), r: Math.pow(rand(), 3), ph: rand() * TAU, tw: 0.4 + rand() * 2.4 });
      const list = fitCount(st.list || (st.list = []), Math.round(p('amount') * 700), make);
      const band = H * p('area');
      const size = p('size');
      const tw = p('twinkle');
      const speed = p('speed');
      const rgb = hexToRgb(p('color'));
      const halo = softDot(rgb, 1);
      ctx.fillStyle = rgba(rgb, 1);
      for (const s of list) {
        const x = s.u * W;
        const y = s.v * band;
        const edge = 1 - Math.pow(s.v, 3);                      // 지평선 쪽은 옅게
        const a = edge * (1 - tw + tw * (0.5 + 0.5 * Math.sin(st.t * s.tw * speed + s.ph)));
        const r = (0.6 + s.r * 2) * size;
        ctx.globalAlpha = clamp(a * (0.45 + 0.55 * s.r), 0, 1);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        if (s.r > 0.45) {                                       // 밝은 별만 빛 번짐
          const gs = r * 5;
          ctx.globalAlpha = clamp(a * 0.35, 0, 1);
          ctx.drawImage(halo, x - gs, y - gs, gs * 2, gs * 2);
        }
      }
      // 별똥별
      if (!st.meteors) st.meteors = [];
      const rate = p('shooting');
      if (rate > 0 && st.meteors.length < 3 && rand() < rate * 0.3 * dt) {
        const dir = rand() < 0.5 ? 1 : -1;
        const a = (20 + rand() * 25) * (Math.PI / 180);
        st.meteors.push({
          x: W * (0.15 + rand() * 0.7), y: band * rand() * 0.5,
          vx: Math.cos(a) * dir * (900 + rand() * 700), vy: Math.sin(a) * (900 + rand() * 700), life: 1,
        });
      }
      ctx.lineCap = 'round';
      for (let i = st.meteors.length - 1; i >= 0; i--) {
        const m = st.meteors[i];
        m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt * 1.6;
        if (m.life <= 0) { st.meteors.splice(i, 1); continue; }
        const tail = 0.16;
        const tx = m.x - m.vx * tail;
        const ty = m.y - m.vy * tail;
        const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
        g.addColorStop(0, rgba(rgb, m.life));
        g.addColorStop(1, rgba(rgb, 0));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = g;
        ctx.lineWidth = 2.2 * size;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },

  // ── 필름·색 ───────────────────────────────────────────────────
  grain: {
    label: '🎞 필름 그레인',
    blend: 'overlay',
    params: [
      { key: 'amount', label: '세기', min: 0.02, max: 1, step: 0.01, def: 0.22 },
      { key: 'size', label: '입자 크기', min: 1, max: 5, step: 0.1, def: 1.6 },
      { key: 'speed', label: '바뀌는 빠르기', min: 0, max: 1, step: 0.05, def: 0.6 },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const tiles = grainTiles();
      // speed 1 = 초당 30번, 0 = 멈춘 입자. (프레임마다 바꾸면 60fps 에서 지글거린다)
      const hold = 1 / (2 + p('speed') * 28);
      st.acc = (st.acc ?? hold) + dt;
      if (st.acc >= hold || st.tile == null) {
        st.acc = 0;
        if (p('speed') > 0 || st.tile == null) {
          st.tile = Math.floor(rand() * tiles.length);
          st.ox = Math.floor(rand() * 256);
          st.oy = Math.floor(rand() * 256);
        }
      }
      const size = p('size');
      ctx.save();
      ctx.globalAlpha = p('amount');
      ctx.scale(size, size);
      ctx.translate(-st.ox, -st.oy);
      ctx.fillStyle = ctx.createPattern(tiles[st.tile], 'repeat');
      ctx.fillRect(st.ox, st.oy, W / size + 1, H / size + 1);
      ctx.restore();
    },
  },

  oldfilm: {
    label: '📽 낡은 필름 (스크래치·먼지)',
    blend: 'normal',
    params: [
      { key: 'scratches', label: '세로 스크래치', min: 0, max: 1, step: 0.05, def: 0.4 },
      { key: 'specks', label: '먼지·얼룩', min: 0, max: 1, step: 0.05, def: 0.4 },
      { key: 'flicker', label: '밝기 깜빡임', min: 0, max: 1, step: 0.05, def: 0.3 },
      { key: 'rate', label: '필름 속도 (fps)', min: 8, max: 30, step: 1, def: 18 },
      { key: 'color', label: '스크래치 색', type: 'color', def: '#F4EBD8' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      // 필름은 초당 18~24장 — 그 박자로만 새 얼룩을 뽑고, 사이 프레임은 같은 그림을 다시 그린다.
      const hold = 1 / p('rate');
      st.acc = (st.acc ?? hold) + dt;
      if (st.acc >= hold || !st.frame) {
        st.acc = 0;
        const scr = p('scratches');
        const spk = p('specks');
        if (!st.lines) st.lines = [];
        st.lines = st.lines.filter((l) => (l.left -= 1) > 0);
        if (rand() < scr * 0.35) st.lines.push({ x: rand() * W, left: 2 + Math.floor(rand() * 12), a: 0.12 + rand() * 0.3, w: 1 + rand() * 1.5 });
        const specks = [];
        const n = Math.floor(spk * 5 * rand() * rand() * 3);
        for (let i = 0; i < n; i++) {
          specks.push({ x: rand() * W, y: rand() * H, r: 1 + Math.pow(rand(), 3) * 9, dark: rand() < 0.7, a: 0.3 + rand() * 0.5, sx: 0.5 + rand() });
        }
        st.frame = { specks, flick: (rand() - 0.5) * 2, jitter: (rand() - 0.5) * 3 };
      }
      const rgb = hexToRgb(p('color'));
      for (const l of st.lines || []) {
        ctx.fillStyle = rgba(rgb, l.a);
        ctx.fillRect(l.x + st.frame.jitter, 0, l.w, H);
      }
      for (const s of st.frame.specks) {
        ctx.fillStyle = s.dark ? `rgba(18, 14, 10, ${s.a})` : rgba(rgb, s.a);
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, s.r * s.sx, s.r, 0, 0, TAU);
        ctx.fill();
      }
      const fl = st.frame.flick * p('flicker') * 0.12;
      if (Math.abs(fl) > 0.002) {
        ctx.fillStyle = fl > 0 ? `rgba(255, 250, 235, ${fl})` : `rgba(0, 0, 0, ${-fl})`;
        ctx.fillRect(0, 0, W, H);
      }
    },
  },

  vignette: {
    label: '⚫ 비네트 (가장자리 어둡게)',
    blend: 'normal',
    params: [
      { key: 'strength', label: '세기', min: 0.05, max: 1, step: 0.01, def: 0.6 },
      { key: 'size', label: '밝은 가운데 크기', min: 0.1, max: 1.3, step: 0.01, def: 0.55 },
      { key: 'softness', label: '번지는 폭', min: 0.05, max: 1.5, step: 0.01, def: 0.7 },
      { key: 'roundness', label: '둥글기 (0=화면 비율)', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'color', label: '색', type: 'color', def: '#000000' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const rgb = hexToRgb(p('color'));
      const round = p('roundness');
      const R = Math.hypot(W, H) / 2;
      const sy = H / W + (1 - H / W) * round;          // 0 = 화면 비율의 타원, 1 = 정원
      const inner = R * p('size');
      const outer = inner + R * p('softness');
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1, sy);
      const g = ctx.createRadialGradient(0, 0, inner, 0, 0, outer);
      g.addColorStop(0, rgba(rgb, 0));
      g.addColorStop(0.5, rgba(rgb, p('strength') * 0.45));
      g.addColorStop(1, rgba(rgb, p('strength')));
      ctx.fillStyle = g;
      ctx.fillRect(-W, -H / sy, W * 2, (H * 2) / sy);
      ctx.restore();
    },
  },

  tint: {
    label: '🎨 색감 (컬러 틴트)',
    blend: 'soft-light',
    params: [
      { key: 'strength', label: '세기', min: 0.02, max: 1, step: 0.01, def: 0.4 },
      { key: 'color', label: '색 (위)', type: 'color', def: '#FFB36B' },
      { key: 'gradient', label: '위아래 두 색으로', type: 'bool', def: false },
      { key: 'color2', label: '색 (아래)', type: 'color', def: '#3A6EA5' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      if (p('gradient')) {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, p('color'));
        g.addColorStop(1, p('color2'));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = p('color');
      }
      ctx.globalAlpha = p('strength');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    },
  },

  letterbox: {
    label: '🎬 시네마 바 (위아래 띠)',
    blend: 'normal',
    params: [
      { key: 'size', label: '띠 높이', min: 1, max: 25, step: 0.5, def: 10, suffix: '%' },
      { key: 'feather', label: '경계 부드럽게', min: 0, max: 120, step: 1, def: 0, suffix: 'px' },
      { key: 'color', label: '색', type: 'color', def: '#000000' },
    ],
    draw(ctx, fx, st, W, H, dt, p) {
      const bar = (H * p('size')) / 100;
      const f = p('feather');
      const rgb = hexToRgb(p('color'));
      ctx.fillStyle = rgba(rgb, 1);
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
      if (f > 0) {
        let g = ctx.createLinearGradient(0, bar, 0, bar + f);
        g.addColorStop(0, rgba(rgb, 1)); g.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, bar, W, f);
        g = ctx.createLinearGradient(0, H - bar, 0, H - bar - f);
        g.addColorStop(0, rgba(rgb, 1)); g.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, H - bar - f, W, f);
      }
    },
  },
};

// 에디터 목록에 보이는 순서·묶음.
export const EFFECT_GROUPS = [
  ['날씨', ['rain', 'snow', 'fog']],
  ['빛', ['bokeh', 'lightleak', 'lightrays']],
  ['떠다니는 입자', ['dust', 'embers', 'fireflies', 'stars']],
  ['필름·색', ['grain', 'oldfilm', 'vignette', 'tint', 'letterbox']],
];

// 얹는 방식. 값은 CSS mix-blend-mode 이름 — canvas 에선 normal 만 source-over 로 바꾼다.
export const EFFECT_BLENDS = [
  ['normal', '보통'],
  ['screen', '스크린 (밝게 더하기)'],
  ['overlay', '오버레이'],
  ['soft-light', '소프트 라이트'],
  ['hard-light', '하드 라이트'],
  ['multiply', '곱하기 (어둡게)'],
  ['color', '색만 입히기'],
];

export function defaultEffect(type) {
  const def = EFFECT_TYPES[type];
  if (!def) return null;
  const fx = {
    id: `fx_${Date.now().toString(36)}_${Math.floor(rand() * 1e6).toString(36)}`,
    type,
    enabled: true,
    layer: 'front',
    opacity: 1,
    blend: def.blend,
  };
  for (const prm of def.params) fx[prm.key] = prm.def;
  return fx;
}

// 저장된 값이 없거나 모양이 틀리면 기본값.
export function effectParam(fx, key) {
  const prm = EFFECT_TYPES[fx.type]?.params.find((x) => x.key === key);
  const v = fx[key];
  if (!prm) return v;
  if (prm.type === 'color') return typeof v === 'string' && v ? v : prm.def;
  if (prm.type === 'select') return prm.options.some(([o]) => o === String(v)) ? String(v) : prm.def;
  if (prm.type === 'bool') return typeof v === 'boolean' ? v : prm.def;
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, prm.min, prm.max) : prm.def;
}

export function effectBlend(fx) {
  const b = fx.blend || EFFECT_TYPES[fx.type]?.blend || 'normal';
  return EFFECT_BLENDS.some(([v]) => v === b) ? b : 'normal';
}

export function effectOpacity(fx) {
  return typeof fx.opacity === 'number' && Number.isFinite(fx.opacity) ? clamp(fx.opacity, 0, 1) : 1;
}

// 템플릿에서 읽어 온 목록을 손본다 (모르는 종류는 버리고, id 없는 건 붙인다).
export function normalizeEffects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || !EFFECT_TYPES[raw.type]) continue;
    out.push({ ...defaultEffect(raw.type), ...raw, id: raw.id || defaultEffect(raw.type).id });
  }
  return out;
}

// ─── 그리기 ───────────────────────────────────────────────────────

// 이펙트마다 이어지는 상태(입자 위치 등). 템플릿엔 저장하지 않는다.
const _fxState = new Map();

export function resetEffectStates() {
  _fxState.clear();
}

// 비어 있는 투명 레이어(ctx)에 이펙트 한 장을 그린다. dt = 지난 프레임 뒤로 흐른 시간(초).
export function drawEffect(ctx, fx, W, H, dt) {
  const def = EFFECT_TYPES[fx.type];
  if (!def) return;
  let st = _fxState.get(fx.id);
  if (!st || st.type !== fx.type) {
    st = { type: fx.type, t: 0 };
    _fxState.set(fx.id, st);
  }
  const step = clamp(dt || 0, 0, 0.1);      // 탭이 쉬다 돌아와도 입자가 순간이동하지 않게
  st.t += step;
  ctx.save();
  def.draw(ctx, fx, st, W, H, step, (key) => effectParam(fx, key));
  ctx.restore();
}

// Studio 용 — 켜져 있는 이펙트 중 해당 layer 의 것을 차례로 밑 그림(mainCtx)에 얹는다.
let _scratch = null;
export function drawEffectsOnto(mainCtx, effects, layer, W, H, dt) {
  if (!Array.isArray(effects) || !effects.length) return;
  for (const fx of effects) {
    if (!fx || fx.enabled === false || (fx.layer || 'front') !== layer) continue;
    const opacity = effectOpacity(fx);
    if (opacity <= 0 || !EFFECT_TYPES[fx.type]) continue;
    if (!_scratch || _scratch.width !== W || _scratch.height !== H) _scratch = makeCanvas(W, H);
    const sctx = _scratch.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, W, H);
    drawEffect(sctx, fx, W, H, dt);
    const blend = effectBlend(fx);
    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.globalAlpha = opacity;
    mainCtx.globalCompositeOperation = blend === 'normal' ? 'source-over' : blend;
    mainCtx.drawImage(_scratch, 0, 0);
    mainCtx.restore();
  }
}
