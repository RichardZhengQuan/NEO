import { describe, expect, it } from 'vitest';
import { avatarOrbitGeometry, type OrbitRect } from './orbit-geometry.js';

const rect = (left: number, top: number, width: number, height: number): OrbitRect => ({ left, top, width, height });

describe('measured avatar orbit geometry', () => {
  it('keeps the portrait ellipse at its known 371×821-frame position', () => {
    const geometry = avatarOrbitGeometry({ frame: rect(209, 117, 371, 821), area: rect(0, 0, 927, 977) })!;
    expect(geometry.portrait.x).toBe(394.5);
    expect(geometry.portrait.y).toBeCloseTo(117 + 821 * .48);
    expect(geometry.portrait.rx).toBeCloseTo(371 * .825);
    expect(geometry.portrait.ry).toBeCloseTo(371 * .2);
    expect(geometry).not.toHaveProperty('color');
  });

  it('ignores a zero-sized host and uses the valid frame and viewport', () => {
    const frame = rect(209, 117, 371, 821);
    const viewport = rect(0, 0, 927, 977);
    expect(avatarOrbitGeometry({ frame, area: rect(0, 0, 0, 0), viewport }))
      .toEqual(avatarOrbitGeometry({ frame, area: viewport }));
  });

  it('waits for usable dimensions instead of returning a zero-radius ellipse', () => {
    expect(avatarOrbitGeometry({ frame: rect(0, 0, 0, 0), area: rect(0, 0, 927, 977) })).toBeNull();
    expect(avatarOrbitGeometry({ frame: rect(209, 117, 371, 821), area: rect(0, 0, 0, 0) })).toBeNull();
    expect(avatarOrbitGeometry({ frame: rect(0, 0, NaN, 821), area: rect(0, 0, 927, 977) })).toBeNull();
  });

  it('preserves the portrait ellipse when a bottom-right poster sits below it', () => {
    const props = { frame: rect(139, 117, 371, 821), area: rect(0, 0, 927, 977) };
    const plain = avatarOrbitGeometry(props)!;
    const withCard = avatarOrbitGeometry({ ...props, clearance: rect(551, 701, 320, 220) })!;
    expect(withCard.portrait).toEqual(plain.portrait);
  });

  it('preserves the torso width when only its low central arc nears a taller card', () => {
    const props = { frame: rect(139, 117, 371, 821), area: rect(0, 0, 927, 977) };
    const plain = avatarOrbitGeometry(props)!;
    const withCard = avatarOrbitGeometry({ ...props, clearance: rect(551, 636, 320, 285) })!;
    expect(withCard.portrait.y + withCard.portrait.ry + 32 + 6 + 24).toBeGreaterThan(636);
    expect(withCard.portrait).toEqual(plain.portrait);
  });

  it.each([
    { name: 'desktop', area: rect(0, 0, 1000, 742), frame: rect(55, 40, 529, 678), fallback: rect(144, 203, 352, 352), card: rect(680, 496, 264, 214) },
    { name: 'phone', area: rect(0, 0, 390, 644), frame: rect(8, 56, 374, 580), fallback: rect(19, 170, 352, 352), card: undefined },
  ])('rings a $name portrait fallback below its face, inside the stage', ({ area, frame, fallback, card }) => {
    const geometry = avatarOrbitGeometry({ frame, fallback, area, clearance: card })!;
    const { x, y, rx, ry } = geometry.portrait;
    const radius = geometry.portraitRadius;
    const bottom = fallback.top + fallback.height;
    expect(y).toBeGreaterThanOrEqual(bottom);
    expect(geometry.focusedPortraitMinY).toBe(bottom + radius + 8);
    for (let degree = 0; degree < 360; degree++) {
      const theta = degree * Math.PI / 180;
      const point = { x: x + rx * Math.cos(theta), y: y + ry * Math.sin(theta) };
      expect(point.y + radius + 12).toBeLessThanOrEqual(area.height + 1e-9);
      expect(point.x - radius - 12).toBeGreaterThanOrEqual(-1e-9);
      expect(point.x + radius + 12).toBeLessThanOrEqual(area.width + 1e-9);
      // Rear targets pass behind the portrait; front ones never cover it.
      if (Math.sin(theta) < 0) continue;
      const clearBelow = point.y - radius - 8 >= bottom - 1e-9;
      const clearBeside = Math.abs(point.x - (fallback.left + fallback.width / 2)) - radius - 8 >= fallback.width / 2 - 1e-9;
      expect(clearBelow || clearBeside).toBe(true);
      if (card) {
        const verticalGap = point.y + radius + 6 + 24 <= card.top || point.y - radius - 6 - 24 >= card.top + card.height;
        expect(verticalGap || point.x + radius + 6 + 24 <= card.left).toBe(true);
      }
    }
  });

  it('keeps the torso ellipse when a portrait fallback leaves no room for a ring below it', () => {
    const props = { frame: rect(8, 56, 374, 580), area: rect(0, 0, 390, 644) };
    expect(avatarOrbitGeometry({ ...props, fallback: rect(19, 280, 352, 352) })).toEqual(avatarOrbitGeometry(props));
  });

  it.each([[927, 977], [1280, 800], [1440, 900], [1920, 1080]].flatMap(([width, height]) =>
    Object.entries({ robot: 225, boy: 171, girl: 158, cat: 295, dog: 307 }).map(([kind, halfWidth]) => ({ width: width!, height: height!, kind, halfWidth })),
  ))('keeps $kind circles spaced and contained on a $width×$height cropped-artwork stage for 45 seconds', ({ width, height, halfWidth }) => {
    const bottomInset = Math.max(24, height * .02);
    const figureHeight = Math.min(height * .94, height - Math.max(40, height * .03) - bottomInset);
    const topInset = height - bottomInset - figureHeight;
    const figureWidth = figureHeight * 32 / 41;
    const center = Math.max(width * .32, figureHeight * halfWidth / 984 + 12);
    const cardWidth = Math.max(264, Math.min(320, width * .22));
    const card = rect(width - 56 - cardWidth, height - 32 - 220, cardWidth, 220);
    const geometry = avatarOrbitGeometry({ frame: rect(center - figureWidth / 2, topInset, figureWidth, figureHeight), area: rect(0, 0, width, height), clearance: card })!;
    const count = 5;
    const radius = 32;
    const ellipse = geometry.portrait;
    expect(ellipse.rx).toBeGreaterThan(150);
    expect(ellipse.ry).toBeGreaterThan(90);
    // Portraits retain their 30s turn.
    for (let second = 0; second <= 45; second++) {
      const phase = Math.PI / 2 + second * Math.PI * 2 / 30;
      const points = Array.from({ length: count }, (_, index) => {
        const angle = phase + index * Math.PI * 2 / count;
        return { x: ellipse.x + ellipse.rx * Math.cos(angle), y: ellipse.y + ellipse.ry * Math.sin(angle) };
      });
      points.forEach((point, index) => {
        expect(point.x - radius - 6).toBeGreaterThanOrEqual(0);
        expect(point.x + radius + 6).toBeLessThanOrEqual(width);
        expect(point.y - radius - 6).toBeGreaterThanOrEqual(0);
        expect(point.y + radius + 6).toBeLessThanOrEqual(height);
        const next = points[(index + 1) % count]!;
        expect(Math.hypot(next.x - point.x, next.y - point.y)).toBeGreaterThan(30);
        const verticalGap = point.y + radius + 6 + 24 <= card.top || point.y - radius - 6 - 24 >= card.top + card.height;
        expect(verticalGap || point.x + radius + 6 + 24 <= card.left).toBe(true);
      });
    }
  });
});
