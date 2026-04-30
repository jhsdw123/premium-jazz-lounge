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
 * Editor 의 AnalyserNode.getByteFrequencyData 와 Remotion 의 visualizeAudio
 * 는 amplitude scale 이 크게 다름. 실측 (10s test render):
 *   - Editor:   byte freq data (0~255) ÷ 255 → 평균 ~0.15, peak ~0.6
 *   - Remotion: visualizeAudio              → 평균 ~0.002, peak ~0.076
 *   → 평균 기준 ~75x 차이. Editor 와 동일한 sensitivity 슬라이더 값에서
 *     비슷한 활발함을 얻으려면 Remotion 측에 boost 75 곱.
 *   bar 높이의 최종 클램프는 컴포넌트의 heightCap 이 처리하므로 inner clamp X.
 *
 * 'editor' 모드: scale 1
 * 'remotion' 모드: scale REMOTION_AMPLITUDE_BOOST
 */
const REMOTION_AMPLITUDE_BOOST = 75;
let _debugLoggedFrames = 0;

/**
 * 0~1 frequency amplitudes → N개 막대의 amplitude (legacy 식 적용 후).
 * 시간축 smoothing 은 호출자가 처리 (Editor 는 lastData, Remotion 은 X).
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
  const scale = source === 'remotion' ? REMOTION_AMPLITUDE_BOOST : 1;

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
    console.log(`[remotion-vis] frame#${_debugLoggedFrames} bins=${raw.length} max=${mx.toFixed(4)} avg=${avg.toFixed(4)} sample=${sample.join(',')}`);
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
    const rawAvg = (cnt > 0 ? sum / cnt : 0) * scale;
    // boost 후 inner clamp X — bar 높이는 컴포넌트의 heightCap 에서 자연스럽게 클램프됨.
    const eq = opts.midBoost * (1 - percent) + opts.highBoost * percent;
    out[i] = rawAvg * 2000 * opts.sensitivity * eq;
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
