import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState, type ReactElement } from 'react';
import { I18nProvider } from '../i18n.js';
import { AVATAR_CHARACTERS } from './config.js';
import { AvatarPicker, type AvatarPickerProps } from './avatar-picker.js';
import { AVATAR_CSS } from './styles.js';

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const resizeCallbacks: ResizeObserverCallback[] = [];
const disconnect = vi.fn();
const observe = vi.fn();

function Harness({ reducedMotion = false, clearance = false, onChange }: { reducedMotion?: boolean; clearance?: boolean; onChange?: AvatarPickerProps['onChange'] }): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<string | null>(null);
  return (
    <I18nProvider locale="en">
      <div data-testid="orbit-area" ref={areaRef}>
        <div data-testid="figure-frame" ref={frameRef} />
        <AvatarPicker layout="orbit" value={value} onChange={(encoded, config) => { setValue(encoded); onChange?.(encoded, config); }} orbitFrameRef={frameRef} orbitAreaRef={areaRef} orbitClearanceRef={clearance ? cardRef : undefined} reducedMotion={reducedMotion} />
        {clearance && <div data-testid="orbit-card" ref={cardRef} />}
      </div>
      <button type="button">Outside the orbit</button>
    </I18nProvider>
  );
}

function advance(ms: number): void {
  act(() => {
    for (let remaining = ms; remaining > 0;) {
      const elapsed = Math.min(16, remaining);
      vi.advanceTimersByTime(elapsed);
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach((callback) => callback(performance.now()));
      remaining -= elapsed;
    }
  });
}

