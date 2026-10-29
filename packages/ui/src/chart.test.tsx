import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

describe('overflowing chart aggregates', () => {
  const max = Number.MAX_VALUE;
  function block(kind: ChartBlock['kind'], rows: number[][]): ChartBlock {
    return { type: 'chart', kind, stacked: true, unit: 'kg', series: rows.map((row, i) => ({ name: `Series ${i}`, data: row.map((y, ci) => ({ x: String(ci), y })) })) };
  }
  function finiteSvg(container: HTMLElement): SVGSVGElement {
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    for (const element of [svg, ...svg.querySelectorAll('*')]) for (const attribute of element.attributes) expect(attribute.value).not.toMatch(/NaN|Infinity/);
    expect(svg.textContent).not.toMatch(/NaN|Infinity|∞/);
    return svg;
  }

  it.each((['bar', 'area'] as const).flatMap((kind) => [1, -1].map((sign) => ({ kind, sign }))))('preserves equal $kind stack bands for overflowing sign $sign', ({ kind, sign }) => {
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block(kind, [[sign * max, sign * max], [sign * max, sign * max]])} /></I18nProvider>);
    const svg = finiteSvg(container);
    const labels = [...svg.querySelectorAll('text[text-anchor="end"]')].map((label) => label.textContent!);
    expect(labels.some((label) => label.includes('3.6E308'))).toBe(true);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(12);
    if (kind === 'bar') {
      const heights = [...svg.querySelectorAll('rect')].map((bar) => Number(bar.getAttribute('height')));
      expect(heights).toHaveLength(4);
      for (const height of heights) expect(height).toBeCloseTo(100, 6);
    } else {
      const areas = [...svg.querySelectorAll('path')].filter((path) => path.getAttribute('d')!.endsWith('Z'));
      expect(areas).toHaveLength(2);
      expect(areas[0]!.getAttribute('d')).not.toBe(areas[1]!.getAttribute('d'));
    }
    expect(container.querySelector('td')!.textContent).toBe(`${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(sign * max)} kg`);
  });

  it.each(['bar', 'area'] as const)('preserves both signs in overflowing %s stacks', (kind) => {
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block(kind, [[max], [max], [-max], [-max]])} /></I18nProvider>);
    const svg = finiteSvg(container);
    const zero = Number(svg.querySelector('line.neo-chart__grid:not([stroke-dasharray])')!.getAttribute('y1'));
    expect(zero).toBe(112);
    if (kind === 'bar') {
      const bars = [...svg.querySelectorAll('rect')];
      expect(bars.slice(0, 2).every((bar) => Number(bar.getAttribute('y')) < zero)).toBe(true);
      expect(bars.slice(2).every((bar) => Number(bar.getAttribute('y')) >= zero)).toBe(true);
    }
  });

  it.each(['bar', 'area'] as const)('preserves unequal overflowing %s stack proportions', (kind) => {
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block(kind, [[max], [max / 2]])} /></I18nProvider>);
    const svg = finiteSvg(container);
    if (kind === 'bar') {
      const bars = [...svg.querySelectorAll('rect')];
      expect(Number(bars[0]!.getAttribute('height')) / Number(bars[1]!.getAttribute('height'))).toBeCloseTo(2, 6);
    } else {
      const areas = [...svg.querySelectorAll('path')].filter((path) => path.getAttribute('d')!.endsWith('Z'));
      const heights = areas.map((area) => {
        const ys = [...area.getAttribute('d')!.matchAll(/[ML]-?\d+(?:\.\d+)? (-?\d+(?:\.\d+)?)/g)].map((point) => Number(point[1]));
        return Math.max(...ys) - Math.min(...ys);
      });
      expect(heights[0]! / heights[1]!).toBeCloseTo(2, 2);
    }
  });

  it.each(['en', 'zh-CN'] as const)('shows bounded raw tooltip values after overflow normalization in %s', (locale) => {
    const { container } = render(<I18nProvider locale={locale}><ChartRenderer block={block('bar', [[max], [max]])} /></I18nProvider>);
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'ArrowRight' });
    const values = [...container.querySelectorAll('.neo-chart__tooltip strong')].map((value) => value.textContent!);
    expect(values).toHaveLength(2);
    for (const value of values) { expect(value).toMatch(/E308 kg$/); expect(value.length).toBeLessThanOrEqual(16); }
  });

  const radialCases = [
    { name: 'single-series total', rows: [[max, max]], percentages: ['50%', '50%'] },
    { name: 'multiple finite slices', rows: [[max], [max]], percentages: ['50%', '50%'] },
    { name: 'overflowing series', rows: [[max, max], [max, max]], percentages: ['50%', '50%'] },
    { name: 'positive prefix cancellation', rows: [[max, max, -max], [max]], percentages: ['50%', '50%'] },
    { name: 'negative prefix cancellation', rows: [[-max, -max, max, max, max], [max]], percentages: ['50%', '50%'] },
    { name: 'unequal slices', rows: [[max], [max / 2]], percentages: ['67%', '33%'] },
    { name: 'ordinary', rows: [[10, 10]], percentages: ['50%', '50%'] },
  ];
  it.each((['pie', 'donut'] as const).flatMap((kind) => radialCases.map((entry) => ({ kind, ...entry }))))('preserves $kind proportions for $name', ({ kind, rows, percentages, name }) => {
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block(kind, rows)} /></I18nProvider>);
    const svg = finiteSvg(container);
    const paths = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    const labels = [...container.querySelectorAll('.neo-chart-pie__value')].map((label) => label.textContent!);
    expect(labels.map((label) => label.match(/\d+%/)?.[0])).toEqual(percentages);
    for (const label of labels) expect(label).not.toMatch(/NaN|Infinity|∞/);
    if (name !== 'ordinary') {
      for (const label of labels) { expect(label).toContain('E'); expect(label.length).toBeLessThanOrEqual(24); }
      if (kind === 'donut') expect(svg.textContent).toContain('E308 kg');
    } else expect(labels).toEqual(['10 kg · 50%', '10 kg · 50%']);
  });

  it.each(['pie', 'donut'] as const)('preserves zero/negative %s values', (kind) => {
    const { container } = render(<I18nProvider locale="en"><ChartRenderer block={block(kind, [[-max], [0]])} /></I18nProvider>);
    finiteSvg(container);
    expect([...container.querySelectorAll('.neo-chart-pie__value')].map((label) => label.textContent)).toEqual(['0 kg · 0%', '0 kg · 0%']);
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
