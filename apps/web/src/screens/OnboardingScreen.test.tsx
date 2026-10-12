/**
 * Avatar-first onboarding: saves the chosen face before moving on, while
 * migrating removed steps and preserving the Settings avatar picker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SETTINGS, deepMerge, type NeoSettingsPatch } from '@neo/protocol';
import { AVATAR_BACKGROUNDS, DEFAULT_AVATAR, I18nProvider, serializeAvatar } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { navigate } from '../router.js';
import { useToasts } from '../state/notifications.js';
import { useSession } from '../state/session.js';

// Vitest stubs CSS imports, including ?raw; inspect the source contract directly.
const onboardingStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
const onboardingStyleRules = Array.from(onboardingStyles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
  selector: match[1]!.trim(),
  declarations: Object.fromEntries(match[2]!.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const colon = item.indexOf(':');
    return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
  })),
}));

function matchingOnboardingStyleRules(element: Element) {
  return onboardingStyleRules.filter(({ selector }) => {
    // Leaf rules include keyframes and browser-only snapshot pseudo-elements.
    // Those cannot match a real orbit element in jsdom.
    try { return element.matches(selector); } catch { return false; }
  });
}

function onboardingStyleValue(element: Element, property: string) {
  return matchingOnboardingStyleRules(element).map(({ declarations }) => declarations[property]).filter((value) => value !== undefined).at(-1);
}

function pointerEvent(target: Element, type: string, pointerType: 'mouse' | 'touch') {
  const event = new Event(type, { bubbles: type === 'pointerdown' });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

// ── module mocks ──────────────────────────────────────────────────────────

const mockUpdate = vi.fn();
vi.mock('../state/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/session.js')>();
  return {
    ...actual,
    updateSettings: (patch: NeoSettingsPatch) => mockUpdate(patch),
    requireClient: () => ({}),
  };
});

vi.mock('../platform/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/index.js')>();
  const platform = {
    kind: 'browser',
    notificationStatus: vi.fn(async () => ({ channel: 'push', permission: 'prompt', enabled: false })),
    enableNotifications: vi.fn(async () => ({ channel: 'push', permission: 'granted', enabled: true })),
  };
  return { ...actual, getPlatform: () => platform };
});

vi.mock('../router.js', () => ({
  navigate: vi.fn(),
  parseRoute: vi.fn(),
  routeToHash: vi.fn().mockReturnValue(''),
}));

// ── helpers ───────────────────────────────────────────────────────────────

async function renderOnboarding(step?: string, locale = 'en') {
  if (step) sessionStorage.setItem(STORAGE_KEYS.onboardingStep, step);
  const { OnboardingScreen } = await import('./OnboardingScreen.js');
  let result: ReturnType<typeof render>;
  await act(async () => { result = render(<I18nProvider locale={locale} messages={appDictionaries}><OnboardingScreen /></I18nProvider>); });
  return result!;
}

async function clickButton(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
  await act(async () => { vi.advanceTimersByTime(700); });
}

function expectProgress(current: number | 'last') {
  const progress = screen.getByRole('progressbar');
  const total = progress.children.length;
  const number = current === 'last' ? total : current;
  expect(total).toBeGreaterThan(0);
  expect(progress.getAttribute('aria-label')).toBe(`Step ${number} of ${total}`);
  expect(progress.getAttribute('aria-valuemin')).toBe('1');
  expect(progress.getAttribute('aria-valuenow')).toBe(String(number));
  expect(progress.getAttribute('aria-valuemax')).toBe(String(total));
  if (document.querySelector('.cyber-avatar-card')) {
    expect(screen.getAllByText(`${String(number).padStart(2, '0')}/${String(total).padStart(2, '0')}`)).toHaveLength(1);
    expect(screen.queryByText(`// STEP ${String(number).padStart(2, '0')}/${String(total).padStart(2, '0')}`)).toBeNull();
    expect(screen.queryByText(`${number}/${total}`)).toBeNull();
  } else {
    expect(screen.getByText(`${number}/${total}`)).toBeTruthy();
    expect(screen.getByText(`// STEP ${String(number).padStart(2, '0')}/${String(total).padStart(2, '0')}`)).toBeTruthy();
  }
  Array.from(progress.children).forEach((segment, index) => {
    expect(segment.getAttribute('data-done')).toBe(String(index < number));
  });
}

function mockReducedMotion(initial = true) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  return (matches: boolean) => act(() => {
    media.matches = matches;
    listeners.forEach((listener) => listener());
  });
}

// ── setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  const { setPosterCardSide } = await import('./OnboardingScreen.js');
  setPosterCardSide('right');
  vi.useFakeTimers();
  sessionStorage.clear();
  useSession.setState({ settings: deepMerge(DEFAULT_SETTINGS, {}), providers: null, models: {}, client: null });
  useToasts.setState({ toasts: [] });
  mockUpdate.mockReset();
  mockUpdate.mockImplementation(async (patch: NeoSettingsPatch) => {
    const settings = deepMerge(useSession.getState().settings!, patch);
    useSession.setState({ settings });
    return settings;
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  // jsdom has no layout. Supply frame/stage measurements so the orbit's real
  // zero-dimension wait does not hide controls in unrelated behaviour tests.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const rect = (left: number, top: number, w: number, h: number) => ({ x: left, y: top, left, top, width: w, height: h, right: left + w, bottom: top + h, toJSON: () => ({}) }) as DOMRect;
    if (this.classList.contains('cyber-stage') || this.classList.contains('cyber-onboarding')) return rect(0, 0, width, height);
    if (this.classList.contains('cyber-figure-frame') || this.classList.contains('cyber-figure-hit')) return rect(width * .36 - 180, 40, 360, Math.max(1, height - 64));
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────

describe('avatar-first onboarding', () => {
  it('starts with the avatar step and first-segment progress on a fresh start', async () => {
    await renderOnboarding();

    const heading = screen.getByRole('heading', { name: 'First, how should I look?' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('radiogroup', { name: 'Character' })).toBeTruthy();
    expectProgress(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh-CN'])('has no background controls on any guide step in %s', async (locale) => {
    for (const step of ['avatar', 'ai', 'notifications', 'done']) {
      const view = await renderOnboarding(step, locale);
      expect(screen.queryByRole('radiogroup', { name: locale === 'en' ? 'Background' : '背景' })).toBeNull();
      expect(view.container.querySelector('.neo-avp-color-choices, .neo-avp-swatches, .neo-avp-custom, .cyber-orbit-colors, [data-orbit="color"], [data-orbit-path^="color"], input[type="color"]')).toBeNull();
      expect(view.container.querySelectorAll('[role="radiogroup"]')).toHaveLength(step === 'avatar' ? 1 : 0);
      expect(view.container.querySelectorAll('[data-orbit="portrait"]')).toHaveLength(step === 'avatar' ? 5 : 0);
      view.unmount();
    }
  });

  it('saves the default background for a fresh user when a character is picked', async () => {
    expect(useSession.getState().settings!.persona.avatar).toBe(DEFAULT_SETTINGS.persona.avatar);
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    await clickButton('Continue');

    const avatar = serializeAvatar({ kind: 'dog', bg: DEFAULT_AVATAR.bg });
    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar } });
    expect(useSession.getState().settings!.persona.avatar).toBe(avatar);
  });

  it('saves only the selected avatar before the AI step', async () => {
    const persona = { avatar: serializeAvatar({ ...DEFAULT_AVATAR, kind: 'girl' }) };
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona } });
    await renderOnboarding();

    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    await clickButton('Continue');

    const avatar = serializeAvatar({ ...DEFAULT_AVATAR, kind: 'cat' });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ persona: { ...persona, avatar } });
    const heading = screen.getByRole('heading', { name: 'Choose your AI' });
    expect(document.activeElement).toBe(heading);
    expect(document.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-kind')).toBe('cat');
    expect(useSession.getState().settings!.persona.avatar).toBe(avatar);
    expectProgress(2);
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBe('ai');
  });

  it('returns from AI to the avatar step with the saved selection', async () => {
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    await clickButton('Continue');
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
    await clickButton('Back');

    expect(screen.getByRole('heading', { name: 'First, how should I look?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dog' }).getAttribute('aria-checked')).toBe('true');
    expectProgress(1);
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBe('avatar');
  });

  it('lets AI setup be skipped without creating a provider', async () => {
    useSession.setState({ providers: { items: [], defaultModel: null } });
    await renderOnboarding('ai');

    expect(screen.queryByRole('button', { name: /Demo mode/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a custom endpoint' })).toBeNull();
    await clickButton('Skip for now');

    expect(screen.getByRole('heading', { name: 'Never miss a reminder' })).toBeTruthy();
    expect(useSession.getState().settings!.defaultModel).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('shows Not connected yet on Done when AI setup was skipped', async () => {
    useSession.setState({ providers: { items: [], defaultModel: null } });
    await renderOnboarding('done');

    expect(screen.getByText('Not connected yet')).toBeTruthy();
    await clickButton('Start chatting');
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
  });

  it('shows the configured fallback AI on Done after skipping AI setup', async () => {
    useSession.setState({ providers: { items: [{ id: 'ollama', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'local-model', hasApiKey: false, isLocal: true }], defaultModel: null } });
    const ai = await renderOnboarding('ai');
    await clickButton('Skip for now');
    expect(useSession.getState().settings!.defaultModel).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    ai.unmount();
    await renderOnboarding('done');

    expect(screen.getByText('Local AI · local-model')).toBeTruthy();
    expect(screen.queryByText('Not connected yet')).toBeNull();
  });

  it.each(['persona', 'memory'])('resumes the removed %s step at notifications and keeps the saved avatar', async (step) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ ...DEFAULT_AVATAR, kind: 'girl' }) } } });
    const { container } = await renderOnboarding(step);

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Never miss a reminder' }));
    expect(screen.queryByRole('radiogroup', { name: 'Character' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expectProgress(3);
    expect(container.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-kind')).toBe('girl');
    await clickButton('Back');
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('skips an unchanged avatar without saving it and finishes setup', async () => {
    await renderOnboarding();
    await clickButton('Skip setup');

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBeNull();
  });

  it('saves a changed avatar before finishing when setup is skipped', async () => {
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Boy' }));
    await clickButton('Skip setup');

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenNthCalledWith(1, { persona: { ...DEFAULT_SETTINGS.persona, avatar: serializeAvatar({ ...DEFAULT_AVATAR, kind: 'boy' }) } });
    expect(mockUpdate).toHaveBeenNthCalledWith(2, { onboarded: true });
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
  });

  it.each(['#DCD0F4', '#345678'])('preserves the saved background %s when a character is picked and setup is skipped', async (bg) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ kind: 'girl', bg }) } } });
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Boy' }));
    await clickButton('Skip setup');

    const avatar = serializeAvatar({ kind: 'boy', bg });
    expect(mockUpdate).toHaveBeenNthCalledWith(1, { persona: { avatar } });
    expect(mockUpdate).toHaveBeenNthCalledWith(2, { onboarded: true });
    expect(useSession.getState().settings!.persona.avatar).toBe(avatar);
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
  });

  it('keeps the avatar selection and shows an error when Continue cannot save', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Avatar could not be saved'));
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    await clickButton('Continue');

    expect(screen.getByRole('heading', { name: 'First, how should I look?' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Cat' }).getAttribute('aria-checked')).toBe('true');
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Avatar could not be saved' })]);
    expect(navigate).not.toHaveBeenCalled();

    await clickButton('Continue');
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
  });

  it('does not finish setup when saving a changed avatar during Skip setup fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Avatar could not be saved'));
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    await clickButton('Skip setup');

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'First, how should I look?' })).toBeTruthy();
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Avatar could not be saved' })]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('resumes a saved welcome step at AI and offers Back to choose an avatar', async () => {
    await renderOnboarding('welcome');

    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
    expectProgress(2);
    await clickButton('Back');
    expect(screen.getByRole('heading', { name: 'First, how should I look?' })).toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('falls back to the avatar step for a saved step name that is no longer valid', async () => {
    await renderOnboarding('old-step');

    expect(screen.getByRole('heading', { name: 'First, how should I look?' })).toBeTruthy();
    expectProgress(1);
  });
});

describe('print onboarding', () => {
  it('lets rear portraits overlapping the figure win the pointer/stacking contract', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const stage = container.querySelector<HTMLElement>('.cyber-stage')!;
    const hit = container.querySelector<HTMLElement>('.cyber-figure-hit')!;
    const frame = container.querySelector<HTMLElement>('.cyber-figure-frame')!;
    const figure = frame.querySelector<HTMLElement>('.cyber-figure')!;
    const pauseArea = container.querySelector<HTMLElement>('.neo-avp-orbit-area')!;
    const orbit = container.querySelector<HTMLElement>('.neo-avp--orbit')!;
    expect(hit.parentElement).toBe(stage);
    expect(hit.children).toHaveLength(0);
    expect(hit.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(hit.hasAttribute('tabindex')).toBe(false);
    expect(onboardingStyleValue(stage, 'pointer-events')).toBe('none');
    expect(onboardingStyleValue(hit, 'pointer-events')).toBe('auto');
    expect(onboardingStyleValue(hit, 'z-index')).toBe('0');
    expect(onboardingStyleValue(pauseArea, 'z-index')).toBe('-1');
    expect(getComputedStyle(pauseArea).pointerEvents).toBe('auto');
    expect(onboardingStyleValue(frame, 'z-index')).toBe('2');
    expect(onboardingStyleValue(frame, 'pointer-events')).toBe('none');
    expect(onboardingStyleValue(figure, 'pointer-events')).toBe('none');
    expect(onboardingStyleValue(orbit, 'pointer-events')).toBe('none');
    for (const property of ['z-index', 'transform', 'opacity', 'isolation']) {
      expect(onboardingStyleValue(orbit, property)).toBeUndefined();
    }
    for (const wrapper of container.querySelectorAll('.cyber-orbit-host, .cyber-orbit-host > form, .cyber-orbit, .cyber-orbit-characters')) {
      expect(onboardingStyleValue(wrapper, 'display')).toBe('contents');
    }

    // jsdom cannot implement elementFromPoint: establish the real overlapping
    // positions, pointer contracts and click behavior without faking a hit test.
    const bounds = frame.getBoundingClientRect();
    const targets = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-orbit="portrait"][data-orbit-depth="back"]')).filter((node) => {
      const position = node.style.transform.match(/^translate3d\(([-\d.]+)px, ([-\d.]+)px/)!;
      return Number(position[1]) >= bounds.left && Number(position[1]) <= bounds.right
        && Number(position[2]) >= bounds.top && Number(position[2]) <= bounds.bottom;
    });
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toBeTruthy();
      expect(target.dataset.orbitDepth).toBe('back');
      expect(target.style.zIndex).toBe('1');
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      expect(target.style.opacity).toBe('0.6');
      expect(target.style.transform).toContain('scale(0.8)');
      pointerEvent(target, 'pointerdown', 'mouse');
      fireEvent.click(target);
      expect(target.getAttribute('aria-checked')).toBe('true');
    }
    expect(figure.dataset.kind).toBe(targets.at(-1)!.getAttribute('aria-label')!.toLowerCase());
    expect(mockUpdate).not.toHaveBeenCalled();
    container.querySelectorAll<HTMLElement>('.neo-avp-orbit-node[data-orbit-depth="front"]').forEach((node) => expect(node.style.zIndex).toBe('3'));
  });

  it('shares the hit box geometry with the figure across base, mobile and poster-side rules', async () => {
    const { container } = await renderOnboarding();
    const hit = container.querySelector<HTMLElement>('.cyber-figure-hit')!;
    const frame = container.querySelector<HTMLElement>('.cyber-figure-frame')!;
    const geometry = ['position', 'left', 'right', 'bottom', 'width', 'height', 'max-width', 'aspect-ratio', 'translate'];
    const rules = (element: Element) => matchingOnboardingStyleRules(element).filter(({ declarations }) => geometry.some((property) => declarations[property] !== undefined));
    expect(rules(hit)).toEqual(rules(frame));
    expect(rules(hit).some(({ declarations }) => declarations.height === 'var(--neo-figure-height)')).toBe(true);
    expect(rules(hit).some(({ declarations }) => declarations['aspect-ratio'] === '32 / 41')).toBe(true);
    expect(rules(hit).some(({ declarations }) => declarations.left === 'var(--poster-figure-center)')).toBe(true);
    expect(onboardingStyleValue(hit, 'view-transition-name')).toBeUndefined();
  });

  it.each(['hover', 'tap'] as const)('triggers a loaded figure burst from hit-layer %s and pauses the orbit', async (interaction) => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const stage = container.querySelector<HTMLElement>('.cyber-stage')!;
    const hit = container.querySelector<HTMLElement>('.cyber-figure-hit')!;
    const figure = container.querySelector<HTMLElement>('.cyber-figure')!;
    const orbit = container.querySelector<HTMLElement>('.neo-avp--orbit')!;
    fireEvent.load(figure.querySelector('img:not([aria-hidden="true"])')!);
    fireEvent.load(figure.querySelector('img[aria-hidden="true"]')!);
    expect(figure.hasAttribute('data-glitch')).toBe(false);
    expect(orbit.dataset.orbitPaused).toBe('false');
    if (interaction === 'hover') {
      // Browsers send pointerenter to the stage as the pointer enters its hit child.
      pointerEvent(stage, 'pointerenter', 'mouse');
      fireEvent.mouseEnter(hit);
    } else pointerEvent(hit, 'pointerdown', 'touch');
    expect(figure.dataset.glitch).toBe('true');
    expect(orbit.dataset.orbitPaused).toBe('true');
    act(() => vi.advanceTimersByTime(480));
    expect(figure.hasAttribute('data-glitch')).toBe(false);
    if (interaction === 'hover') pointerEvent(stage, 'pointerleave', 'mouse');
    else {
      act(() => vi.advanceTimersByTime(3519));
      expect(orbit.dataset.orbitPaused).toBe('true');
      act(() => vi.advanceTimersByTime(1));
    }
    expect(orbit.dataset.orbitPaused).toBe('false');
  });

  it('selects a rear portrait by touch without sending the tap to the figure hit layer', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const target = container.querySelector<HTMLButtonElement>('button[data-orbit="portrait"][data-orbit-depth="back"]')!;
    const figure = container.querySelector<HTMLElement>('.cyber-figure')!;
    fireEvent.load(figure.querySelector('img:not([aria-hidden="true"])')!);
    fireEvent.load(figure.querySelector('img[aria-hidden="true"]')!);
    pointerEvent(target, 'pointerdown', 'touch');
    fireEvent.click(target);
    expect(target.getAttribute('aria-checked')).toBe('true');
    expect(figure.hasAttribute('data-glitch')).toBe(false);
    expect(container.querySelector<HTMLElement>('.neo-avp--orbit')!.dataset.orbitPaused).toBe('true');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('places the character choices outside the card before its actions with shared form submission', async () => {
    const { container } = await renderOnboarding();
    const characters = screen.getByRole('radiogroup', { name: 'Character' });
    const skip = screen.getByRole('button', { name: 'Skip setup' });
    const proceed = screen.getByRole('button', { name: 'Continue' });
    const form = proceed.closest('form')!;
    const card = container.querySelector<HTMLElement>('.cyber-card')!;

    expect(form).toBeTruthy();
    const orbitForm = characters.closest('form')!;
    expect(orbitForm).not.toBe(form);
    expect(orbitForm.closest('.cyber-orbit-host')).toBeTruthy();
    expect(skip.closest('form')).toBe(form);
    expect(proceed.getAttribute('type')).toBe('submit');
    expect(card.querySelector('.neo-avp, [role="radiogroup"]')).toBeNull();
    expect(card.contains(screen.getByRole('heading', { name: 'First, how should I look?' }))).toBe(true);
    expect(container.querySelector('.neo-avp--orbit')).toBeTruthy();
    expect(within(characters).getAllByRole('radio')).toHaveLength(5);
    expect(Array.from(container.querySelectorAll<HTMLElement>('button, input')).filter((control) => control.tabIndex === 0)).toEqual([
      screen.getByRole('radio', { name: 'Robot' }),
      proceed,
      skip,
    ]);
  });

  it('navigates character circles with arrows, Home and End and moves the single tab stop', async () => {
    const { container } = await renderOnboarding();
    const characters = screen.getByRole('radiogroup', { name: 'Character' });
    const checkSelected = (name: string, kind: string) => {
      const selected = within(characters).getByRole('radio', { name });
      expect(document.activeElement).toBe(selected);
      within(characters).getAllByRole('radio').forEach((radio) => {
        expect(radio.getAttribute('aria-checked')).toBe(String(radio === selected));
        expect((radio as HTMLElement).tabIndex).toBe(radio === selected ? 0 : -1);
      });
      expect(container.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-kind')).toBe(kind);
    };
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    screen.getByRole('radio', { name: 'Robot' }).focus();

    press('ArrowRight');
    checkSelected('Cat', 'cat');
    press('ArrowDown');
    checkSelected('Dog', 'dog');
    press('ArrowLeft');
    checkSelected('Cat', 'cat');
    press('Home');
    checkSelected('Robot', 'robot');
    press('ArrowUp');
    checkSelected('Girl', 'girl');
    press('Home');
    checkSelected('Robot', 'robot');
    press('End');
    checkSelected('Girl', 'girl');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('uses unlabelled circular choices and keeps the split orbit paths decorative', async () => {
    const { container } = await renderOnboarding();
    const characters = screen.getByRole('radiogroup', { name: 'Character' });
    const cat = within(characters).getByRole('radio', { name: 'Cat' });
    fireEvent.click(cat);

    expect(cat.getAttribute('aria-checked')).toBe('true');
    within(characters).getAllByRole('radio').forEach((radio) => {
      expect(radio.getAttribute('data-orbit')).toBe('portrait');
      expect(radio.getAttribute('data-orbit-shape')).toBe('circle');
      expect(radio.getAttribute('title')).toBe(radio.getAttribute('aria-label'));
      expect(radio.textContent).toBe('');
      expect(radio.querySelector('.neo-av--circle')).toBeTruthy();
      expect(radio.querySelector('.neo-av')!.getAttribute('aria-hidden')).toBe('true');
    });
    expect(container.querySelector('.neo-avp-orbit-index, .neo-avp-orbit-trace, .cyber-orbit-swatch-stack')).toBeNull();
    const paths = container.querySelectorAll('[data-orbit-path]');
    expect(paths).toHaveLength(2);
    expect(Array.from(paths, (path) => path.getAttribute('data-orbit-path'))).toEqual(['portrait-back', 'portrait-front']);
    paths.forEach((path) => expect(path.closest('[aria-hidden="true"]')).toBeTruthy());
  });

  it('keeps the avatar card compact with one counter, a short lead and a quiet Skip action', async () => {
    const { container } = await renderOnboarding();
    const card = container.querySelector('.cyber-avatar-card')!;
    expect(card).toBeTruthy();
    expect(card.querySelector('.print-heading-tabs, .onboarding__footer')).toBeNull();
    expect(card.querySelector('.print-terminal-line')!.parentElement!.hidden).toBe(true);
    expect(card.querySelector('.print-card-tabs')!.parentElement!.hidden).toBe(true);
    expect(card.querySelectorAll('.cyber-step-count')).toHaveLength(1);
    expect(card.querySelector('.cyber-step-count')!.textContent).toBe('01/04');
    expect(within(card as HTMLElement).getByText('You can change it any time in Settings.')).toBeTruthy();
    expect(within(card as HTMLElement).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    const skip = within(card as HTMLElement).getByRole('button', { name: 'Skip setup' });
    expect(skip.classList.contains('cyber-avatar-skip')).toBe(true);
    expect(skip.classList.contains('cyber-button')).toBe(false);
    expect(within(card as HTMLElement).getByRole('button', { name: 'Continue' }).getAttribute('type')).toBe('submit');
  });

  it('uses the short Chinese lead and retains accessible avatar choices', async () => {
    await renderOnboarding(undefined, 'zh-CN');
    expect(screen.getByText('之后随时可以在设置里更换。')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '先给我选个样子吧' }));
    expect(screen.getByRole('radiogroup', { name: '角色' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '机器人' }).textContent).toBe('');
    expect(screen.getByRole('radio', { name: '机器人' }).getAttribute('title')).toBe('机器人');
  });

  it.each([
    ['preset', '#DCD0F4'],
    ['custom', '#345678'],
  ] as const)('preserves the saved %s background on every portrait and with Continue', async (_choice, bg) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ kind: 'girl', bg }) } } });
    const { container } = await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));

    expect(screen.getByRole('radio', { name: 'Dog' }).getAttribute('aria-checked')).toBe('true');
    container.querySelectorAll('.cyber-orbit-characters .neo-av').forEach((portrait) => {
      expect(portrait.querySelector('rect')!.getAttribute('fill')).toBe(bg);
    });
    expect(container.querySelectorAll('.cyber-orbit-characters .neo-av')).toHaveLength(5);
    expect(mockUpdate).not.toHaveBeenCalled();
    await clickButton('Continue');

    const avatar = serializeAvatar({ kind: 'dog', bg });
    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar } });
    expect(useSession.getState().settings!.persona.avatar).toBe(avatar);
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
  });

  it('submits the chosen character with the previous background through the avatar form', async () => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ kind: 'cat', bg: '#D8EFDC' }) } } });
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Girl' }));
    const form = screen.getByRole('button', { name: 'Continue' }).closest('form')!;

    await act(async () => { fireEvent.submit(form); });
    await act(async () => { vi.advanceTimersByTime(700); });

    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar: serializeAvatar({ kind: 'girl', bg: '#D8EFDC' }) } });
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
  });

  it('submits on Enter from the focused character with the previous background', async () => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ kind: 'girl', bg: '#345678' }) } } });
    await renderOnboarding();
    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    const radio = screen.getByRole('radio', { name: 'Cat' });
    radio.focus();

    await act(async () => { fireEvent.keyDown(radio, { key: 'Enter' }); });
    await act(async () => { vi.advanceTimersByTime(700); });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar: serializeAvatar({ kind: 'cat', bg: '#345678' }) } });
    expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
  });

  it('replaces decorative icon pills on the avatar step and keeps them on Done', async () => {
    const avatar = await renderOnboarding();
    expect(avatar.container.querySelectorAll('.print-pill')).toHaveLength(3);
    expect(avatar.container.querySelector('.print-badges')!.getAttribute('data-visible')).toBe('false');
    avatar.unmount();

    const done = await renderOnboarding('done');
    expect(done.container.querySelector('.print-badges')!.getAttribute('data-visible')).toBe('true');
    const pills = done.container.querySelectorAll('.print-pill');
    expect(pills).toHaveLength(3);
    pills.forEach((pill) => expect(pill.closest('[aria-hidden="true"]')).toBeTruthy());
  });

  it('changes the colour figure live without saving the avatar', async () => {
    const savedAvatar = useSession.getState().settings!.persona.avatar;
    const { container } = await renderOnboarding();
    const checkFigure = (kind: string) => {
      const figure = container.querySelector<HTMLElement>('.cyber-stage .neo-avfig')!;
      expect(figure.getAttribute('data-kind')).toBe(kind);
      expect(figure.getAttribute('data-variant')).toBe('glitch');
      expect(figure.querySelector('img')!.getAttribute('src')).toMatch(new RegExp(`/avatar-figures/${kind}\\.webp$`));
    };

    checkFigure('robot');
    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    checkFigure('cat');
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    checkFigure('dog');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(useSession.getState().settings!.persona.avatar).toBe(savedAvatar);
  });

  it('keeps the stage mounted and bursts after the new character layers load', async () => {
    mockReducedMotion(false);
    vi.useFakeTimers();
    try {
      const { container } = await renderOnboarding();
      const frame = container.querySelector('.cyber-figure-frame')!;
      const figure = frame.querySelector('.neo-avfig')!;
      const loadLayers = () => {
        fireEvent.load(figure.querySelector('img:not([aria-hidden="true"])')!);
        fireEvent.load(figure.querySelector('img[aria-hidden="true"]')!);
      };
      loadLayers();
      expect(figure.hasAttribute('data-glitch')).toBe(false);

      fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
      expect(container.querySelector('.cyber-figure-frame')).toBe(frame);
      expect(frame.querySelector('.neo-avfig')).toBe(figure);
      expect(figure.getAttribute('data-kind')).toBe('cat');
      expect(figure.hasAttribute('data-glitch')).toBe(false);
      loadLayers();
      expect(figure.hasAttribute('data-glitch')).toBe(true);
      act(() => vi.advanceTimersByTime(600));
      expect(figure.hasAttribute('data-glitch')).toBe(false);
      expect(figure.querySelector('img:not([aria-hidden="true"])')!.getAttribute('src')).toMatch(/\/avatar-figures\/cat\.webp$/);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each([
    ['avatar', 1, 'First, how should I look?'],
    ['done', 'last', 'NEO is ready'],
  ] as const)('renders %s as a full colour character poster with accessible progress', async (step, number, title) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, avatar: serializeAvatar({ ...DEFAULT_AVATAR, kind: 'girl' }) } } });
    const { container } = await renderOnboarding(step);

    expect(container.querySelector('.cyber-onboarding--poster')!.getAttribute('data-card-side')).toBe('right');
    expect(container.querySelector('.print-backdrop--compact')).toBeNull();
    expect(container.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-kind')).toBe('girl');
    expect(container.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-variant')).toBe('glitch');
    expect(container.querySelector('.cyber-wordmark')!.textContent).toBe('NEO');
    expect(container.querySelector('.cyber-wordmark--small')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: title }));
    expectProgress(number);
  });

  it.each(['avatar', 'done'])('switches the %s poster composition to the left with one module switch', async (step) => {
    const { POSTER_CARD_SIDE, setPosterCardSide } = await import('./OnboardingScreen.js');
    expect(POSTER_CARD_SIDE).toBe('right');
    setPosterCardSide('left');
    const { container } = await renderOnboarding(step);
    expect(container.querySelector('.cyber-onboarding--poster')!.getAttribute('data-card-side')).toBe('left');
  });

  it.each(['avatar', 'done'])('keeps the phone %s bottom-sheet contract when the poster side changes', async (step) => {
    vi.stubGlobal('innerWidth', 390);
    const right = await renderOnboarding(step);
    const rootClass = right.container.querySelector('.cyber-onboarding')!.className;
    const cardClass = right.container.querySelector('.cyber-card')!.className;
    expect(rootClass).toContain('cyber-onboarding--poster');
    expect(right.container.querySelector('.cyber-onboarding')!.getAttribute('data-card-side')).toBe('right');
    right.unmount();

    const { setPosterCardSide } = await import('./OnboardingScreen.js');
    setPosterCardSide('left');
    const left = await renderOnboarding(step);
    expect(left.container.querySelector('.cyber-onboarding')!.className).toBe(rootClass);
    expect(left.container.querySelector('.cyber-card')!.className).toBe(cardClass);
    expect(left.container.querySelector('.cyber-onboarding')!.getAttribute('data-card-side')).toBe('left');
    const sheetRule = onboardingStyles.match(/\.cyber-card, \.cyber-onboarding--content \.cyber-card\s*\{[^}]*\}/)?.[0];
    expect(sheetRule).toContain('position: relative');
    expect(sheetRule).toContain('grid-area: 2 / 1');
    expect(sheetRule).toContain('inset: auto');
    expect(sheetRule).toContain('background: var(--print-charcoal)');
    expect(sheetRule).toContain('max-height: calc(60dvh');

  });

  it.each([
    ['avatar', 'First, how should I look?'],
    ['ai', 'Choose your AI'],
    ['notifications', 'Never miss a reminder'],
    ['done', 'NEO is ready'],
  ])('focuses the %s heading without an outline, shadow or border', async (step, title) => {
    const focusRule = onboardingStyles.match(/\.cyber-onboarding \.onboarding__title\[tabindex='-1'\]:focus\s*\{[^}]*\}/)?.[0];
    expect(focusRule).toBeTruthy();
    const style = document.createElement('style');
    style.textContent = focusRule!;
    document.head.append(style);
    try {
      await renderOnboarding(step);
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(heading);
      const focused = getComputedStyle(heading);
      expect(focused.outline).toBe('none');
      expect(focused.boxShadow).toBe('none');
      expect(focused.borderWidth).toBe('0px');
    } finally {
      style.remove();
    }
  });

  it('keeps the bone keyboard ring scoped to interactive focus-visible controls', () => {
    const ringRule = onboardingStyles.split('\n').find((line) => line.includes(':is(button, input, select, textarea, a[href],') && line.includes(':focus-visible'));
    expect(ringRule).toBeTruthy();
    expect(ringRule).toContain("[role='radio']");
    expect(ringRule).not.toContain('.neo-avp-custom');
    expect(ringRule).toContain('outline: 2px solid var(--print-bone) !important');
    expect(ringRule).toContain('outline-offset: 3px');
    expect(ringRule).toContain('box-shadow: none');
    expect(ringRule).not.toContain(')) :focus-visible');
    expect(ringRule).not.toContain(':focus-within');
  });

  it.each([
    ['ai', 2, 'Choose your AI'],
    ['notifications', 3, 'Never miss a reminder'],
  ] as const)('renders %s with the full print stage and preserves progress and focus', async (step, number, title) => {
    const { container } = await renderOnboarding(step);
    if (step === 'notifications') expect(screen.getByRole('button', { name: 'Turn on notifications' })).toBeTruthy();

    expect(container.querySelector('.cyber-onboarding--content')).toBeTruthy();
    expect(container.querySelector('.print-backdrop--compact')).toBeNull();
    expect(container.querySelector('.cyber-stage .neo-avfig')!.getAttribute('data-variant')).toBe('glitch');
    expect(container.querySelector('.cyber-wordmark')!.textContent).toBe('NEO');
    expect(container.querySelector('.cyber-wordmark--small')).toBeNull();
    expect(container.querySelector('.cyber-step-heading .neo-av')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: title }));
    expectProgress(number);
  });

  it('keeps the graphic kit decorative and outside the accessible content', async () => {
    const { container } = await renderOnboarding();
    const decorations = container.querySelectorAll('.print-backdrop, .cyber-wordmark, .cyber-hud, .print-ring-gauge, .print-tabs, .print-hazards, .print-traces, .print-badges, .print-pill, .print-shield');
    expect(decorations.length).toBeGreaterThan(0);
    expect(container.querySelector('.print-backdrop')).toBeTruthy();
    expect(container.querySelector('.print-ring-gauge')).toBeTruthy();
    decorations.forEach((decoration) => {
      expect(decoration.closest('[aria-hidden="true"]')).toBeTruthy();
    });
    expect(screen.queryByRole('img', { name: /NEO.*PERSONAL AI/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'First, how should I look?' }).closest('[aria-hidden="true"]')).toBeNull();
  });

  it.each([
    ['ai', 'connect your ai_'],
    ['notifications', 'set your signals_'],
    ['done', 'neo is online_'],
  ] as const)('shows the complete %s terminal line immediately with reduced motion', async (step, text) => {
    mockReducedMotion();
    const { container } = await renderOnboarding(step);
    const terminal = container.querySelector('.print-terminal-line')!;

    expect(terminal.getAttribute('data-motion')).toBe('off');
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe(text);
    expect(container.querySelector('.print-terminal-cursor')).toBeTruthy();
    expect(terminal.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByText(text, { selector: '.print-terminal-accessible' })).toBeTruthy();
  });

  it('backspaces and types the next terminal line while keeping accessible text complete', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding('ai');
    const visible = container.querySelector('.print-terminal-text')!;
    const accessible = container.querySelector('.print-terminal-accessible')!;
    expect(visible.textContent).toBe('connect your ai_');
    expect(visible.getAttribute('aria-hidden')).toBe('true');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip for now' })); });
    expect(accessible.textContent).toBe('set your signals_');
    act(() => vi.advanceTimersByTime(45));
    expect(visible.textContent!.length).toBeLessThan('connect your ai_'.length);
    act(() => vi.advanceTimersByTime(60));
    expect(visible.textContent).not.toBe('set your signals_');
    act(() => vi.advanceTimersByTime(500));
    expect(visible.textContent).toBe('set your signals_');
    expect(accessible.textContent).toBe('set your signals_');
  });

  it('disables wordmark, ring, orbit and figure motion and follows live reduced-motion changes', async () => {
    const setReducedMotion = mockReducedMotion();
    const { container } = await renderOnboarding();
    const stage = container.querySelector('.cyber-onboarding')!;
    const wordmark = container.querySelector('.cyber-wordmark')!;
    const ring = container.querySelector('.print-ring-gauge')!;
    const orbit = container.querySelector('.neo-avp--orbit')!;

    expect(stage.getAttribute('data-motion')).toBe('off');
    expect(wordmark.getAttribute('data-motion')).toBe('off');
    expect(ring.getAttribute('data-motion')).toBe('off');
    expect(container.querySelector('.cyber-wordmark--animated')).toBeNull();
    expect(container.querySelector('.print-terminal-line')!.parentElement!.hidden).toBe(true);
    expect(orbit.getAttribute('data-orbit-paused')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    const figure = container.querySelector('.cyber-stage .neo-avfig')!;
    const hit = container.querySelector('.cyber-figure-hit')!;
    expect(figure.getAttribute('data-kind')).toBe('cat');
    fireEvent.load(figure.querySelector('img:not([aria-hidden="true"])')!);
    const ink = figure.querySelector('img[aria-hidden="true"]');
    if (ink) fireEvent.load(ink);
    fireEvent.mouseEnter(hit);
    expect(figure.hasAttribute('data-glitch')).toBe(false);

    setReducedMotion(false);
    expect(stage.getAttribute('data-motion')).toBe('on');
    expect(wordmark.getAttribute('data-motion')).toBe('on');
    expect(ring.getAttribute('data-motion')).toBe('on');
    expect(orbit.getAttribute('data-orbit-paused')).toBe('false');
    expect(container.querySelector('.cyber-wordmark--animated')).toBeTruthy();
    fireEvent.load(figure.querySelector('img[aria-hidden="true"]')!);
    fireEvent.mouseEnter(hit);
    expect(figure.hasAttribute('data-glitch')).toBe(true);

    setReducedMotion(true);
    expect(figure.hasAttribute('data-glitch')).toBe(false);
    fireEvent.pointerDown(hit);
    expect(figure.hasAttribute('data-glitch')).toBe(false);
    expect(orbit.getAttribute('data-orbit-paused')).toBe('true');
    expect(container.querySelector('.cyber-wordmark--animated')).toBeNull();
  });

  it('completes every step without persona inputs or persona summary rows', async () => {
    useSession.setState({ providers: { items: [], defaultModel: null } });
    await renderOnboarding();
    await clickButton('Continue');
    await clickButton('Skip for now');
    await clickButton('Skip for now');

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'NEO is ready' }));
    expectProgress('last');
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBe('done');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Persona')).toBeNull();
    expect(screen.queryByText('Memory')).toBeNull();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await clickButton('Start chatting');
    expect(mockUpdate).toHaveBeenLastCalledWith({ onboarded: true });
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
  });
});

describe('viewport and panel contracts', () => {
  const viewports = [[927, 977], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [375, 812]];
  it.each(viewports)('keeps every step inside the %i×%i viewport contract', async (width, height) => {
    vi.stubGlobal('innerWidth', width);
    vi.stubGlobal('innerHeight', height);
    const rootRule = onboardingStyles.match(/\.cyber-onboarding\s*\{[^}]*width: 100vw[^}]*\}/)?.[0];
    expect(rootRule).toContain('height: 100vh;');
    expect(rootRule).toContain('height: 100dvh;');
    expect(rootRule).toContain('min-height: 0;');
    expect(rootRule).toContain('overflow: hidden;');
    expect(onboardingStyles).toContain('html:has(.cyber-onboarding), body:has(.cyber-onboarding), #root:has(.cyber-onboarding)');
    expect(onboardingStyles).not.toContain('overflow-y: auto; overscroll-behavior: contain; }');
    const figureRule = onboardingStyles.match(/\.cyber-figure-frame\s*\{[^}]*\}/)?.[0];
    expect(figureRule).toContain('height: var(--neo-figure-height)');
    expect(onboardingStyles).toContain('--neo-figure-max-height: min(94dvh, calc(100dvh');
    const wordmarkRule = onboardingStyles.match(/\.cyber-wordmark\s*\{[^}]*\}/)?.[0];
    expect(wordmarkRule).toContain('top: 50%');
    expect(wordmarkRule).toContain('translate: 0 -50%');
    expect(wordmarkRule).toContain('clamp(5rem, min(56vw, 94dvh), 80rem)');
    for (const step of ['avatar', 'ai', 'notifications', 'done']) {
      const view = await renderOnboarding(step);
      expect(view.container.querySelector('.cyber-onboarding')!.getAttribute('data-window-anchor')).toBe('bottom-right');
      expect(view.container.querySelector('.cyber-card')!.getAttribute('data-window-anchor')).toBe('bottom-right');
      expect(view.container.querySelector('.cyber-wordmark')!.getAttribute('data-glyph-anchor')).toBe('center');
      view.unmount();
    }
  });

  it.each(['ai', 'notifications'])('uses translucent unblurred charcoal only on the %s content window', async (step) => {
    const { container } = await renderOnboarding(step);
    expect(container.querySelector('.cyber-card')!.classList.contains('cyber-card--translucent')).toBe(true);
    const rule = onboardingStyles.match(/\.cyber-card--translucent\s*\{[^}]*\}/)?.[0];
    expect(rule).toContain('background: rgba(28, 28, 28, 0.86)');
    expect(rule).toContain('backdrop-filter: none');
    const contentRule = onboardingStyles.match(/\.cyber-onboarding--content \.cyber-card\s*\{[^}]*\}/)?.[0];
    expect(contentRule).toContain('height: min(86dvh');
    const cardRule = onboardingStyles.match(/\.cyber-card\s*\{[^}]*bottom: var[^}]*\}/)?.[0];
    expect(cardRule).toContain('bottom: var(--neo-window-bottom)');
    expect(cardRule).toContain('right: var(--neo-window-right)');
    expect(cardRule).toContain('left: auto');
    expect(onboardingStyles).toMatch(/\.cyber-card \.onboarding__body\s*\{[^}]*overflow-y: auto/);
  });

  it.each(['avatar', 'done'])('keeps %s poster windows opaque and bottom anchored', async (step) => {
    const { container } = await renderOnboarding(step);
    expect(container.querySelector('.cyber-card--translucent')).toBeNull();
    expect(onboardingStyles).toMatch(/\.cyber-onboarding--poster\[data-card-side\] \.cyber-card\s*\{[^}]*top: auto; bottom: var\(--neo-window-bottom\)/);
    expect(onboardingStyles).toMatch(/\.cyber-card\s*\{[^}]*background: var\(--print-charcoal\)/);
  });

  it('keeps lead and help copy above AA contrast even over the brightest underlying outline', () => {
    expect(onboardingStyles).toMatch(/\.cyber-card \.onboarding__lead\s*\{[^}]*color: var\(--print-muted\)/);
    expect(onboardingStyles).toContain('.cyber-card .neo-help { color: var(--print-muted); }');
    const hex = (token: string) => {
      const value = onboardingStyles.match(new RegExp(`--${token}: #([0-9A-Fa-f]{6})`))![1]!;
      return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    };
    const luminance = (rgb: number[]) => rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const alpha = Number(onboardingStyles.match(/background: rgba\(28, 28, 28, (0\.\d+)\)/)![1]);
    const foreground = luminance(hex('print-muted'));
    for (const beneath of [hex('print-bone'), [255, 255, 255]]) {
      const background = luminance(beneath.map((v) => 28 * alpha + v * (1 - alpha)));
      expect((foreground + .05) / (background + .05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('connected onboarding transitions', () => {
  it('moves the invisible hit box with the figure during fallback transitions and cleans up both', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const hit = container.querySelector<HTMLElement>('.cyber-figure-hit')!;
    const frame = container.querySelector<HTMLElement>('.cyber-figure-frame')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(hit.classList.contains('cyber-flip')).toBe(true);
    expect(frame.classList.contains('cyber-flip')).toBe(true);
    for (const part of ['x', 'y', 'scale-x', 'scale-y', 'origin']) {
      expect(hit.style.getPropertyValue(`--neo-flip-${part}`)).toBe(frame.style.getPropertyValue(`--neo-flip-${part}`));
    }
    act(() => vi.advanceTimersByTime(560));
    expect(hit.classList.contains('cyber-flip')).toBe(false);
    expect(hit.style.getPropertyValue('--neo-flip-x')).toBe('');
    expect(frame.classList.contains('cyber-flip')).toBe(false);
  });

  it.each(['entry', 'exit'] as const)('keeps every positioned orbit node free of CSS motion during %s', async (phase) => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding(phase === 'entry' ? 'ai' : 'avatar');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: phase === 'entry' ? 'Back' : 'Continue' })); });
    const host = container.querySelector(phase === 'entry' ? '.cyber-orbit-host' : '.cyber-orbit-exit')!;
    expect(host).toBeTruthy();
    const nodes = host.querySelectorAll('.neo-avp-orbit-node, [data-orbit]');
    expect(nodes).toHaveLength(5);
    expect(host.querySelector('[data-orbit="color"], [data-orbit-path^="color"], input[type="color"]')).toBeNull();

    nodes.forEach((node) => {
      const rules = matchingOnboardingStyleRules(node);
      expect(rules.some(({ declarations }) => declarations.transition === 'none' && declarations.animation === 'none')).toBe(true);
      rules.forEach(({ selector, declarations }) => {
        // rAF changes all three properties, so even a zero-duration delayed
        // transition can hold every nonzero-index choice at its old position.
        for (const property of ['transition', 'transition-property']) {
          expect(declarations[property] ?? '', selector).not.toMatch(/(?:^|[,\s])(all|transform|opacity|z-index)(?:[,\s]|$)/);
        }
        expect(declarations['transition-delay'] ?? '0ms', selector).toMatch(/^0(?:ms|s)$/);
        expect(declarations['animation-delay'] ?? '0ms', selector).toMatch(/^0(?:ms|s)$/);
        expect(declarations['animation-name'] ?? 'none', selector).toBe('none');
        expect(declarations.animation ?? 'none', selector).toMatch(/^none(?:\s*!important)?$/);
      });
    });
  });

  it.each(['entry', 'exit'] as const)('stagger-animates only the inner portrait visuals during %s', async (phase) => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding(phase === 'entry' ? 'ai' : 'avatar');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: phase === 'entry' ? 'Back' : 'Continue' })); });
    const host = container.querySelector(phase === 'entry' ? '.cyber-orbit-host' : '.cyber-orbit-exit')!;
    const nodes = host.querySelectorAll<HTMLElement>('.neo-avp-orbit-node');
    expect(nodes).toHaveLength(5);

    nodes.forEach((node) => {
      const visual = node.querySelector<HTMLElement>(':scope > .neo-avp-orbit-visual')!;
      expect(visual).toBeTruthy();
      expect(visual.style.getPropertyValue('--neo-avp-orbit-stagger')).toBe(`${Number(node.dataset.orbitIndex) * 40}ms`);
      expect(node.style.getPropertyValue('--neo-avp-orbit-stagger')).toBe('');
      const rules = matchingOnboardingStyleRules(visual);
      expect(rules.some(({ declarations }) => declarations['animation-name'] === `neo-badge-${phase === 'entry' ? 'in' : 'out'}`)).toBe(true);
      expect(rules.some(({ declarations }) => declarations['animation-delay'] === 'var(--neo-avp-orbit-stagger, 0ms)')).toBe(true);
      rules.forEach(({ selector, declarations }) => {
        expect(declarations['transition-delay'] ?? '0ms', selector).toMatch(/^0(?:ms|s)$/);
      });
    });
    expect(onboardingStyles).toContain('@keyframes neo-badge-in { from { opacity: 0; scale: .75; } to { opacity: 1; scale: 1; } }');
    expect(onboardingStyles).toContain('@keyframes neo-badge-out { to { opacity: 0; scale: .75; } }');
  });

  it.each([
    ['right', 'avatar', 'Continue', 'ai'],
    ['left', 'avatar', 'Continue', 'ai'],
    ['right', 'notifications', 'Skip for now', 'done'],
    ['left', 'notifications', 'Skip for now', 'done'],
  ] as const)('measures the bottom anchored %s poster from %s via %s to %s and Back', async (side, initial, proceed, destination) => {
    mockReducedMotion(false);
    const { setPosterCardSide } = await import('./OnboardingScreen.js');
    setPosterCardSide(side);
    const { container } = await renderOnboarding(initial);
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    const card = container.querySelector<HTMLElement>('.cyber-card')!;
    const rectangle = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const posterLeft = side === 'right' ? 1440 - 56 - 320 : 56;
    const posterRect = rectangle(posterLeft, 628, 320, 240);
    const contentRect = rectangle(634, 104, 750, 764);
    const stepRect = (step: string | undefined) => step === 'avatar' || step === 'done' ? posterRect : contentRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === root) return rectangle(0, 0, 1440, 900);
      const bounds = stepRect(root.dataset.step);
      if (this === card) return bounds;
      if (this.classList.contains('cyber-card-content')) return rectangle(bounds.left + 20, bounds.top + 36, bounds.width - 40, bounds.height - 56);
      return rectangle(0, 0, 0, 0);
    });
    const checkMove = (before: DOMRect, after: DOMRect) => {
      const snapshot = container.querySelector<HTMLElement>('.cyber-card-snapshot')!;
      expect(snapshot.style.left).toBe(`${before.left}px`);
      expect(snapshot.style.top).toBe(`${before.top}px`);
      expect(snapshot.style.getPropertyValue('translate')).toBe('none');
      expect(snapshot.style.transform).toBe('none');
      expect(card.classList.contains('cyber-flip')).toBe(true);
      const anchor = card.dataset.windowAnchor;
      expect(card.style.getPropertyValue('--neo-flip-origin')).toBe(anchor === 'bottom-left' ? 'bottom left' : 'bottom right');
      expect(Number.parseFloat(card.style.getPropertyValue('--neo-flip-x'))).toBeCloseTo(anchor === 'bottom-left' ? before.left - after.left : before.right - after.right);
      expect(Number.parseFloat(card.style.getPropertyValue('--neo-flip-y'))).toBeCloseTo(before.bottom - after.bottom);
      expect(Number(card.style.getPropertyValue('--neo-flip-scale-x'))).toBeCloseTo(before.width / after.width);
      expect(Number(card.style.getPropertyValue('--neo-flip-scale-y'))).toBeCloseTo(before.height / after.height);
    };

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: proceed })); });
    expect(root.dataset.step).toBe(destination);
    checkMove(stepRect(initial), stepRect(destination));
    act(() => vi.advanceTimersByTime(560));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    expect(root.dataset.step).toBe(initial);
    checkMove(stepRect(destination), stepRect(initial));
    act(() => vi.advanceTimersByTime(560));
    expect(container.querySelector('.cyber-card-snapshot')).toBeNull();
    expect(card.classList.contains('cyber-flip')).toBe(false);
  });

  it('uses the fallback with forward and back directions and fills or empties the travelled segment', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    const progress = screen.getByRole('progressbar');
    expect(typeof document.startViewTransition).toBe('undefined');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(root.dataset.direction).toBe('forward');
    expect(root.classList.contains('cyber-transition--fallback')).toBe(true);
    expect(progress.children[1]!.getAttribute('data-changing')).toBe('true');
    expect(progress.children[1]!.getAttribute('data-done')).toBe('true');
    expect(container.querySelector('.cyber-card-content--outgoing')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.cyber-orbit-exit')!.getAttribute('aria-hidden')).toBe('true');
    act(() => vi.advanceTimersByTime(560));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    expect(root.dataset.direction).toBe('back');
    expect(root.classList.contains('cyber-transition--fallback')).toBe(true);
    expect(progress.children[1]!.getAttribute('data-changing')).toBe('true');
    expect(progress.children[1]!.getAttribute('data-done')).toBe('false');
    act(() => vi.advanceTimersByTime(560));
    expectProgress(1);
    expect(container.querySelector('.cyber-orbit-exit')).toBeNull();
  });

  it('keeps every stage element, the card, progress and terminal mounted through all four steps and Back', async () => {
    const { container } = await renderOnboarding();
    const selectors = ['.cyber-stage', '.print-backdrop', '.print-traces', '.print-ring-gauge', '.cyber-wordmark', '.cyber-figure-hit', '.cyber-figure-frame', '.neo-avfig', '.cyber-hud', '.print-badges', '.cyber-card', '.onboarding__progress', '.print-terminal-line'];
    const nodes = selectors.map((selector) => container.querySelector(selector));
    nodes.forEach((node) => expect(node).toBeTruthy());
    const checkNodes = () => selectors.forEach((selector, i) => expect(container.querySelector(selector)).toBe(nodes[i]));

    await clickButton('Continue');
    checkNodes();
    await clickButton('Skip for now');
    checkNodes();
    await clickButton('Skip for now');
    checkNodes();
    expectProgress(4);
    expect(screen.getByRole('progressbar').children).toHaveLength(4);
    await clickButton('Back');
    checkNodes();
    await clickButton('Back');
    checkNodes();
    await clickButton('Back');
    checkNodes();
    expectProgress(1);
  });

  it('disables Continue and Back for the move and focuses the new heading only after settling', async () => {
    const { container } = await renderOnboarding('ai');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip for now' })); });
    const heading = screen.getByRole('heading', { name: 'Never miss a reminder' });
    expect(root.dataset.transition).toBe('true');
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Skip for now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).not.toBe(heading);
    act(() => vi.advanceTimersByTime(559));
    expect(root.dataset.transition).toBe('true');
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset.transition).toBe('false');
    expect((screen.getByRole('button', { name: 'Skip for now' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector('.cyber-card-content--outgoing, .cyber-flip')).toBeNull();
  });

  it('accepts a double click on Continue as one save and one step', async () => {
    const { container } = await renderOnboarding();
    const proceed = screen.getByRole('button', { name: 'Continue' });
    await act(async () => {
      fireEvent.click(proceed);
      fireEvent.click(proceed);
      fireEvent.doubleClick(proceed);
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cyber-onboarding')!.getAttribute('data-step')).toBe('ai');
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    act(() => vi.advanceTimersByTime(700));
    expect(container.querySelector('.cyber-onboarding')!.getAttribute('data-step')).toBe('ai');
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBe('ai');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('uses only the 150 ms card crossfade for reduced motion and never calls View Transitions', async () => {
    mockReducedMotion();
    const start = vi.fn();
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const { container } = await renderOnboarding('ai');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip for now' })); });
    expect(Array.from(root.classList).filter((name) => name.startsWith('cyber-transition--'))).toEqual(['cyber-transition--crossfade']);
    expect(container.querySelector('.cyber-flip, .cyber-orbit-exit')).toBeNull();
    expect(container.querySelector('.neo-avfig')!.hasAttribute('data-glitch')).toBe(false);
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('set your signals_');
    expect(start).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(149));
    expect(root.dataset.transition).toBe('true');
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset.transition).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Never miss a reminder' }));
  });

  it('switches an active move to crossfade when reduced motion changes live', async () => {
    const setReducedMotion = mockReducedMotion(false);
    const { container } = await renderOnboarding('ai');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip for now' })); });
    expect(root.classList.contains('cyber-transition--fallback')).toBe(true);
    setReducedMotion(true);
    expect(root.classList.contains('cyber-transition--crossfade')).toBe(true);
    expect(root.classList.contains('cyber-transition--fallback')).toBe(false);
    expect(container.querySelector('.cyber-flip')).toBeNull();
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('set your signals_');
    act(() => vi.advanceTimersByTime(150));
    expect(root.dataset.transition).toBe('false');
  });

  it('honors reduced motion enabled before an asynchronous native callback runs', async () => {
    const setReducedMotion = mockReducedMotion(false);
    let update!: () => void;
    const skipTransition = vi.fn();
    const start = vi.fn((callback: () => void) => {
      update = callback;
      return { ready: new Promise<void>(() => {}), finished: Promise.resolve(), skipTransition };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const { container } = await renderOnboarding('ai');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip for now' })); });
    expect(root.dataset.step).toBe('ai');
    expect(root.classList.contains('cyber-transition--view')).toBe(true);
    setReducedMotion(true);
    expect(skipTransition).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200));
    expect(root.dataset.transition).toBe('true');
    expect(root.dataset.step).toBe('ai');

    await act(async () => { update(); });
    expect(root.dataset.step).toBe('notifications');
    expect(Array.from(root.classList).filter((name) => name.startsWith('cyber-transition--'))).toEqual(['cyber-transition--crossfade']);
    expect(container.querySelector('.cyber-flip, .cyber-orbit-exit')).toBeNull();
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe('set your signals_');
    act(() => vi.advanceTimersByTime(149));
    expect(root.dataset.transition).toBe('true');
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset.transition).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Never miss a reminder' }));
  });

  it('removes departing snapshots and clears scene timers when unmounted during a move', async () => {
    mockReducedMotion(false);
    const { container, unmount } = await renderOnboarding();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    const outgoing = container.querySelector<HTMLElement>('.cyber-card-content--outgoing')!;
    const orbit = container.querySelector<HTMLElement>('.cyber-orbit-exit')!;
    const card = container.querySelector<HTMLElement>('.cyber-card')!;
    expect(outgoing.isConnected).toBe(true);
    expect(orbit.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(outgoing.parentElement).toBeNull();
    expect(orbit.parentElement).toBeNull();
    expect(card.classList.contains('cyber-flip')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.runOnlyPendingTimers());
    expect(navigate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits for the avatar save before starting a transition', async () => {
    let resolveSave!: (value: typeof DEFAULT_SETTINGS) => void;
    mockUpdate.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(root.dataset.step).toBe('avatar');
    expect(root.dataset.transition).toBe('false');
    act(() => vi.advanceTimersByTime(700));
    expect(root.dataset.step).toBe('avatar');
    await act(async () => { resolveSave(DEFAULT_SETTINGS); });
    expect(root.dataset.step).toBe('ai');
    expect(root.dataset.transition).toBe('true');
    act(() => vi.advanceTimersByTime(560));
    expect(root.dataset.transition).toBe('false');
  });

  it('leaves the step and scene settled when the avatar save fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Save failed'));
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(root.dataset.step).toBe('avatar');
    expect(root.dataset.transition).toBe('false');
    expect(container.querySelector('.cyber-card-content--incoming, .cyber-card-content--outgoing, .cyber-flip')).toBeNull();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBeNull();
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Save failed' })]);
  });

  it.each([
    ['avatar', 'choose a face_'],
    ['ai', 'connect your ai_'],
    ['notifications', 'set your signals_'],
    ['done', 'neo is online_'],
    ['memory', 'set your signals_'],
  ])('resumes %s without an entry animation or terminal typing', async (step, text) => {
    mockReducedMotion(false);
    const start = vi.fn();
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const { container } = await renderOnboarding(step);
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    expect(root.dataset.transition).toBe('false');
    expect(Array.from(root.classList).filter((name) => name.startsWith('cyber-transition--'))).toEqual([]);
    expect(container.querySelector('.cyber-card-content--incoming, .cyber-card-content--outgoing, .cyber-flip')).toBeNull();
    expect(container.querySelector('.print-terminal-text')!.textContent).toBe(text);
    expect(start).not.toHaveBeenCalled();
  });

  it('updates the step synchronously inside the View Transition callback', async () => {
    mockReducedMotion(false);
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    const start = vi.fn((update: () => void) => {
      expect(root.dataset.step).toBe('avatar');
      expect(root.dataset.direction).toBe('forward');
      update();
      expect(root.dataset.step).toBe('ai');
      expect(screen.getByRole('heading', { name: 'Choose your AI' })).toBeTruthy();
      return { ready: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(root.classList.contains('cyber-transition--view')).toBe(true);
    expect(container.querySelector('.cyber-card-content--outgoing, .cyber-flip')).toBeNull();
    act(() => vi.advanceTimersByTime(560));
    expect(root.dataset.transition).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose your AI' }));
  });

  it.each(['before', 'after'])('falls back when View Transitions throws %s applying the step', async (when) => {
    mockReducedMotion(false);
    const start = vi.fn((update: () => void) => {
      if (when === 'after') update();
      throw new Error('View Transitions unavailable');
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(root.dataset.step).toBe('ai');
    expect(root.classList.contains('cyber-transition--fallback')).toBe(true);
    act(() => vi.advanceTimersByTime(560));
    expect(root.dataset.transition).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose your AI' }));
  });

  it('falls back when a native transition rejects readiness after applying the step', async () => {
    mockReducedMotion(false);
    let rejectReady!: (reason: Error) => void;
    const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
    const skipTransition = vi.fn();
    const start = vi.fn((update: () => void) => {
      update();
      return { ready, finished: Promise.resolve(), skipTransition };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const { container } = await renderOnboarding();
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(root.classList.contains('cyber-transition--view')).toBe(true);
    await act(async () => { rejectReady(new Error('Capture failed')); });
    expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(root.classList.contains('cyber-transition--fallback')).toBe(true);
    expect(root.dataset.step).toBe('ai');
    expect(container.querySelectorAll('.cyber-card-content--outgoing')).toHaveLength(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(560));
    expect(root.dataset.transition).toBe('false');
    expect(container.querySelector('.cyber-card-content--outgoing')).toBeNull();
  });

  it('starts the 620 ms exit only after setup saves and navigates when it settles', async () => {
    let resolveSave!: (value: typeof DEFAULT_SETTINGS) => void;
    mockUpdate.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const { container } = await renderOnboarding('done');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start chatting' })); });
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
    expect(root.dataset.transition).toBe('false');
    expect(navigate).not.toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
    await act(async () => { resolveSave(DEFAULT_SETTINGS); });
    expect(root.classList.contains('cyber-transition--finish')).toBe(true);
    expect((screen.getByRole('button', { name: /Start chatting/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(619); });
    expect(navigate).not.toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBeNull();
  });

  it('stays on Done with enabled controls when finishing setup fails to save', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Setup failed'));
    const { container } = await renderOnboarding('done');
    const root = container.querySelector<HTMLElement>('.cyber-onboarding')!;
    await clickButton('Start chatting');
    expect(root.dataset.step).toBe('done');
    expect(root.dataset.transition).toBe('false');
    expect(root.classList.contains('cyber-transition--finish')).toBe(false);
    expect((screen.getByRole('button', { name: 'Start chatting' }) as HTMLButtonElement).disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalledWith({ name: 'timeline' }, { replace: true });
    expect(sessionStorage.getItem(STORAGE_KEYS.onboardingStep)).toBe('done');
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Setup failed' })]);
  });
});

describe('Avatar settings', () => {
  it('keeps the full character and background picker and saves only the avatar', async () => {
    const { AvatarSection } = await import('./settings/PersonaSection.js');
    const { container } = render(<I18nProvider locale="en" messages={appDictionaries}><AvatarSection /></I18nProvider>);

    expect(screen.getByRole('heading', { name: 'Avatar' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Character' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Robot' })).toBeTruthy();
    expect(container.querySelector('.neo-avp--orbit')).toBeNull();
    expect(container.querySelector('.neo-avp-stage')).toBeTruthy();
    expect(container.querySelector('.neo-avp-swatches')).toBeTruthy();
    const colors = screen.getByRole('radiogroup', { name: 'Background' });
    expect(within(colors).getAllByRole('radio')).toHaveLength(AVATAR_BACKGROUNDS.length + 1);
    expect((within(colors).getByRole('radio', { name: 'Custom color' }) as HTMLInputElement).type).toBe('color');
    expect(container.querySelector('[data-orbit]')).toBeNull();
    expect(container.querySelector('input:not([type="color"]), textarea, select')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    await clickButton('Save');

    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar: serializeAvatar({ ...DEFAULT_AVATAR, kind: 'cat' }) } });
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'success', title: 'Avatar saved' })]);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['preset', '#DCD0F4'],
    ['custom', '#345678'],
  ] as const)('still saves a %s background from Settings', async (choice, bg) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: { avatar: serializeAvatar({ kind: 'dog', bg: DEFAULT_AVATAR.bg }) } } });
    const { AvatarSection } = await import('./settings/PersonaSection.js');
    render(<I18nProvider locale="en" messages={appDictionaries}><AvatarSection /></I18nProvider>);
    const colors = screen.getByRole('radiogroup', { name: 'Background' });
    if (choice === 'custom') fireEvent.change(within(colors).getByRole('radio', { name: 'Custom color' }), { target: { value: bg } });
    else fireEvent.click(within(colors).getByRole('radio', { name: bg }));
    expect(within(colors).getByRole('radio', { name: choice === 'custom' ? 'Custom color' : bg }).getAttribute('aria-checked')).toBe('true');
    await clickButton('Save');

    const avatar = serializeAvatar({ kind: 'dog', bg });
    expect(mockUpdate).toHaveBeenCalledWith({ persona: { avatar } });
    expect(useSession.getState().settings!.persona.avatar).toBe(avatar);
  });

  it('uses the Chinese avatar section name', async () => {
    const { AvatarSection } = await import('./settings/PersonaSection.js');
    render(<I18nProvider locale="zh-CN" messages={appDictionaries}><AvatarSection /></I18nProvider>);
    expect(screen.getByRole('heading', { name: '形象' })).toBeTruthy();
    const colors = screen.getByRole('radiogroup', { name: '背景' });
    expect(within(colors).getAllByRole('radio')).toHaveLength(AVATAR_BACKGROUNDS.length + 1);
    expect((within(colors).getByRole('radio', { name: '自定义颜色' }) as HTMLInputElement).type).toBe('color');
  });
});


describe('Memory settings', () => {
  it.each([
    ['en', 'Share sensitive memories with cloud models', 'Health, money, beliefs and similar memories are marked sensitive. By default they are only used with models running on your own devices.'],
    ['zh-CN', '允许把敏感记忆发给云端模型', '健康、财务、信仰等记忆会被标为敏感。默认只在运行于你自己设备上的模型中使用。'],
  ])('keeps the sensitive-memory explanation beside its sharing switch in %s', async (locale, label, explanation) => {
    const { MemorySection } = await import('./settings/MemorySection.js');
    render(<I18nProvider locale={locale} messages={appDictionaries}><MemorySection /></I18nProvider>);
    const toggle = screen.getByRole('switch', { name: new RegExp(label) });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(explanation)).toBeTruthy();
    expect(toggle.closest('.neo-switch')!.textContent).toContain(explanation);
  });
});
