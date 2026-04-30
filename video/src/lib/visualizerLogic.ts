// Editor 의 drawVisualizer 와 동일한 amplitude 계산 로직.
// raw 0~1 amplitudes → legacy 식으로 막대 높이 (그리는 전 단계).

export type VisOpts = {
  barCount: number;
  centerCut: number;
  trimStart: number;
  sensitivity: number;
  midBoost: number;
  highBoost: number;
  smoothing: number;
};

/**
 * v4: Auto Gain Control 도입.
 * 이전 (v1~v3) 의 fixed REMOTION_AMPLITUDE_BOOST 는 곡마다 음량 다른 문제로
 * 단일 값 매칭 불가 → 폐기. 대신 caller (VisualizerComponent) 가 매 frame 의
 * peak 를 추적하면서 자동 gain 곱해서 0~AGC_TARGET_PEAK 범위로 정규화한 후
 * 본 함수에 전달.
 *
 * 'editor' 모드: opts.sensitivity 로 사용자 슬라이더 적용 (정규화 X)
 * 'remotion' 모드: caller 가 AGC 로 이미 정규화 + sensitivity multiplier 적용.
 *                  여기선 fixed baseline 0.15 로 bar height 스케일만 .
 */
const REMOTION_BAR_SCALE = 0.15;
let _debugLoggedFrames = 0;

/**
 * 0~1 frequency amplitudes → N개 막대의 bar 높이 (legacy 식 적용 후).
 * 'remotion' 모드는 입력이 이미 AGC 정규화된 상태라 가정.
 */
export function rawToBarHeights(
  raw: Float32Array | number[],
  opts: VisOpts,
  source: 'editor' | 'remotion' = 'editor'
): Float32Array {
  const N = Math.max(1, opts.barCount | 0);
  const fftSize = (raw.length || 2048) * 2;
  const out = new Float32Array(N);
  const cc = Math.max(0, opts.centerCut | 0);
  const ts = Math.max(0, opts.trimStart | 0);
  // remotion 은 caller (AGC) 가 sensitivity 곱했음 → 여기선 fixed baseline.
  const sens = source === 'remotion' ? REMOTION_BAR_SCALE : opts.sensitivity;

  // 디버그 — 짧은 mp4 렌더 시 첫 5 프레임만 raw 분포 로그
  if (source === 'remotion' && _debugLoggedFrames < 5) {
    const sample = Array.from(raw).slice(0, 10).map((v) => Number(v).toFixed(4));
    let mx = 0, sm = 0;
    for (let k = 0; k < raw.length; k++) {
      const v = (raw as any)[k] || 0;
      if (v > mx) mx = v;
      sm += v;
    }
    const avg = raw.length ? sm / raw.length : 0;
    // eslint-disable-next-line no-console
    console.log(`[remotion-vis] frame#${_debugLoggedFrames} (post-AGC) bins=${raw.length} max=${mx.toFixed(4)} avg=${avg.toFixed(4)} sample=${sample.join(',')}`);
    _debugLoggedFrames++;
  }

  for (let i = 0; i < N; i++) {
    const denom = N + cc - 1;
    const percent = denom > 0 ? (i + cc) / denom : 0;
    const logIndex = Math.pow(percent, 2.0);
    const rawIdx = Math.floor(ts + logIndex * (fftSize / 5));
    const range = 2 + Math.floor(percent * 4);
    let sum = 0, cnt = 0;
    for (let k = 0; k <= range; k++) {
      const idx = rawIdx + k;
      if (idx >= 0 && idx < raw.length) {
        sum += (raw as any)[idx];
        cnt++;
      }
    }
    const rawAvg = cnt > 0 ? sum / cnt : 0;
    // bar 높이는 컴포넌트의 heightCap 에서 자연스럽게 클램프됨 (inner clamp X).
    const eq = opts.midBoost * (1 - percent) + opts.highBoost * percent;
    out[i] = rawAvg * 2000 * sens * eq;
  }
  return out;
}

// ─── 색상 ─────────────────────────────────────────────────────
export function hexToRgb(hex?: string): { r: number; g: number; b: number } {
  if (!hex || typeof hex !== 'string') return { r: 212, g: 175, b: 55 };
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  if (m.length !== 6) return { r: 212, g: 175, b: 55 };
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

export function gradientColorAt(stops: any[] | undefined, pct: number): { r: number; g: number; b: number } {
  if (!stops || !stops.length) return { r: 212, g: 175, b: 55 };
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (pct <= sorted[0].position) return hexToRgb(sorted[0].color);
  if (pct >= sorted[sorted.length - 1].position) return hexToRgb(sorted[sorted.length - 1].color);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (pct >= a.position && pct <= b.position) {
      const span = Math.max(0.0001, b.position - a.position);
      const t = (pct - a.position) / span;
      const c1 = hexToRgb(a.color);
      const c2 = hexToRgb(b.color);
      return {
        r: Math.round(c1.r + (c2.r - c1.r) * t),
        g: Math.round(c1.g + (c2.g - c1.g) * t),
        b: Math.round(c1.b + (c2.b - c1.b) * t),
      };
    }
  }
  return hexToRgb(sorted[sorted.length - 1].color);
}

export function getBarColor(c: any, barIndex: number, totalBars: number): string {
  if (c.colorMode !== 'gradient' || !c.gradientStops?.length) {
    return c.color || '#D4AF37';
  }
  const pct = (barIndex / Math.max(1, totalBars - 1)) * 100;
  const rgb = gradientColorAt(c.gradientStops, pct);
  return `rgb(${rgb.r},${rgb.g},${rgb.b})`;
}
