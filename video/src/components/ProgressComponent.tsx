import React from 'react';
import type { Component } from '../lib/templateAdapter';

type Ctx = { totalProgress: number; trackProgress: number };

export const ProgressComponent: React.FC<{ comp: Component; ctx: Ctx }> = ({ comp, ctx }) => {
  const pct = Math.max(0, Math.min(1, ctx.totalProgress));
  const radius = comp.height / 2;
  return (
    <div
      style={{
        position: 'absolute',
        left: comp.x,
        top: comp.y,
        width: comp.width,
        height: comp.height,
        background: comp.bgColor || 'rgba(255,255,255,0.1)',
        borderRadius: radius,
        overflow: 'hidden',
        opacity: comp.opacity ?? 1,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: '100%',
          background: comp.fillColor || '#D4AF37',
          borderRadius: radius,
          transition: 'none',
        }}
      />
    </div>
  );
};
