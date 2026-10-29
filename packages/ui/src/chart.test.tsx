import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ChartBlock } from '@neo/protocol';
import { ChartRenderer, niceTicks } from './chart.js';
import { I18nProvider } from './i18n.js';

afterEach(cleanup);

describe('niceTicks', () => {
  it.each([
    { domain: 'positive maximum', min: 0, max: Number.MAX_VALUE },
    { domain: 'negative maximum', min: -Number.MAX_VALUE, max: 0 },
    { domain: 'both maxima', min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
    { domain: 'upper half of the positive range', min: Number.MAX_VALUE / 2, max: Number.MAX_VALUE },
  ])('returns bounded, finite ticks for $domain', ({ min, max }) => {
    const original = Number.prototype.toPrecision;
    // Exercise the real loop, but fail immediately if its accumulator overflows
    // instead of letting the regression hang the test process or exhaust memory.
    const precision = vi.spyOn(Number.prototype, 'toPrecision').mockImplementation(function (this: number, digits?: number) {
      expect(Number.isFinite(this.valueOf())).toBe(true);
      return original.call(this, digits);
    });
    try {
      const ticks = niceTicks(min, max);
      expect(ticks.length).toBeLessThanOrEqual(4 + 2);
      expect(ticks.every(Number.isFinite)).toBe(true);
      if (min >= 0) {
        expect(ticks.length).toBeGreaterThan(0);
        expect(precision).toHaveBeenCalled();
      }
    } finally {
      precision.mockRestore();
    }
  });
});

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

describe('finite Cartesian domains', () => {
  const domains = [
    { name: 'mixed extrema', values: [-Number.MAX_VALUE, Number.MAX_VALUE] },
    { name: 'overflowing mixed span', values: [-1e308, 1e308] },
    { name: 'positive extrema beyond bounded ticks', values: [Number.MAX_VALUE / 2, Number.MAX_VALUE] },
    { name: 'negative extrema', values: [-Number.MAX_VALUE, -Number.MAX_VALUE / 2] },
  ];
  const cases = (['line', 'area', 'bar'] as const).flatMap((kind) => domains.map((domain) => ({ kind, ...domain })));

  function expectFinitePlot(container: HTMLElement): void {
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      for (const attribute of element.attributes) expect(attribute.value).not.toMatch(/NaN|Infinity/);
    }
    const points = [...svg.querySelectorAll('circle')].map((circle) => Number(circle.getAttribute('cy')));
    const bars = [...svg.querySelectorAll('rect')];
    const plottedYs = points.length ? points : bars.flatMap((bar) => {
      const top = Number(bar.getAttribute('y'));
      return [top, top + Number(bar.getAttribute('height'))];
    });
    expect(plottedYs.length).toBeGreaterThan(0);
    for (const y of plottedYs) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(12 - 1e-6);
      expect(y).toBeLessThanOrEqual(212 + 1e-6);
    }
    expect(Math.max(...plottedYs) - Math.min(...plottedYs)).toBeGreaterThan(1);
  }

  it.each(cases)('renders finite, in-bounds $kind geometry for $name', ({ kind, values }) => {
    const block: ChartBlock = {
      type: 'chart', kind,
      series: [{ name: 'Finite values', data: values.map((y, i) => ({ x: String(i), y })) }],
    };
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block} /></I18nProvider>);
    expectFinitePlot(container);
  });

  it.each(['area', 'bar'] as const)('renders finite mixed-sign %s stacks whose totals remain finite', (kind) => {
    const block: ChartBlock = {
      type: 'chart', kind, stacked: true,
      series: [[6e307, -6e307], [3e307, -3e307]].map((values, i) => ({
        name: `Stack ${i}`, data: values.map((y, ci) => ({ x: String(ci), y })),
      })),
    };
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block} /></I18nProvider>);
    expectFinitePlot(container);
  });

  it('preserves ordinary line geometry', () => {
    const block: ChartBlock = {
      type: 'chart', kind: 'line',
      series: [{ name: 'Ordinary', data: [{ x: 'A', y: -10 }, { x: 'B', y: 10 }] }],
    };
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block} /></I18nProvider>);
    expect([...container.querySelectorAll('circle')].map((circle) => Number(circle.getAttribute('cy')))).toEqual([212, 12]);
    expect(Number(container.querySelector('line.neo-chart__grid:not([stroke-dasharray])')!.getAttribute('y1'))).toBe(112);
  });

  it.each(['en', 'zh-CN'] as const)('keeps extreme stacked axis labels bounded in %s', (locale) => {
    const block: ChartBlock = {
      type: 'chart', kind: 'bar', stacked: true,
      series: [6e307, 3e307].map((y, i) => ({ name: `Stack ${i}`, data: [{ x: 'A', y }, { x: 'B', y }] })),
    };
    const { container } = render(<I18nProvider locale={locale}><ChartRenderer block={block} /></I18nProvider>);
    const labels = [...container.querySelectorAll('text.neo-chart__axis[text-anchor="end"]')].map((label) => label.textContent!);
    expect(labels.length).toBeGreaterThan(1);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(12);
    expect(labels.some((label) => /E/i.test(label))).toBe(true);
    expectFinitePlot(container);
  });

  it('preserves ordinary axis labels', () => {
    const block: ChartBlock = {
      type: 'chart', kind: 'line',
      series: [{ name: 'Ordinary', data: [{ x: 'A', y: -10 }, { x: 'B', y: 10 }] }],
    };
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block} /></I18nProvider>);
    expect([...container.querySelectorAll('text.neo-chart__axis[text-anchor="end"]')].map((label) => label.textContent)).toEqual(['-10', '-5', '0', '5', '10']);
  });
});
