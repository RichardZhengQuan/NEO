import { useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSceneFlipGeometry, useSceneTransition } from './useSceneTransition.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const poster = { left: 1064, top: 604, width: 320, height: 240 };
const content = { left: 644, top: 70, width: 740, height: 774 };
const sceneCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function cssDeclarations(selector: string) {
  const rule = Array.from(sceneCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)).find((match) => match[1]!.split(',').some((item) => item.trim() === selector));
  expect(rule, `Missing scene CSS contract for ${selector}`).toBeDefined();
  return Object.fromEntries(rule![2]!.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const colon = item.indexOf(':');
    return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
  }));
}

describe('window transition geometry', () => {
  it('applies the measured origin to FLIP and uses the same timing for native corner-preserving geometry', () => {
    const flip = cssDeclarations(".cyber-onboarding[data-motion='on'].cyber-transition--fallback .cyber-flip");
    expect(flip['transform-origin']).toBe('var(--neo-flip-origin, top left)');
    expect(flip.animation).toBe('neo-scene-flip 560ms var(--neo-transition-ease) both');
    const native = cssDeclarations(':root:has(.cyber-onboarding)::view-transition-group(neo-card)');
    expect(native['animation-duration']).toBe('560ms');
    expect(native['animation-timing-function']).toBe('cubic-bezier(.2, .8, .2, 1)');
  });

  it.each([[poster, content], [content, poster]])('keeps the right and bottom edges fixed throughout the resize', (before, after) => {
    const flip = getSceneFlipGeometry(before, after, 'bottom-right');
    expect(flip.origin).toBe('bottom right');
    expect(flip.x).toBe(0);
    expect(flip.y).toBe(0);
    const right = after.left + after.width;
    const bottom = after.top + after.height;
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const scaleX = flip.scaleX + (1 - flip.scaleX) * progress;
      const scaleY = flip.scaleY + (1 - flip.scaleY) * progress;
      const left = right - after.width * scaleX;
      const top = bottom - after.height * scaleY;
      expect(left + after.width * scaleX).toBeCloseTo(before.left + before.width);
      expect(top + after.height * scaleY).toBeCloseTo(before.top + before.height);
      if (progress === 0) {
        expect(left).toBeCloseTo(before.left);
        expect(top).toBeCloseTo(before.top);
      }
      if (progress === 1) {
        expect(left).toBeCloseTo(after.left);
        expect(top).toBeCloseTo(after.top);
      }
    }
  });

  it('retains optional left posters and ordinary scene geometry without invalid zero-size scales', () => {
    expect(getSceneFlipGeometry({ ...poster, left: 56 }, { ...content, left: 56 }, 'bottom-left')).toEqual({
      x: 0, y: 0, scaleX: 320 / 740, scaleY: 240 / 774, origin: 'bottom left',
    });
    expect(getSceneFlipGeometry(poster, content)).toEqual({
      x: 420, y: 534, scaleX: 320 / 740, scaleY: 240 / 774, origin: 'top left',
    });
    expect(getSceneFlipGeometry(poster, { left: 0, top: 0, width: 0, height: 0 }, 'bottom-right')).toEqual({
      x: 1384, y: 844, scaleX: 1, scaleY: 1, origin: 'bottom right',
    });
  });
});

describe('native window snapshot background', () => {
  it('renders one stable fill while the group resizes, without overlapping translucent snapshots', () => {
    const oldSnapshot = cssDeclarations(':root:has(.cyber-onboarding)::view-transition-old(neo-card)');
    const newSnapshot = cssDeclarations(':root:has(.cyber-onboarding)::view-transition-new(neo-card)');
    expect(oldSnapshot).toMatchObject({ animation: 'none', opacity: '0', 'mix-blend-mode': 'normal' });
    expect(newSnapshot).toMatchObject({ animation: 'none', opacity: '1', 'mix-blend-mode': 'normal' });
    expect(cssDeclarations(':root:has(.cyber-onboarding)::view-transition-old(neo-card-content)').animation).toContain('neo-vt-content-out');
    expect(cssDeclarations(':root:has(.cyber-onboarding)::view-transition-new(neo-card-content)').animation).toContain('neo-vt-content-in');
  });
});

function Scene() {
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState('avatar');
  const transition = useSceneTransition(root, false);
  return (
    <div ref={root} className={`cyber-onboarding cyber-transition--${transition.mode ?? 'idle'}`} data-step={step}>
      <div className="cyber-figure-frame" />
      <div className="cyber-wordmark" />
      <div className={`cyber-card ${step === 'ai' ? 'cyber-card--translucent' : ''}`} data-window-anchor="bottom-right">
        <div className="cyber-card-content">
          <button onClick={() => transition.run({ key: step === 'avatar' ? 'ai' : 'avatar', direction: step === 'avatar' ? 'forward' : 'back', commit: () => setStep(step === 'avatar' ? 'ai' : 'avatar') })}>Next</button>
        </div>
      </div>
    </div>
  );
}

describe('window fallback snapshots', () => {
  it('morphs about the shared corner and keeps outgoing snapshots free of a second panel background', () => {
    vi.useFakeTimers();
    const { container } = render(<Scene />);
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    const card = container.querySelector<HTMLElement>('.cyber-card')!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const bounds = this === root ? { left: 0, top: 0, width: 1440, height: 900 } : root.dataset.step === 'avatar' ? poster : content;
      return { ...bounds, x: bounds.left, y: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height, toJSON: () => ({}) } as DOMRect;
    });
    for (const destination of ['ai', 'avatar']) {
      act(() => fireEvent.click(screen.getByRole('button', { name: 'Next' })));
      expect(root.dataset.step).toBe(destination);
      expect(card.classList.contains('cyber-flip')).toBe(true);
      expect(card.style.getPropertyValue('--neo-flip-x')).toBe('0px');
      expect(card.style.getPropertyValue('--neo-flip-y')).toBe('0px');
      expect(card.style.getPropertyValue('--neo-flip-origin')).toBe('bottom right');
      const snapshots = container.querySelectorAll<HTMLElement>('.cyber-card-snapshot');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.style.background).toBe('transparent');
      expect(snapshots[0]!.style.backdropFilter).toBe('none');
      expect(snapshots[0]!.style.translate).toBe('none');
      expect(snapshots[0]!.style.transform).toBe('none');
      act(() => vi.advanceTimersByTime(560));
      expect(container.querySelector('.cyber-card-snapshot')).toBeNull();
      expect(card.style.getPropertyValue('--neo-flip-origin')).toBe('');
    }
  });
});
