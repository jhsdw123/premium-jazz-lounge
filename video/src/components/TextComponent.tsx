import React from 'react';
import { isDarkColor, substituteVariables, type Component } from '../lib/templateAdapter';

type Ctx = {
  trackTitle: string;
  trackNumber: number;
  totalTracks: number;
};

export const TextComponent: React.FC<{ comp: Component; ctx: Ctx }> = ({ comp, ctx }) => {
  const content = substituteVariables(comp.content || '', ctx);
  const isDark = isDarkColor(comp.color);
  const glowI = comp.glowIntensity ?? 1.0;
  const textShadow = isDark || glowI <= 0
    ? 'none'
    : `0 0 ${Math.round(20 * glowI)}px rgba(212,175,55,${Math.min(1, 0.5 + glowI * 0.3).toFixed(2)})`;

  const decorations: string[] = [];
  if (comp.underline) decorations.push('underline');
  if (comp.strikethrough) decorations.push('line-through');

  const autoWrap = comp.autoWrap !== false;

  return (
    <div
      style={{
        position: 'absolute',
        left: comp.x,
        top: comp.y,
        width: comp.width,
        height: comp.height,
        opacity: comp.opacity ?? 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          (comp.textAlign === 'left' && 'flex-start') ||
          (comp.textAlign === 'right' && 'flex-end') ||
          'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: '100%',
          fontSize: comp.fontSize || 72,
          fontFamily: comp.fontFamily || 'Playfair Display, serif',
          color: comp.color || '#FFFFFF',
          fontWeight: comp.bold ? 700 : 400,
          fontStyle: comp.italic ? 'italic' : 'normal',
          textDecoration: decorations.length ? decorations.join(' ') : 'none',
          textAlign: comp.textAlign || 'center',
          textTransform: (comp.textTransform || 'none') as any,
          letterSpacing: `${comp.letterSpacing || 0}px`,
          lineHeight: comp.lineHeight ?? 1.2,
          textShadow,
          whiteSpace: autoWrap ? 'pre-line' : 'pre',
          wordWrap: autoWrap ? 'break-word' : 'normal',
          overflow: autoWrap ? 'visible' : 'hidden',
        }}
      >
        {content}
      </div>
    </div>
  );
};
