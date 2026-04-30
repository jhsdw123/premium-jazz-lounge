// 옛 schema (canvas/title/visualizer/progressBar) → 새 schema (canvas + components[])
// Editor 의 loadConfigToCanvas 와 동일 로직.

const CANVAS_W = 1920;
const CANVAS_H = 1080;

export type Component = {
  id?: string;
  type: 'text' | 'image' | 'visualizer' | 'progress';
  x: number; y: number;
  width: number; height: number;
  rotation?: number;
  opacity?: number;
  // type-specific (loose)
  [key: string]: any;
};

export function adaptTemplate(cfg: any): { canvas: any; components: Component[] } {
  const canvas = cfg?.canvas || { width: CANVAS_W, height: CANVAS_H, bgColor: '#0A0A0A' };

  if (Array.isArray(cfg?.components)) {
    return { canvas, components: cfg.components.map((c: any) => ({ ...c })) };
  }

  const components: Component[] = [];

  if (cfg?.title) {
    components.push({
      id: 'legacy_title',
      type: 'text',
      x: (CANVAS_W - 1200) / 2,
      y: 480,
      width: 1200, height: 160,
      rotation: 0, opacity: 1.0,
      content: cfg.title.text || '{{trackTitle}}',
      fontSize: cfg.title.fontSize ?? 72,
      fontFamily: cfg.title.fontFamily || 'Playfair Display, serif',
      color: cfg.title.color || '#FFFFFF',
      textAlign: 'center',
      bold: false, italic: false, underline: false, strikethrough: false,
      letterSpacing: 0, lineHeight: 1.2, textTransform: 'none',
      glowIntensity: 1.0, autoWrap: true,
    });
  }

  if (cfg?.visualizer) {
    const v = cfg.visualizer;
    const w = v.width ?? 1200;
    const h = v.height ?? 240;
    const vmMap = ['symmetric', 'up', 'down'] as const;
    const verticalMode = typeof v.vMirror === 'number'
      ? (vmMap[v.vMirror] || 'symmetric')
      : (v.verticalMode || 'symmetric');
    components.push({
      id: 'legacy_visualizer',
      type: 'visualizer',
      x: (v.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (v.position?.y ?? 880) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      verticalMode,
      barWidth: v.barWidth ?? 6,
      barGap: v.barGap ?? 2,
      barCount: v.barCount ?? 80,
      sensitivity: v.sensitivity ?? v.barGain ?? 0.15,
      smoothing: v.smoothing ?? 0.85,
      midBoost: v.midBoost ?? 1.5,
      highBoost: v.highBoost ?? 0.8,
      centerCut: v.centerCut ?? 0,
      splitGap: v.splitGap ?? 0,
      trimStart: v.trimStart ?? 3,
      glow: v.glow ?? (typeof v.glowIntensity === 'number' ? Math.round(v.glowIntensity * 30) : 20),
      colorMode: v.colorMode || 'solid',
      color: v.color || '#D4AF37',
      gradientStops: v.gradientStops,
    });
  }

  if (cfg?.progressBar) {
    const p = cfg.progressBar;
    const w = p.width ?? 1600;
    const h = p.height ?? 8;
    components.push({
      id: 'legacy_progress',
      type: 'progress',
      x: (p.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (p.position?.y ?? 1020) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      style: p.style || 'melody',
      bgColor: p.bgColor || 'rgba(255,255,255,0.1)',
      fillColor: p.fillColor || '#D4AF37',
    });
  }

  return { canvas, components };
}

// Text content 변수 치환
export function substituteVariables(content: string, ctx: {
  trackTitle: string; trackNumber: number; totalTracks: number;
}): string {
  return String(content || '')
    .replace(/\{\{trackTitle\}\}/g, ctx.trackTitle || '')
    .replace(/\{\{trackNumber\}\}/g, String(ctx.trackNumber))
    .replace(/\{\{totalTracks\}\}/g, String(ctx.totalTracks));
}

export function isDarkColor(hex?: string): boolean {
  if (!hex || typeof hex !== 'string') return false;
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
