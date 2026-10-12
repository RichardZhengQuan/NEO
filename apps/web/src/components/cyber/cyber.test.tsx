import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PrintBackdrop } from './PrintBackdrop.js';
import { PrintWordmark } from './PrintWordmark.js';
import { CircuitTraces, HazardStripes, PrintBadges, RingGauge, StackedTabs } from './PrintGraphics.js';
import { TerminalLine } from './TerminalLine.js';
import { Hud } from './Hud.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function motionPreference(reduced: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: reduced,
    addEventListener: vi.fn((_event: string, listener: () => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_event: string, listener: () => void) => { listeners.delete(listener); }),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  return {
    media,
    set(reducedMotion: boolean) {
      act(() => {
        media.matches = reducedMotion;
        listeners.forEach((listener) => listener());
      });
    },
  };
}

describe('print decorations', () => {
  it('keeps the whole graphic kit decorative and sparsifies the compact backdrop', () => {
    const { container, rerender } = render(<PrintBackdrop />);
    for (const selector of ['.print-backdrop', '.print-traces', '.print-ring-gauge', '.print-hazards', '.print-badges', '.print-tabs', '.print-pill', '.print-shield']) {
      const elements = container.querySelectorAll(selector);
      expect(elements.length).toBeGreaterThan(0);
      elements.forEach((element) => expect(element.getAttribute('aria-hidden')).toBe('true'));
    }
    expect(container.querySelectorAll('.print-tabs span')).toHaveLength(3);
    expect(container.querySelectorAll('.print-pill')).toHaveLength(3);
    expect(container.querySelectorAll('.print-shield')).toHaveLength(2);
    expect(container.querySelectorAll('.print-pill [data-icon]')).toHaveLength(3);
    expect(container.querySelector('.print-traces [stroke-dasharray]')).not.toBeNull();
    rerender(<PrintBackdrop compact />);
    expect(container.firstElementChild!.classList.contains('print-backdrop--compact')).toBe(true);
    expect(container.querySelector('.print-traces')).not.toBeNull();
    expect(container.querySelector('.print-tabs')).not.toBeNull();
    expect(container.querySelector('.print-ring-gauge')).toBeNull();
    expect(container.querySelector('.print-hazards')).toBeNull();
    expect(container.querySelector('.print-badges')).toBeNull();
  });

  it('keeps individual graphic roots hidden when used outside the backdrop', () => {
    const { container } = render(<><StackedTabs /><CircuitTraces /><HazardStripes /><RingGauge /><PrintBadges /></>);
    Array.from(container.children).forEach((element) => expect(element.getAttribute('aria-hidden')).toBe('true'));
  });

  it('gives each ring its own text path and keeps its text on the circle', () => {
    const { container } = render(<><RingGauge /><RingGauge /></>);
    const textPaths = Array.from(container.querySelectorAll('textPath'));
    expect(textPaths).toHaveLength(2);
    expect(new Set(textPaths.map((path) => path.getAttribute('href'))).size).toBe(2);
    for (const textPath of textPaths) {
      expect(textPath.textContent).toBe('NEO · PERSONAL AI · v0.1 ·');
      const id = textPath.getAttribute('href')!.slice(1);
      expect(container.querySelector(`[id="${id}"]`)?.tagName).toBe('path');
    }
  });

  it('turns print misregistration and ring motion off when the preference changes', () => {
    const preference = motionPreference(false);
    const { container, unmount } = render(<><PrintWordmark /><RingGauge /></>);
    const wordmark = container.querySelector('.cyber-wordmark')!;
    const ring = container.querySelector('.print-ring-gauge')!;
    expect(wordmark.textContent).toBe('NEO');
    expect(wordmark.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark.classList.contains('cyber-wordmark--animated')).toBe(true);
    expect(ring.classList.contains('print-ring-gauge--animated')).toBe(true);
    preference.set(true);
    expect(wordmark.getAttribute('data-motion')).toBe('off');
    expect(ring.getAttribute('data-motion')).toBe('off');
    expect(wordmark.classList.contains('cyber-wordmark--animated')).toBe(false);
    expect(ring.classList.contains('print-ring-gauge--animated')).toBe(false);
    unmount();
    expect(preference.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('keeps HUD brand identifiers decorative without implying a connection state', () => {
    const { container } = render(<Hud step="// STEP 02/05" />);
    expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.cyber-hud-corner')).toHaveLength(4);
    expect(container.textContent).toContain('NEO://PERSONAL_AI v0.1');
    expect(container.textContent).toContain('// STEP 02/05');
    expect(container.textContent).not.toContain('ONLINE');
    expect(container.textContent).not.toContain('LOCAL NODE');
  });
});

describe('terminal typewriter', () => {
  it('shows a complete stable accessible line while the decorative text types', () => {
    vi.useFakeTimers();
    motionPreference(false);
    const { container, unmount } = render(<TerminalLine text="choose a face_" />);
    const visible = container.querySelector('.print-terminal-text')!;
    const accessible = container.querySelector('.print-terminal-accessible')!;
    expect(accessible.textContent).toBe('choose a face_');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.textContent).toBe('');
    expect(container.querySelector('.print-terminal-cursor')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[aria-live]')).toBeNull();
    act(() => vi.advanceTimersByTime(90));
    expect(visible.textContent).toBe('ch');
    expect(accessible.textContent).toBe('choose a face_');
    act(() => vi.advanceTimersByTime(1000));
    expect(visible.textContent).toBe('choose a face_');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the full text immediately under reduced motion', () => {
    vi.useFakeTimers();
    motionPreference(true);
    const { container, rerender } = render(<TerminalLine text="choose a face_" />);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('choose a face_');
    expect(container.firstElementChild!.getAttribute('data-motion')).toBe('off');
    expect(vi.getTimerCount()).toBe(0);
    rerender(<TerminalLine text="neo is online_" />);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('neo is online_');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backspaces the previous step before typing its replacement within 540 ms', () => {
    vi.useFakeTimers();
    motionPreference(false);
    const { container, rerender, unmount } = render(<TerminalLine text="choose a face_" />);
    const visible = container.querySelector('.print-terminal-text')!;
    act(() => vi.advanceTimersByTime(1000));
    expect(visible.textContent).toBe('choose a face_');
    rerender(<TerminalLine text="neo is online_" />);
    expect(visible.textContent).toBe('choose a face_');
    expect(container.querySelector('.print-terminal-accessible')!.textContent).toBe('neo is online_');
    act(() => vi.advanceTimersByTime(45));
    expect(visible.textContent).toBe('choose ');
    act(() => vi.advanceTimersByTime(45));
    expect(visible.textContent).toBe('');
    act(() => vi.advanceTimersByTime(100));
    expect(visible.textContent!.length).toBeGreaterThan(0);
    expect(visible.textContent).not.toBe('neo is online_');
    act(() => vi.advanceTimersByTime(350));
    expect(visible.textContent).toBe('neo is online_');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('cancels backspacing when reduced motion becomes active without replaying it', () => {
    vi.useFakeTimers();
    const preference = motionPreference(false);
    const { container, rerender, unmount } = render(<TerminalLine text="choose a face_" />);
    act(() => vi.advanceTimersByTime(90));
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('ch');
    rerender(<TerminalLine text="neo is online_" />);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('ch');
    expect(container.querySelector('.print-terminal-accessible')!.textContent).toBe('neo is online_');
    act(() => vi.advanceTimersByTime(45));
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('c');
    preference.set(true);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('neo is online_');
    expect(vi.getTimerCount()).toBe(0);
    preference.set(false);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('neo is online_');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders a resumed line without entry motion and still animates later changes', () => {
    vi.useFakeTimers();
    motionPreference(false);
    const { container, rerender, unmount } = render(<TerminalLine text="choose a face_" animateOnMount={false} />);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('choose a face_');
    expect(vi.getTimerCount()).toBe(0);
    rerender(<TerminalLine text="neo is online_" animateOnMount={false} />);
    act(() => vi.advanceTimersByTime(540));
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('neo is online_');
    rerender(<TerminalLine text="choose a face_" animateOnMount={false} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
