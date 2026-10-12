import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PrintWordmark } from './PrintWordmark.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('visible wordmark geometry', () => {
  it('uses painted cap metrics when the SVG glyph cell contains extra ascent and descent', () => {
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: -100, width: 166, height: 120 }) });
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    const context = { font: '', measureText: vi.fn(() => ({ actualBoundingBoxAscent: 68, actualBoundingBoxDescent: 0 })) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      const { container } = render(<PrintWordmark />);
      expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe('-1 -69 168 70');
      expect(context.font).toContain('100px');
      expect(context.measureText).toHaveBeenCalledWith('NEO');
    } finally { Reflect.deleteProperty(SVGElement.prototype, 'getBBox'); }
  });

  it('centres the visible glyph box, including negative bearings, independently of font leading', () => {
    const getBBox = vi.fn(() => ({ x: -2, y: -73, width: 166, height: 74 }));
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: getBBox });
    try {
      const { container } = render(<PrintWordmark />);
      const svg = container.querySelector('svg')!;
      const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
      expect(x! + width! / 2).toBe(-2 + 166 / 2);
      expect(y! + height! / 2).toBe(-73 + 74 / 2);
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
      expect(container.querySelector('.cyber-wordmark')!.getAttribute('data-glyph-anchor')).toBe('center');
      expect(container.textContent).toBe('NEO');
      expect(container.querySelector('use')!.getAttribute('href')).toBe(`#${container.querySelector('text')!.id}`);
    } finally { Reflect.deleteProperty(SVGElement.prototype, 'getBBox'); }
  });

  it('remeasures after fonts load and ignores a late font result after unmount', async () => {
    const getBBox = vi.fn(() => ({ x: 0, y: -70, width: 160, height: 70 }));
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: getBBox });
    let loaded!: () => void;
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise<void>((resolve) => { loaded = resolve; }) } });
    try {
      const view = render(<PrintWordmark />);
      getBBox.mockReturnValue({ x: -3, y: -80, width: 180, height: 80 });
      await act(async () => { loaded(); });
      expect(view.container.querySelector('svg')!.getAttribute('viewBox')).toBe('-4 -81 182 82');
      view.unmount();
      expect(getBBox).toHaveBeenCalledTimes(2);
      let resolveLate!: () => void;
      Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise<void>((resolve) => { resolveLate = resolve; }) } });
      const late = render(<PrintWordmark />);
      late.unmount();
      await act(async () => { resolveLate(); });
      expect(getBBox).toHaveBeenCalledTimes(3);
    } finally {
      Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
      Reflect.deleteProperty(document, 'fonts');
    }
  });
});
