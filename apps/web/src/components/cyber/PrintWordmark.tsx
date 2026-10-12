import { useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useReducedMotion } from './useReducedMotion.js';

export function PrintWordmark({ className }: { className?: string }): ReactElement {
  const reducedMotion = useReducedMotion();
  const glyph = useRef<SVGTextElement>(null);
  const id = useId();
  const [viewBox, setViewBox] = useState('-1 -75 184 76');
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active || typeof glyph.current?.getBBox !== 'function') return;
      const box = glyph.current.getBBox();
      if (box.width > 0 && box.height > 0) {
        let top = box.y;
        let height = box.height;
        // SVG text bounding boxes can include the font's full glyph cell.
        // Canvas ink metrics centre the painted capitals around the SVG baseline.
        if (typeof CanvasRenderingContext2D !== 'undefined') {
          const context = document.createElement('canvas').getContext('2d');
          if (context) {
            const font = getComputedStyle(glyph.current);
            context.font = `${font.fontStyle || 'normal'} ${font.fontWeight || '900'} ${font.fontSize || '100px'} ${font.fontFamily || 'Impact, sans-serif'}`;
            const ink = context.measureText('NEO');
            const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent;
            if (Number.isFinite(inkHeight) && inkHeight > 0) {
              top = -ink.actualBoundingBoxAscent;
              height = inkHeight;
            }
          }
        }
        // Symmetric stroke clearance leaves the painted cap centre unchanged.
        setViewBox(`${box.x - 1} ${top - 1} ${box.width + 2} ${height + 2}`);
      }
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { active = false; };
  }, []);
  return (
    <div
      className={['cyber-wordmark', !reducedMotion && 'cyber-wordmark--animated', className].filter(Boolean).join(' ')}
      data-text="NEO"
      data-motion={reducedMotion ? 'off' : 'on'}
      data-glyph-anchor="center"
      aria-hidden="true"
    >
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <text ref={glyph} id={id} x="0" y="0" fontSize="100" letterSpacing="-2.5">NEO</text>
        <use href={`#${id}`} className="cyber-wordmark-registration" />
      </svg>
    </div>
  );
}