/** Sample real-time revolution geometry without simulating intermediate paints. */
function advanceFrame(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { width, height, left, top, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

const angle = (radio: HTMLElement) => Number(radio.getAttribute('data-orbit-angle'));
const picker = () => document.querySelector<HTMLElement>('.neo-avp--orbit')!;
const portraits = () => within(screen.getByRole('radiogroup', { name: 'Character' })).getAllByRole('radio');
const positiveDelta = (start: number, end: number) => (end - start + Math.PI * 2) % (Math.PI * 2);

function pointerDown(target: HTMLElement, pointerType: 'mouse' | 'touch'): void {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
  return Array.from(rules).flatMap((rule) => rule.type === CSSRule.STYLE_RULE
    ? [rule as CSSStyleRule]
    : 'cssRules' in rule ? styleRules((rule as CSSGroupingRule).cssRules) : []);
}

beforeEach(() => {
  vi.useFakeTimers();
  frames.clear();
  frameId = 0;
  resizeCallbacks.length = 0;
  disconnect.mockClear();
  observe.mockClear();
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe = observe;
    unobserve() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const figure = this.getAttribute('data-testid') === 'figure-frame';
    const width = figure ? 200 : 600;
    const height = figure ? 440 : 620;
    const left = figure ? 200 : 0;
    const top = figure ? 60 : 0;
    return { width, height, left, top, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) };
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('avatar orbits', () => {
  it('keeps every positioned portrait free of CSS transitions and animations', () => {
    const { container } = render(<Harness />);
    const style = document.querySelector<HTMLStyleElement>('style[data-href="neo-avatar"], style[href="neo-avatar"]')!;
    expect(style.textContent).toBe(AVATAR_CSS);
    const rules = styleRules(style.sheet!.cssRules);
    const nodes = container.querySelectorAll<HTMLElement>('.neo-avp-orbit-node');
    expect(nodes).toHaveLength(AVATAR_CHARACTERS.length);
    // jsdom cannot run delayed transitions: verify the parsed, injected CSS contract.
    nodes.forEach((node) => {
      const matching = rules.filter((rule) => node.matches(rule.selectorText));
      expect(matching.some((rule) => rule.style.getPropertyValue('transition') === 'none')).toBe(true);
      matching.forEach((rule) => {
        for (const property of ['transition', 'transition-property']) {
          expect(rule.style.getPropertyValue(property)).not.toMatch(/(?:^|[\s,])(all|transform|opacity|z-index)(?=[\s,]|$)/);
        }
        expect(rule.style.getPropertyValue('transition-delay')).toMatch(/^(?:0(?:ms|s))?$/);
        expect(rule.style.getPropertyValue('animation')).toMatch(/^(?:none)?$/);
        expect(rule.style.getPropertyValue('animation-name')).toMatch(/^(?:none)?$/);
        expect(rule.style.getPropertyValue('animation-delay')).toMatch(/^(?:0(?:ms|s))?$/);
      });
    });
  });

  it('puts the stagger and complete painted circle inside each positioned node', () => {
    const { container } = render(<Harness />);
    const nodes = container.querySelectorAll<HTMLElement>('.neo-avp-orbit-node');
    nodes.forEach((node) => {
      const visual = node.querySelector<HTMLElement>(':scope > .neo-avp-orbit-visual')!;
      expect(visual).toBeTruthy();
      expect(visual.style.getPropertyValue('--neo-avp-orbit-stagger')).toBe(`${Number(node.dataset.orbitIndex) * 40}ms`);
      expect(node.style.getPropertyValue('--neo-avp-orbit-stagger')).toBe('');
      expect(node.style.animationDelay).toBe('');
      expect(node.style.transitionDelay).toBe('');
      expect(visual.style.transform).toBe('');
      expect(visual.style.opacity).toBe('');
      expect(visual.querySelector('.neo-av')).toBeTruthy();
    });
  });

  it('updates every portrait transform at frame cadence', () => {
    const { container } = render(<Harness />);
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('.neo-avp-orbit-node'));
    const positions = nodes.map((node) => node.style.transform);
    advance(16);
    // The first frame seeds the clock; the next must update even staggered items.
    advance(16);
    nodes.forEach((node, index) => expect(node.style.transform).not.toBe(positions[index]));
  });

  it('renders only portraits, with stable accessible order and decorative paths', () => {
    const { container } = render(<Harness />);
    expect(portraits().map((radio) => radio.getAttribute('aria-label')!.toLowerCase())).toEqual(AVATAR_CHARACTERS);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Background' })).toBeNull();
    expect(container.querySelector('.neo-avp-color-choices, .neo-avp-swatch, input[type="color"], [data-orbit="color"]')).toBeNull();
    portraits().forEach((radio) => {
      expect(radio.textContent).toBe('');
      expect(radio.getAttribute('aria-label')).toBeTruthy();
      expect(radio.getAttribute('title') ?? radio.closest('label')?.getAttribute('title')).toBe(radio.getAttribute('aria-label'));
      expect(radio.getAttribute('data-orbit') ?? radio.closest('label')?.getAttribute('data-orbit')).toBe('portrait');
      expect(radio.getAttribute('data-orbit-shape') ?? radio.closest('label')?.getAttribute('data-orbit-shape')).toBe('circle');
    });
    portraits().forEach((radio) => expect(radio.querySelector('.neo-av--circle')).toBeTruthy());
    expect(container.querySelector('.neo-avp-orbit-index, .neo-avp-orbit-trace, .cyber-orbit-swatch-stack')).toBeNull();
    const paths = container.querySelectorAll('[data-orbit-path]');
    expect(Array.from(paths).map((path) => path.getAttribute('data-orbit-path')).sort()).toEqual(['portrait-back', 'portrait-front']);
    paths.forEach((path) => expect(path.closest('[aria-hidden="true"]')).toBeTruthy());
  });

  it('bounds the orbit pause surface to the portrait ellipse', () => {
    const { container } = render(<Harness />);
    const surface = container.querySelector<HTMLElement>('[data-orbit-area]')!;
    // The mobile portrait ellipse has ry=40 and a 28px radius, plus 8px outline room.
    expect(surface.style.height).toBe(`${(40 + 28 + 8) * 2}px`);
    expect(surface.style.transform).toBe('translate3d(99px, 195.2px, 0)');
  });

  it('revolves the portraits at the existing speed and gives the back half depth', () => {
    render(<Harness />);
    const robot = portraits()[0]!;
    advance(1000);
    const portraitStart = angle(robot);
    advance(3000);
    expect(positiveDelta(portraitStart, angle(robot))).toBeCloseTo(Math.PI * 2 * 3 / 30, 2);
    const back = portraits().filter((radio) => radio.getAttribute('data-orbit-depth') === 'back');
    const front = portraits().filter((radio) => radio.getAttribute('data-orbit-depth') === 'front');
    expect(back.length).toBeGreaterThan(0);
    expect(front.length).toBeGreaterThan(0);
    back.forEach((radio) => {
      expect(Number(radio.style.zIndex)).toBeLessThan(Number(front[0]!.style.zIndex));
      expect(Number(radio.style.opacity)).toBeLessThan(1);
      expect(radio.style.transform).toContain('scale(0.8)');
      expect(radio.getAttribute('aria-hidden')).toBeNull();
    });
    expect(portraits().map((radio) => radio.getAttribute('aria-label')!.toLowerCase())).toEqual(AVATAR_CHARACTERS);
  });

  it('pauses the portrait orbit on pointer hover and eases back up to speed after leaving', () => {
    render(<Harness />);
    advance(1000);
    const targets = portraits();
    fireEvent.pointerEnter(screen.getByTestId('orbit-area'));
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    const start = targets.map(angle);
    advance(1200);
    expect(targets.map(angle)).toEqual(start);
    fireEvent.pointerLeave(screen.getByTestId('orbit-area'));
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    advance(16);
    const firstDelta = positiveDelta(start[0]!, angle(targets[0]!));
    expect(firstDelta).toBeGreaterThan(0);
    expect(firstDelta).toBeLessThan(Math.PI * 2 * 0.016 / 30);
    advance(1000);
    expect(targets.map(angle)).not.toEqual(start);
  });

  it('lifts a hovered back-half portrait without changing its orbit depth', () => {
    render(<Harness />);
    advanceFrame(0);
    advanceFrame(21000);
    const target = portraits().find((radio) => radio.dataset.orbitDepth === 'back')!;
    const node = target.closest<HTMLElement>('.neo-avp-orbit-node')!;
    expect(target.dataset.orbitDepth).toBe('back');
    expect(node.dataset.orbitLifted).toBe('false');
    expect(node.style.opacity).toBe('0.6');
    expect(node.style.transform).toContain('scale(0.8)');
    expect(Number(node.style.zIndex)).toBeLessThan(2);
    const originalAngle = angle(target);
    fireEvent.pointerEnter(node);
    expect(node.dataset.orbitLifted).toBe('true');
    expect(target.dataset.orbitLifted).toBe('true');
    expect(target.dataset.orbitDepth).toBe('back');
    expect(node.style.opacity).toBe('1');
    expect(node.style.transform).toContain('scale(0.9)');
    expect(Number(node.style.zIndex)).toBeGreaterThan(2); // Above the figure layer.
    expect(picker().dataset.orbitPaused).toBe('true');
    advance(1000);
    expect(angle(target)).toBe(originalAngle);
    fireEvent.pointerLeave(node);
    expect(node.dataset.orbitLifted).toBe('false');
    expect(target.dataset.orbitLifted).toBe('false');
    expect(node.style.opacity).toBe('0.6');
    expect(node.style.transform).toContain('scale(0.8)');
    expect(Number(node.style.zIndex)).toBeLessThan(2);
    expect(picker().dataset.orbitPaused).toBe('false');
  });

  it('selects a back-half portrait by mouse and eases it to the front centre', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const target = portraits().find((radio) => radio.dataset.orbitDepth === 'back')!;
    const originalAngle = angle(target);
    fireEvent.pointerEnter(target);
    pointerDown(target, 'mouse');
    act(() => target.focus());
    fireEvent.click(target, { detail: 1 });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![1]).toMatchObject({ kind: target.getAttribute('aria-label')!.toLowerCase() });
    expect(target.getAttribute('aria-checked')).toBe('true');
    advance(300);
    expect(angle(target)).not.toBe(originalAngle);
    advance(300);
    expect(angle(target)).toBeCloseTo(Math.PI / 2, 3);
    expect(target.dataset.orbitDepth).toBe('front');
    expect(target.style.zIndex).toBe('3');
    expect(target.style.opacity).toBe('1');
    expect(target.style.transform).toContain('scale(1)');
  });

  it('selects a back-half portrait by touch and retains the four-second pause', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const target = portraits().find((radio) => radio.dataset.orbitDepth === 'back')!;
    const hover = new Event('pointerenter');
    Object.defineProperty(hover, 'pointerType', { value: 'touch' });
    fireEvent(target, hover);
    expect(target.dataset.orbitLifted).toBe('false');
    pointerDown(target, 'touch');
    act(() => target.focus());
    fireEvent.click(target, { detail: 1 });
    expect(onChange).toHaveBeenCalledOnce();
    expect(target.getAttribute('aria-checked')).toBe('true');
    expect(picker().dataset.orbitPaused).toBe('true');
    advance(600);
    expect(angle(target)).toBeCloseTo(Math.PI / 2, 3);
    advance(3399);
    expect(picker().dataset.orbitPaused).toBe('true');
    expect(angle(target)).toBeCloseTo(Math.PI / 2, 3);
    advance(17);
    expect(picker().dataset.orbitPaused).toBe('false');
    advance(1000);
    expect(angle(target)).not.toBeCloseTo(Math.PI / 2, 3);
  });

  it('pauses on focus and makes a back-half portrait fully visible without reordering it', () => {
    render(<Harness />);
    const target = portraits().find((radio) => radio.getAttribute('data-orbit-depth') === 'back')!;
    expect(target).toBeTruthy();
    const originalAngle = angle(target);
    act(() => target.focus());
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    expect(target.getAttribute('data-orbit-depth')).toBe('front');
    expect(target.dataset.orbitLifted).toBe('true');
    expect(target.style.opacity).toBe('1');
    expect(target.style.transform).toContain('scale(1)');
    advance(1500);
    expect(angle(target)).toBe(originalAngle);
    act(() => screen.getByRole('button', { name: 'Outside the orbit' }).focus());
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    advance(1000);
    expect(angle(target)).not.toBe(originalAngle);
  });

  it('pauses the portrait orbit for four seconds after touch, then resumes smoothly', () => {
    render(<Harness />);
    advance(1000);
    const targets = portraits();
    pointerDown(screen.getByTestId('orbit-area'), 'touch');
    const start = targets.map(angle);
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    advance(3999);
    expect(targets.map(angle)).toEqual(start);
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    advance(17);
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    expect(positiveDelta(start[0]!, angle(targets[0]!))).toBeLessThan(Math.PI * 2 * 0.017 / 30);
    advance(1000);
    expect(targets.map(angle)).not.toEqual(start);
  });

  it('resumes after a mouse selection and hover exit even when the browser focused the button', () => {
    render(<Harness />);
    const area = screen.getByTestId('orbit-area');
    const cat = screen.getByRole('radio', { name: 'Cat' });
    fireEvent.pointerEnter(area);
    pointerDown(cat, 'mouse');
    act(() => cat.focus());
    fireEvent.click(cat, { detail: 1 });
    advance(700);
    expect(angle(cat)).toBeCloseTo(Math.PI / 2, 3);
    fireEvent.pointerLeave(area);
    advance(1000);
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    expect(angle(cat)).not.toBeCloseTo(Math.PI / 2, 3);
    advance(15000);
    expect(cat.getAttribute('data-orbit-depth')).toBe('back');
    expect(cat.style.opacity).toBe('0.6');
    expect(cat.style.zIndex).toBe('1');
  });

  it('resumes after four seconds when a touch selection also focused the button', () => {
    render(<Harness />);
    const cat = screen.getByRole('radio', { name: 'Cat' });
    pointerDown(cat, 'touch');
    act(() => cat.focus());
    fireEvent.click(cat, { detail: 1 });
    advance(700);
    expect(angle(cat)).toBeCloseTo(Math.PI / 2, 3);
    advance(3299);
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    expect(angle(cat)).toBeCloseTo(Math.PI / 2, 3);
    advance(1017);
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    expect(angle(cat)).not.toBeCloseTo(Math.PI / 2, 3);
    advance(15000);
    expect(cat.getAttribute('data-orbit-depth')).toBe('back');
    expect(cat.style.opacity).toBe('0.6');
    expect(cat.style.zIndex).toBe('1');
  });

  it('pauses again when keyboard navigation takes over from a pointer-focused choice', () => {
    render(<Harness />);
    const cat = screen.getByRole('radio', { name: 'Cat' });
    pointerDown(cat, 'mouse');
    act(() => cat.focus());
    fireEvent.click(cat, { detail: 1 });
    advance(1000);
    expect(picker().getAttribute('data-orbit-paused')).toBe('false');
    fireEvent.keyDown(cat, { key: 'ArrowRight' });
    const dog = screen.getByRole('radio', { name: 'Dog' });
    expect(document.activeElement).toBe(dog);
    expect(dog.getAttribute('aria-checked')).toBe('true');
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    advance(700);
    const selectedAngle = angle(dog);
    advance(1000);
    expect(angle(dog)).toBe(selectedAngle);
  });

  it('restores keyboard pausing when Shift+Tab returns from an outside action after pointer use', () => {
    render(<Harness />);
    const cat = screen.getByRole('radio', { name: 'Cat' });
    pointerDown(cat, 'mouse');
    act(() => cat.focus());
    fireEvent.click(cat, { detail: 1 });
    advance(21000);
    const rearPortrait = portraits().find((radio) => radio.dataset.orbitDepth === 'back')!;
    expect(rearPortrait.getAttribute('data-orbit-depth')).toBe('back');
    const outside = screen.getByRole('button', { name: 'Outside the orbit' });
    act(() => outside.focus());
    fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
    act(() => rearPortrait.focus());
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    expect(rearPortrait.getAttribute('data-orbit-depth')).toBe('front');
    expect(rearPortrait.style.opacity).toBe('1');
    expect(rearPortrait.style.zIndex).toBe('4');
    expect(rearPortrait.style.transform).toContain('scale(1)');
    const focusedAngle = angle(rearPortrait);
    advance(2000);
    expect(angle(rearPortrait)).toBe(focusedAngle);
  });

  it.each(['Cat', 'Dog', 'Boy', 'Girl'])('eases selected %s to the front centre in 600 ms', (name) => {
    render(<Harness />);
    const target = screen.getByRole('radio', { name });
    const start = angle(target);
    fireEvent.click(target);
    advance(300);
    expect(angle(target)).not.toBe(start);
    expect(angle(target)).not.toBeCloseTo(Math.PI / 2, 3);
    advance(300);
    expect(angle(target)).toBeCloseTo(Math.PI / 2, 3);
    expect(target.getAttribute('data-orbit-depth')).toBe('front');
    advance(1000);
    expect(angle(target)).not.toBeCloseTo(Math.PI / 2, 3);
  });

  it('keeps reduced-motion choices on static front arcs without a frame loop or animated selection', () => {
    render(<Harness reducedMotion />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    const positions = portraits().map((radio) => radio.style.transform || radio.closest<HTMLElement>('label')!.style.transform);
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    portraits().forEach((radio) => expect(radio.getAttribute('data-orbit-depth')).toBe('front'));
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    advance(3000);
    expect(portraits().map((radio) => radio.style.transform || radio.closest<HTMLElement>('label')!.style.transform)).toEqual(positions);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('suspends the loop while the document is hidden and resumes without a time jump', () => {
    render(<Harness />);
    advance(1000);
    const robot = portraits()[0]!;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    const start = angle(robot);
    expect(picker().getAttribute('data-orbit-paused')).toBe('true');
    expect(frames.size).toBe(0);
    advance(10000);
    expect(angle(robot)).toBe(start);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(frames.size).toBe(1);
    advance(16);
    expect(positiveDelta(start, angle(robot))).toBeLessThan(Math.PI * 2 * 0.016 / 30);
  });

  it('remeasures its ellipse when ResizeObserver reports a new figure size', () => {
    const { container } = render(<Harness />);
    const robot = portraits()[0]!;
    const originalTransform = robot.style.transform;
    const originalAngle = angle(robot);
    const path = container.querySelector('[data-orbit-path="portrait-front"] path')!;
    const originalPath = path.getAttribute('d');
    vi.spyOn(screen.getByTestId('figure-frame'), 'getBoundingClientRect').mockReturnValue({
      width: 300, height: 450, left: 150, top: 60, x: 150, y: 60, right: 450, bottom: 510, toJSON: () => ({}),
    });
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(robot.style.transform).not.toBe(originalTransform);
    expect(path.getAttribute('d')).not.toBe(originalPath);
    expect(angle(robot)).toBe(originalAngle);
    expect(frames.size).toBe(1);
  });

  it('rings the portrait fallback when the figure frame swaps to it, and the torso again after', async () => {
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 742);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('data-testid') === 'figure-frame') return rect(55, 40, 529, 678);
      if (this.classList.contains('neo-avfig__portrait')) return rect(144, 203, 352, 352);
      return rect(0, 0, 1000, 742);
    });
    render(<Harness />);
    const path = document.querySelector('[data-orbit-path="portrait-front"] path')!;
    const torso = path.getAttribute('d');
    expect(torso).toMatch(/^M 595 365\.44 A 275\.5 105\.8/);

    const fallback = document.createElement('span');
    fallback.className = 'neo-avfig__portrait';
    await act(async () => { screen.getByTestId('figure-frame').append(fallback); });
    advance(16);
    // Centred on the portrait's lower edge (203 + 352), clear of its face.
    expect(path.getAttribute('d')).toMatch(/^M 595 555 A 275\.5 105\.8/);

    await act(async () => { fallback.remove(); });
    advance(16);
    expect(path.getAttribute('d')).toBe(torso);
  });

  it('keeps phone targets below the face and within a 320 by 384 upper stage for a whole revolution', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const figure = this.getAttribute('data-testid') === 'figure-frame';
      const width = figure ? 204.8 : 320;
      const height = figure ? 248 : 384;
      const left = figure ? 57.6 : 0;
      const top = figure ? 136 : 0;
      return { width, height, left, top, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) };
    });
    render(<Harness />);
    advanceFrame(0);
    for (let second = 0; second <= 45; second++) {
      portraits().forEach((radio) => {
        const node = radio.closest<HTMLElement>('.neo-avp-orbit-node')!;
        const position = node.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)!;
        const scale = Number(node.style.transform.match(/scale\(([-\d.]+)\)/)![1]);
        const radius = 28 * scale;
        const x = Number(position[1]);
        const y = Number(position[2]);
        expect(radius * 2).toBeGreaterThanOrEqual(40);
        expect(x - radius).toBeGreaterThanOrEqual(0);
        expect(x + radius).toBeLessThanOrEqual(320);
        expect(y - radius).toBeGreaterThan(136 + 248 * .2);
        expect(y + radius).toBeLessThanOrEqual(384);
      });
      if (second < 45) advanceFrame(1000);
    }
  });

  it.each(([1024, 1280, 1440, 1920] as const).flatMap((width, index) =>
    (['right', 'left'] as const).map((side) => ({ width, height: [768, 800, 900, 1080][index]!, side })),
  ))('clears the $side poster card and face at $width by $height for a full revolution and keyboard focus', ({ width, height, side }) => {
    const figureCenter = width * (side === 'right' ? .425 : .575);
    const frameWidth = Math.min(width * .4, height * .6);
    const frameHeight = height * .84;
    const frameTop = height * .12;
    const card = rect(side === 'right' ? width - 56 - 320 : 56, (height - 220) / 2, 320, 220);
    const artworkHeight = Math.min(frameHeight, frameWidth * 1.5);
    const artworkWidth = Math.min(frameWidth, frameHeight * 2 / 3);
    // The cat muzzle extends furthest down among the five artwork faces.
    const faceBottom = frameTop + (frameHeight - artworkHeight) / 2 + artworkHeight * .42;
    const artworkGap = side === 'right'
      ? card.left - (figureCenter + artworkWidth / 2)
      : figureCenter - artworkWidth / 2 - card.right;
    expect(artworkGap).toBeGreaterThan(0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-testid')) {
        case 'figure-frame': return rect(figureCenter - frameWidth / 2, frameTop, frameWidth, frameHeight);
        case 'orbit-card': return card;
        default: return rect(0, 0, width, height);
      }
    });
    render(<Harness clearance />);
    expect(observe).toHaveBeenCalledWith(screen.getByTestId('orbit-card'));
    const radios = portraits();
    const assertClearance = (focused?: HTMLElement) => {
      radios.forEach((radio) => {
        const node = radio.closest<HTMLElement>('.neo-avp-orbit-node')!;
        const position = node.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)!;
        const scale = Number(node.style.transform.match(/scale\(([-\d.]+)\)/)![1]);
        const targetRadius = 32 * scale;
        const ring = radio === focused ? 6 : 0;
        const radius = targetRadius + ring;
        const x = Number(position[1]);
        const y = Number(position[2]);
        expect(x - radius).toBeGreaterThanOrEqual(0);
        expect(x + radius).toBeLessThanOrEqual(width);
        if (node.dataset.orbitDepth === 'front') expect(y - radius).toBeGreaterThan(faceBottom);
        else expect(node.style.zIndex).toBe('1'); // The figure occludes the rear orbit.
        const gap = side === 'right' ? card.left - (x + radius) : x - radius - card.right;
        expect(gap).toBeGreaterThanOrEqual(23.99);
      });
    };
    // One sample per second covers the complete 30s portrait cycle and its continuation.
    advanceFrame(0);
    for (let second = 0; second <= 45; second++) {
      assertClearance();
      if (second < 45) advanceFrame(1000);
    }
    // Back-half focus moves the raised portrait to the front arc, below the face.
    radios.forEach((radio) => {
      const originalAngle = angle(radio);
      act(() => radio.focus());
      expect(angle(radio)).toBe(originalAngle);
      expect(radio.closest<HTMLElement>('.neo-avp-orbit-node')!.style.transform).toContain('scale(1)');
      assertClearance(radio);
    });
  });

  it('remeasures the neighbouring desktop card when its size changes', () => {
    let cardWidth = 320;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-testid')) {
        case 'figure-frame': return rect(304, 96, 480, 672);
        case 'orbit-card': return rect(1280 - 56 - cardWidth, 290, cardWidth, 220);
        default: return rect(0, 0, 1280, 800);
      }
    });
    render(<Harness clearance />);
    const path = document.querySelector('[data-orbit-path="portrait-front"] path')!;
    const radius = () => Number(path.getAttribute('d')!.match(/ A ([\d.]+) /)![1]);
    expect(radius()).toBe(298);
    cardWidth = 380;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(radius()).toBe(238);
  });

  it.each(['animationend', 'animationcancel', 'transitionend', 'transitioncancel'])('remeasures a settled FLIP on %s without reacting to child animations', (eventType) => {
    let frameRect = rect(-38.4, 16, 608, 800);
    let cardRect = rect(563.2, 104, 665.6, 664);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-testid')) {
        case 'figure-frame': return frameRect;
        case 'orbit-card': return cardRect;
        default: return rect(0, 0, 1280, 800);
      }
    });
    const { unmount } = render(<Harness clearance />);
    const frame = screen.getByTestId('figure-frame');
    const card = screen.getByTestId('orbit-card');
    const frameMeasure = vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => frameRect);
    const cardMeasure = vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => cardRect);
    const child = document.createElement('div');
    frame.append(child);
    const path = document.querySelector('[data-orbit-path="portrait-front"] path')!;
    const before = path.getAttribute('d');
    const phase = angle(portraits()[0]!);
    frameRect = rect(304, 96, 480, 672);
    cardRect = rect(904, 290, 320, 220);
    fireEvent(child, new Event(eventType, { bubbles: true }));
    expect(path.getAttribute('d')).toBe(before);
    expect(frameMeasure).not.toHaveBeenCalled();
    fireEvent(frame, new Event(eventType, { bubbles: true }));
    expect(frameMeasure).toHaveBeenCalledOnce();
    expect(cardMeasure).toHaveBeenCalledOnce();
    expect(path.getAttribute('d')).toContain(' A 298 ');
    expect(portraits()[0]!.style.transform).toContain('translate3d(544.00px,');
    expect(angle(portraits()[0]!)).toBe(phase);
    cardRect = rect(844, 290, 380, 220);
    fireEvent(card, new Event(eventType, { bubbles: true }));
    expect(path.getAttribute('d')).toContain(' A 238 ');
    unmount();
    frameMeasure.mockClear();
    cardMeasure.mockClear();
    fireEvent(frame, new Event(eventType, { bubbles: true }));
    fireEvent(card, new Event(eventType, { bubbles: true }));
    expect(frameMeasure).not.toHaveBeenCalled();
    expect(cardMeasure).not.toHaveBeenCalled();
  });

  it('measures the figure rather than a zero-sized portal host', () => {
    vi.stubGlobal('innerWidth', 927);
    vi.stubGlobal('innerHeight', 977);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'figure-frame' ? rect(209, 117, 371, 821) : rect(0, 0, 0, 0);
    });
    render(<Harness />);
    const path = document.querySelector('[data-orbit-path="portrait-front"] path')!;
    expect(path.getAttribute('d')).toContain(' A 306.075 74.2 ');
    expect(portraits()[0]!.style.transform).toContain('translate3d(394.50px, 585.28px,');
    expect(observe).toHaveBeenCalledWith(screen.getByTestId('figure-frame'));
    expect(picker().style.visibility).toBe('');
  });

  it('waits for a nonzero frame and paints it after the resize observation', () => {
    let figure = rect(0, 0, 0, 0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'figure-frame' ? figure : rect(0, 0, 927, 977);
    });
    render(<Harness />);
    expect(picker().style.visibility).toBe('hidden');
    expect(document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d')).toBeNull();
    figure = rect(209, 117, 371, 821);
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(picker().style.visibility).toBe('');
    expect(document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d')).toContain(' A 306.075 74.2 ');
  });

  it('converts an offset phone stage into the portal coordinate space', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-testid')) {
        case 'figure-frame': return rect(86, 90, 204, 306);
        case 'orbit-area': return rect(16, 40, 343, 420);
        default: return rect(0, 0, 375, 812);
      }
    });
    render(<Harness reducedMotion />);
    expect(document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d')).toContain(' 236.88 A ');
    const leftPortrait = portraits()[0]!;
    expect(leftPortrait.style.transform).toContain('translate3d(319.00px, 236.88px,');
  });

  it('remeasures a card-side layout change without restarting the revolving phase', async () => {
    let left = 200;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'figure-frame' ? rect(left, 60, 200, 440) : rect(0, 0, 600, 620);
    });
    render(<Harness />);
    advance(1000);
    const phase = angle(portraits()[0]!);
    const before = document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d');
    left = 120;
    await act(async () => {
      screen.getByTestId('orbit-area').dataset.cardSide = 'left';
      await Promise.resolve();
    });
    advanceFrame(0);
    expect(document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d')).not.toBe(before);
    expect(angle(portraits()[0]!)).toBe(phase);
  });

  it('keeps phone geometry unchanged when given a desktop clearance panel', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      switch (this.getAttribute('data-testid')) {
        case 'figure-frame': return rect(57.6, 136, 204.8, 248);
        case 'orbit-card': return rect(16, 280, 288, 104);
        default: return rect(0, 0, 320, 384);
      }
    });
    const plain = render(<Harness reducedMotion />);
    const positions = portraits().map((radio) => radio.closest<HTMLElement>('.neo-avp-orbit-node')!.style.transform);
    const path = document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d');
    plain.unmount();
    render(<Harness clearance reducedMotion />);
    expect(portraits().map((radio) => radio.closest<HTMLElement>('.neo-avp-orbit-node')!.style.transform)).toEqual(positions);
    expect(document.querySelector('[data-orbit-path="portrait-front"] path')!.getAttribute('d')).toBe(path);
  });

  it('observes the figure frame and cleans up the animation frame and observer on unmount', () => {
    const { unmount } = render(<Harness />);
    expect(resizeCallbacks.length).toBeGreaterThan(0);
    expect(frames.size).toBe(1);
    advance(1000);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();
    advance(3000);
    expect(frames.size).toBe(0);
  });
});
