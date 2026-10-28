import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon, iconPaths } from './icons.js';

describe('iconPaths', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'propertyIsEnumerable'])('returns null for prototype-inherited name "%s"', (name) => {
    expect(iconPaths(name)).toBeNull();
  });

  it.each(['heart', 'star'])('returns path data for "%s"', (name) => {
    const paths = iconPaths(name);
    expect(paths).not.toBeNull();
    expect(Array.isArray(paths)).toBe(true);
  });

  it('resolves an existing alias to its icon path data', () => {
    expect(iconPaths('health')).toEqual(iconPaths('heart'));
  });
});

describe('Icon', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(['toString', 'HomeIcon', 'hasOwnProperty', 'myIcon', 'my_icon', 'ABC', 'constructor', '__proto__', 'propertyIsEnumerable', 'unknown-icon', 'toString😀', '', '   '])('renders the generic SVG fallback for "%s"', (name) => {
    const { container } = render(createElement(Icon, { name, size: 17 }));
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('data-icon')).toBe(name.trim());
    expect(svg?.querySelectorAll('path')).toHaveLength(1);
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0');
    expect(container.textContent).toBe('');
  });

  it.each(['heart', 'check-circle', 'health', ' weather '])('renders known icon or alias "%s" as SVG paths', (name) => {
    const { container } = render(createElement(Icon, { name }));
    const paths = [...container.querySelectorAll('svg path')].map((path) => path.getAttribute('d'));
    expect(paths).toEqual(iconPaths(name.trim()));
    expect(container.textContent).toBe('');
  });

  it.each(['😀', '☀️', '👍🏽', '👩‍💻', '👩🏽‍💻', '🇸🇬', '1️⃣', '👨‍👩‍👧‍👦', '★', '中', 'é'])('renders the complete single grapheme "%s" as text', (name) => {
    const { container } = render(createElement(Icon, { name }));
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('span')?.textContent).toBe(name);
    expect(container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['😀😃😄😁😆', '😀'],
    ['👩‍💻👨‍💻', '👩‍💻'],
    ['👨‍👩‍👧‍👦😀', '👨‍👩‍👧‍👦'],
    ['🇸🇬🇺🇸', '🇸🇬'],
    ['  中英文  ', '中'],
  ])('renders only the first grapheme of "%s"', (name, expected) => {
    const { container } = render(createElement(Icon, { name }));
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('span')?.textContent).toBe(expected);
  });

  it('clips text to the fixed icon slot while preserving its label and presentation', () => {
    const { getByRole } = render(createElement(Icon, {
      name: '👩‍💻', size: 17, label: 'Developer', className: 'card-icon',
      style: { color: 'red', overflow: 'visible', width: 100, flexShrink: 1 },
    }));
    const glyph = getByRole('img', { name: 'Developer' });
    expect(glyph.tagName).toBe('SPAN');
    expect(glyph.textContent).toBe('👩‍💻');
    expect(glyph.className).toBe('card-icon');
    expect(glyph.hasAttribute('aria-hidden')).toBe(false);
    expect(glyph.style.color).toBe('red');
    expect(glyph.style.width).toBe('17px');
    expect(glyph.style.height).toBe('17px');
    expect(glyph.style.flexShrink).toBe('0');
    expect(glyph.style.overflow).toBe('hidden');
    expect(glyph.style.whiteSpace).toBe('nowrap');
  });

  it.each([
    ['😀😃😄😁😆', '😀'],
    ['☀️☁️', '☀️'],
    ['👍🏽👍', '👍🏽'],
    ['👩‍💻👨‍💻', '👩‍💻'],
    ['👩🏽‍💻😀', '👩🏽‍💻'],
    ['👨‍👩‍👧‍👦😀', '👨‍👩‍👧‍👦'],
    ['🇸🇬🇺🇸', '🇸🇬'],
    ['1️⃣2️⃣', '1️⃣'],
    ['★☆', '★'],
    ['中文', '中'],
    ['éé', 'é'],
  ])('preserves one grapheme of "%s" without Intl.Segmenter', (name, expected) => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    const { container } = render(createElement(Icon, { name }));
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('span')?.textContent).toBe(expected);
  });

  it.each(['toString', 'HomeIcon', '__proto__', 'constructor', 'hasOwnProperty'])('still uses the SVG fallback for "%s" without Intl.Segmenter', (name) => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    const { container } = render(createElement(Icon, { name }));
    expect(container.querySelector('svg path')?.getAttribute('d')).toBe('M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0');
    expect(container.textContent).toBe('');
  });

  it.each([
    ['NUL', '\u0000\u0301'],
    ['NEXT LINE', '\u0085\u0301'],
    ['ZERO WIDTH SPACE', '\u200B\u0301'],
  ])('rejects %s followed by combining marks without Intl.Segmenter', (_kind, name) => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    const { container } = render(createElement(Icon, { name }));
    expect(container.querySelector('svg path')?.getAttribute('d')).toBe('M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0');
    expect(container.textContent).toBe('');
  });
});
