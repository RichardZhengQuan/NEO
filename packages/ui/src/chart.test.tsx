import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ChartBlock } from '@neo/protocol';
import { ChartRenderer } from './chart.js';
import { I18nProvider } from './i18n.js';

afterEach(cleanup);

describe('stacked area charts', () => {
  it.each([
    { order: 'positive then negative', values: [[10, 10], [-5, -5]] },
    { order: 'negative then positive', values: [[-5, -5], [10, 10]] },
    { order: 'sign changes within each series', values: [[10, -5], [-5, 10]] },
  ])('stacks mixed-sign areas from zero ($order)', ({ values }) => {
    const categories = ['Jan', 'Feb'];
    const block: ChartBlock = {
      type: 'chart',
      kind: 'area',
      stacked: true,
      series: values.map((row, si) => ({
        name: `Series ${si}`,
        data: categories.map((x, ci) => ({ x, y: row[ci]! })),
      })),
    };
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block} /></I18nProvider>);
    // Both area and stroke paths start with M; only areas close with Z.
    const areas = Array.from(container.querySelectorAll('path[d^="M"]')).filter((path) => path.getAttribute('d')!.endsWith('Z'));
    expect(areas).toHaveLength(2);
    const zeroLine = container.querySelector('line.neo-chart__grid:not([stroke-dasharray])');
    expect(zeroLine).not.toBeNull();
    const zeroY = Number(zeroLine!.getAttribute('y1'));

    areas.forEach((area, si) => {
      const ys = Array.from(area.getAttribute('d')!.matchAll(/[ML]-?\d+(?:\.\d+)? (-?\d+(?:\.\d+)?)/g), (point) => Number(point[1]));
      expect(ys).toHaveLength(4);
      // The two data points are followed by the reversed base leg.
      expect(ys[2]).toBeCloseTo(zeroY, 1);
      expect(ys[3]).toBeCloseTo(zeroY, 1);
      values[si]!.forEach((v, ci) => {
        if (v >= 0) expect(ys[ci]).toBeLessThan(zeroY);
        else expect(ys[ci]).toBeGreaterThan(zeroY);
      });
    });
  });
});
