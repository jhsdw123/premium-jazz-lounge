import React from 'react';
import { Img } from 'remotion';
import type { Component } from '../lib/templateAdapter';

export const ImageComponent: React.FC<{ comp: Component }> = ({ comp }) => {
  if (!comp.src) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: comp.x,
        top: comp.y,
        width: comp.width,
        height: comp.height,
        opacity: comp.opacity ?? 1,
        pointerEvents: 'none',
      }}
    >
      <Img
        src={comp.src}
        style={{ width: '100%', height: '100%', objectFit: (comp.fit || 'contain') as any }}
      />
    </div>
  );
};
