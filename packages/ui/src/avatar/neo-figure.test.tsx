import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n.js';
import { AVATAR_CHARACTERS, DEFAULT_AVATAR, serializeAvatar } from './config.js';
import { NeoFigure } from './neo-figure.js';

afterEach(cleanup);

describe('NeoFigure', () => {
  it.each(AVATAR_CHARACTERS)('loads only the separate %s figure file', (kind) => {
    const { container } = render(<NeoFigure kind={kind} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toMatch(new RegExp(`/avatar-figures/${kind}\\.webp$`));
    expect(image.getAttribute('src')).not.toMatch(/^data:/);
    expect(image.getAttribute('decoding')).toBe('async');
    expect(image.getAttribute('draggable')).toBe('false');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelectorAll('link[rel="preload"]')).toHaveLength(0);
    expect(container.querySelector('.neo-avfig')!.getAttribute('data-variant')).toBe('color');
  });

  it.each(AVATAR_CHARACTERS)('loads the ink variant for %s', (kind) => {
    const { container } = render(<NeoFigure kind={kind} variant="ink" />);
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(new RegExp(`/avatar-figures/${kind}-ink\\.webp$`));
    expect(container.querySelector('.neo-avfig')!.getAttribute('data-variant')).toBe('ink');
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('reads stored configs and lets kind override the selected character', () => {
    const { container, rerender } = render(<NeoFigure avatar={serializeAvatar({ kind: 'girl', bg: '#DCD0F4' })} />);
    expect(container.querySelector('.neo-avfig')!.getAttribute('data-kind')).toBe('girl');
    rerender(<NeoFigure avatar={{ kind: 'cat', bg: '#DEEAF4' }} kind="dog" />);
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/dog\.webp$/);
    rerender(<NeoFigure avatar={null} />);
    expect(container.querySelector('.neo-avfig')!.getAttribute('data-kind')).toBe(DEFAULT_AVATAR.kind);
    rerender(<NeoFigure avatar="🤖" />);
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/robot\.webp$/);
  });

  it('falls back to the portrait after an image error and retries when the kind changes', () => {
    const { container, rerender } = render(<NeoFigure avatar={{ kind: 'cat', bg: '#DCD0F4' }} />);
    fireEvent.error(screen.getByRole('img', { name: 'Cat' }));
    const portrait = screen.getByRole('img', { name: 'Cat' });
    expect(portrait.classList.contains('neo-av')).toBe(true);
    expect(portrait.getAttribute('data-kind')).toBe('cat');
    expect(portrait.querySelector('rect')!.getAttribute('fill')).toBe('#DCD0F4');
    expect(container.querySelector('img')).toBeNull();

    rerender(<NeoFigure kind="dog" />);
    expect(screen.getByRole('img', { name: 'Dog' }).tagName).toBe('IMG');
    rerender(<NeoFigure kind="cat" />);
    expect(screen.getByRole('img', { name: 'Cat' }).tagName).toBe('IMG');
  });

  it('renders the artwork without a rim-light filter', () => {
    const { container } = render(<NeoFigure kind="girl" />);
    const root = container.querySelector('.neo-avfig') as HTMLElement;
    expect(root.style.filter).toBe('');
    const css = document.querySelector('style[data-href="neo-avfig"], style[href="neo-avfig"]')!.textContent!;
    expect(css).not.toContain('drop-shadow');
    expect(css).not.toMatch(/\.neo-avfig::(?:before|after)\s*\{/);
    expect(root.style.getPropertyValue('--neo-avfig-ink')).toBe('');
  });

  it('accepts className and layout styles', () => {
    const { container } = render(<NeoFigure className="poster-art" style={{ height: 600 }} />);
    const root = container.querySelector('.neo-avfig') as HTMLElement;
    expect(root.classList.contains('poster-art')).toBe(true);
    expect(root.style.height).toBe('600px');
  });

  it('falls back for an ink image error and retries when the variant changes', () => {
    const { container, rerender } = render(<NeoFigure kind="cat" variant="ink" />);
    fireEvent.error(screen.getByRole('img', { name: 'Cat' }));
    expect(screen.getByRole('img', { name: 'Cat' }).classList.contains('neo-av')).toBe(true);

    rerender(<NeoFigure kind="cat" variant="color" />);
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/cat\.webp$/);
  });

  it('uses translated character names for the figure and fallback', () => {
    render(<I18nProvider locale="zh-CN"><NeoFigure kind="cat" /></I18nProvider>);
    const image = screen.getByRole('img', { name: '猫咪' });
    expect(image.getAttribute('alt')).toBe('猫咪');
    fireEvent.error(image);
    expect(screen.getByRole('img', { name: '猫咪' }).classList.contains('neo-av')).toBe(true);
  });

  it('uses an app-provided translation for the character name', () => {
    render(<I18nProvider locale="en" messages={{ en: { 'avatar.kind.robot': 'NEO Robot' } }}><NeoFigure /></I18nProvider>);
    expect(screen.getByRole('img', { name: 'NEO Robot' })).toBeTruthy();
  });

  describe('glitch variant', () => {
    let hidden: boolean;
    let setReducedMotion: (matches: boolean) => void;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      hidden = false;
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
      const listeners = new Set<() => void>();
      const media = {
        matches: false,
        addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
        removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
      };
      vi.stubGlobal('matchMedia', vi.fn(() => media));
      setReducedMotion = (matches) => act(() => {
        media.matches = matches;
        listeners.forEach((listener) => listener());
      });
    });

    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function loadLayers(container: HTMLElement, name = 'Cat') {
      fireEvent.load(screen.getByRole('img', { name }));
      const ink = container.querySelector('.neo-avfig__ink')!;
      fireEvent.load(ink);
      return ink;
    }

    function setHidden(value: boolean) {
      act(() => {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }

    it('loads the hidden ink eagerly after the accessible color image loads', () => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      const color = screen.getByRole('img', { name: 'Cat' });
      expect(color.getAttribute('src')).toMatch(/cat\.webp$/);
      expect(root.getAttribute('data-variant')).toBe('glitch');
      expect(container.querySelector('.neo-avfig__ink')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.load(color);
      const ink = container.querySelector('.neo-avfig__ink')!;
      expect(container.querySelectorAll('img')).toHaveLength(2);
      expect(screen.getAllByRole('img')).toEqual([color]);
      expect(ink.getAttribute('src')).toMatch(/cat-ink\.webp$/);
      expect(ink.getAttribute('aria-hidden')).toBe('true');
      expect(ink.getAttribute('alt')).toBe('');
      expect(ink.getAttribute('loading')).toBe('eager');
      expect(ink.getAttribute('draggable')).toBe('false');
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.mouseEnter(root);
      fireEvent.pointerDown(root, { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(8000); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      fireEvent.load(ink);
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => { vi.advanceTimersByTime(480); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    });

    it.each([0, 0.5, 0.999])('starts a random burst within 4–8 seconds for random %s', (random) => {
      vi.mocked(Math.random).mockReturnValue(random);
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      const interval = 4000 + random * 4000;
      act(() => { vi.advanceTimersByTime(interval - 1); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      act(() => { vi.advanceTimersByTime(1); });
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => { vi.advanceTimersByTime(479); });
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => { vi.advanceTimersByTime(1); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
    });

    it.each(['hover', 'tap'])('bursts on %s and returns to color', (event) => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      if (event === 'hover') fireEvent.mouseEnter(root);
      else fireEvent.pointerDown(root, { pointerType: 'touch' });
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => { vi.advanceTimersByTime(480); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(screen.getByRole('img', { name: 'Cat' }).getAttribute('src')).toMatch(/cat\.webp$/);
    });

    it('bursts for a changed external trigger without a mount burst or remount', () => {
      const { container, rerender } = render(<NeoFigure kind="cat" variant="glitch" glitchTrigger={5} />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={6} />);
      expect(container.querySelector('.neo-avfig')).toBe(root);
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => vi.advanceTimersByTime(480));
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={6} />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={7} />);
      expect(root.getAttribute('data-glitch')).toBe('true');
    });

    it('waits for loaded layers when an external trigger arrives early', () => {
      const { container, rerender } = render(<NeoFigure kind="cat" variant="glitch" glitchTrigger={0} />);
      const root = container.querySelector('.neo-avfig')!;
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={1} />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      loadLayers(container);
      expect(root.getAttribute('data-glitch')).toBe('true');
    });

    it('suppresses external triggers during reduced motion and hidden tabs', () => {
      const { container, rerender } = render(<NeoFigure kind="cat" variant="glitch" glitchTrigger={0} />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      setReducedMotion(true);
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={1} />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      setReducedMotion(false);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      setHidden(true);
      rerender(<NeoFigure kind="cat" variant="glitch" glitchTrigger={2} />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      setHidden(false);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('bursts on a new kind only after its layers have loaded', () => {
      const { container, rerender } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      rerender(<NeoFigure kind="dog" variant="glitch" />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(container.querySelector('.neo-avfig__ink')).toBeNull();
      fireEvent.load(screen.getByRole('img', { name: 'Dog' }));
      const ink = container.querySelector('.neo-avfig__ink')!;
      expect(ink.getAttribute('src')).toMatch(/dog-ink\.webp$/);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      fireEvent.load(ink);
      expect(root.getAttribute('data-glitch')).toBe('true');
      act(() => { vi.advanceTimersByTime(480); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
    });

    it('waits for new layers when switching back to a previously loaded kind', () => {
      const { container, rerender } = render(<NeoFigure kind="robot" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container, 'Robot');
      rerender(<NeoFigure kind="cat" variant="glitch" />);
      fireEvent.load(screen.getByRole('img', { name: 'Cat' }));
      rerender(<NeoFigure kind="robot" variant="glitch" />);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(container.querySelector('.neo-avfig__ink')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.load(screen.getByRole('img', { name: 'Robot' }));
      expect(root.hasAttribute('data-glitch')).toBe(false);
      fireEvent.load(container.querySelector('.neo-avfig__ink')!);
      expect(root.getAttribute('data-glitch')).toBe('true');
    });

    it('keeps color without timers or bursts when reduced motion is enabled', () => {
      setReducedMotion(true);
      const { container, rerender } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      const color = screen.getByRole('img', { name: 'Cat' });
      fireEvent.load(color);
      const ink = container.querySelector('.neo-avfig__ink');
      if (ink) fireEvent.load(ink);
      fireEvent.mouseEnter(root);
      fireEvent.pointerDown(root, { pointerType: 'touch' });
      rerender(<NeoFigure kind="dog" variant="glitch" />);
      fireEvent.load(screen.getByRole('img', { name: 'Dog' }));
      act(() => { vi.advanceTimersByTime(20000); });
      expect(vi.getTimerCount()).toBe(0);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(screen.getByRole('img', { name: 'Dog' }).getAttribute('src')).toMatch(/dog\.webp$/);
    });

    it('follows live reduced-motion changes and cancels a running burst', () => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      fireEvent.mouseEnter(root);
      expect(root.getAttribute('data-glitch')).toBe('true');
      setReducedMotion(true);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      act(() => { vi.advanceTimersByTime(20000); });
      setReducedMotion(false);
      const ink = container.querySelector('.neo-avfig__ink');
      if (ink) fireEvent.load(ink);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      act(() => { vi.advanceTimersByTime(6000); });
      expect(root.getAttribute('data-glitch')).toBe('true');
    });

    it.each(['waiting', 'bursting'])('cleans up timers when unmounted while %s', (state) => {
      const { container, unmount } = render(<NeoFigure kind="cat" variant="glitch" />);
      loadLayers(container);
      if (state === 'bursting') fireEvent.mouseEnter(container.querySelector('.neo-avfig')!);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(() => { vi.advanceTimersByTime(20000); });
    });

    it('pauses a hidden tab and resumes with a fresh random interval', () => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      loadLayers(container);
      act(() => { vi.advanceTimersByTime(3000); });
      setHidden(true);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.mouseEnter(root);
      fireEvent.pointerDown(root, { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(20000); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      vi.mocked(Math.random).mockReturnValue(0);
      setHidden(false);
      expect(vi.getTimerCount()).toBe(1);
      act(() => { vi.advanceTimersByTime(3999); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      act(() => { vi.advanceTimersByTime(1); });
      expect(root.getAttribute('data-glitch')).toBe('true');
      setHidden(true);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('never schedules a burst when initially hidden', () => {
      hidden = true;
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      loadLayers(container);
      expect(vi.getTimerCount()).toBe(0);
      expect(container.querySelector('.neo-avfig')!.hasAttribute('data-glitch')).toBe(false);
      setHidden(false);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('disables glitching when the ink fails while retaining the color figure', () => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      const root = container.querySelector('.neo-avfig')!;
      const ink = loadLayers(container);
      fireEvent.mouseEnter(root);
      expect(root.getAttribute('data-glitch')).toBe('true');
      fireEvent.error(ink);
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.mouseEnter(root);
      fireEvent.pointerDown(root, { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(20000); });
      expect(root.hasAttribute('data-glitch')).toBe(false);
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(screen.getByRole('img', { name: 'Cat' }).getAttribute('src')).toMatch(/cat\.webp$/);
    });

    it('uses the portrait fallback if the color figure fails', () => {
      const { container } = render(<NeoFigure kind="cat" variant="glitch" />);
      fireEvent.error(screen.getByRole('img', { name: 'Cat' }));
      expect(screen.getByRole('img', { name: 'Cat' }).classList.contains('neo-av')).toBe(true);
      expect(container.querySelector('img')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(container.querySelector('.neo-avfig')!.hasAttribute('data-glitch')).toBe(false);
    });
  });
});
