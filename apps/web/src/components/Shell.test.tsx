import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@neo/ui';
import { DEFAULT_SETTINGS, type Reminder } from '@neo/protocol';
import { appDictionaries } from '../i18n.js';
import type { Route } from '../router.js';
import { useData } from '../state/data.js';
import { useSession } from '../state/session.js';
import { setDrawer, useUi } from '../state/ui.js';
import { Shell } from './Shell.js';

let desktop = true;
vi.mock('../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => desktop }));

const DESTINATIONS = ['timeline', 'memory', 'reminders', 'tasks', 'notes', 'settings'] as const;

beforeEach(() => {
  desktop = true;
  useUi.setState({ drawerOpen: false });
  useData.setState({ reminders: {} });
  useSession.setState({ settings: DEFAULT_SETTINGS, wsStatus: 'open' });
  window.history.replaceState(null, '', '#/');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderShell(locale: 'en' | 'zh-CN' = 'en', route: Route = { name: 'timeline' }) {
  return render(<I18nProvider locale={locale} messages={appDictionaries}><Shell route={route}><div>Timeline content</div></Shell></I18nProvider>);
}

function seedReminders(count: number): void {
  const reminder = (id: string, status: Reminder['status']): Reminder => ({
    id, title: 'Reminder', notes: null, dueAt: 1000, timezone: 'Asia/Singapore', recurrence: null,
    status, firedCount: status === 'fired' ? 1 : 0, lastFiredAt: status === 'fired' ? 1000 : null,
    messageId: null, createdAt: 1000, updatedAt: 1000,
  });
  const items = Array.from({ length: count }, (_, i) => reminder(`reminder_${i}`, 'fired'));
  items.push(reminder('scheduled', 'scheduled'), reminder('completed', 'completed'));
  useData.setState({ reminders: Object.fromEntries(items.map((item) => [item.id, item])) });
}

describe('icon-only navigation', () => {
  it.each(['en', 'zh-CN'] as const)('renders six named rail destinations without visible labels in %s', (locale) => {
    renderShell(locale);
    const nav = screen.getByRole('navigation', { name: appDictionaries[locale]['nav.main'] });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(6);
    DESTINATIONS.forEach((name, i) => {
      const button = within(nav).getByRole('button', { name: appDictionaries[locale][`nav.${name}`] });
      expect(button).toBe(buttons[i]);
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.hasAttribute('title')).toBe(false);
    });
    expect(nav.textContent).toBe('');
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(screen.queryByText(/New chat|Archived chats|Recent|新对话|已归档|最近/)).toBeNull();
    expect(document.querySelector('.conv-item')).toBeNull();
  });

  it('keeps Settings in its own bottom group', () => {
    renderShell('en', { name: 'settings', section: 'avatar' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const settings = within(nav).getByRole('button', { name: 'Settings' });
    const bottom = settings.closest('.side__bottom');
    expect(bottom).not.toBeNull();
    expect(bottom?.querySelectorAll('button')).toHaveLength(1);
    expect(nav.querySelector('.side__main')?.querySelectorAll('button')).toHaveLength(5);
    expect(settings.getAttribute('aria-current')).toBe('page');
  });

  it('keeps the home avatar and live status together without a brand label', () => {
    renderShell();
    const brand = document.querySelector<HTMLButtonElement>('.side__brand')!;
    expect(screen.getByRole('button', { name: 'NEO, Connected' })).toBe(brand);
    expect(brand.textContent).toBe('');
    expect(brand.querySelector('.neo-av')).not.toBeNull();
    expect(document.querySelector('.side__name')).toBeNull();
    expect(screen.queryByText('NEO')).toBeNull();
    expect(brand.parentElement?.querySelector('.status-dot')?.getAttribute('data-status')).toBe('open');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(window.location.hash).toBe('#/settings');
    fireEvent.click(brand);
    expect(window.location.hash).toBe('#/');
  });

  it.each(['en', 'zh-CN'] as const)('renders six named phone tabs without visible labels in %s', (locale) => {
    desktop = false;
    renderShell(locale);
    const nav = screen.getByRole('navigation', { name: appDictionaries[locale]['nav.main'] });
    const buttons = within(nav).getAllByRole('button');
    expect(nav.className).toBe('tabbar');
    expect(buttons).toHaveLength(6);
    DESTINATIONS.forEach((name, i) => {
      const button = within(nav).getByRole('button', { name: appDictionaries[locale][`nav.${name}`] });
      expect(button).toBe(buttons[i]);
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('width')).toBe('24');
    });
    expect(nav.textContent).toBe('');
    fireEvent.click(within(nav).getByRole('button', { name: appDictionaries[locale]['nav.settings'] }));
    expect(window.location.hash).toBe('#/settings');
  });

  it.each([true, false])('marks only the active destination, including a nested route (desktop=%s)', (isDesktop) => {
    desktop = isDesktop;
    renderShell('en', { name: 'memory', tab: 'list', nodeId: 'memory_1' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const active = within(nav).getAllByRole('button').filter((button) => button.hasAttribute('aria-current'));
    expect(active).toEqual([within(nav).getByRole('button', { name: 'Memory' })]);
    expect(active[0]!.getAttribute('aria-current')).toBe('page');
    fireEvent.click(active[0]!);
    expect(window.location.hash).toBe('#/memory');
  });

  it.each([true, false])('shows only fired reminder counts, capped at 9+ (desktop=%s)', (isDesktop) => {
    desktop = isDesktop;
    renderShell();
    const button = screen.getByRole('button', { name: 'Reminders' });
    const badgeClass = isDesktop ? '.nav-item__count' : '.tabbar__badge';
    expect(button.querySelector(badgeClass)).toBeNull();
    for (const [count, text] of [[1, '1'], [9, '9'], [10, '9+']] as const) {
      act(() => seedReminders(count));
      const badge = button.querySelector(badgeClass)!;
      expect(badge.textContent).toBe(text);
      expect(badge.getAttribute('aria-hidden')).toBe('true');
      expect(screen.getByRole('button', { name: `Reminders, ${count} due` })).toBe(button);
    }
    act(() => seedReminders(0));
    expect(button.querySelector(badgeClass)).toBeNull();
  });
});

describe('accessible names for badges and status', () => {
  it.each([
    [true, 'en', 'Reminders', 'Reminders, 3 due'],
    [false, 'en', 'Reminders', 'Reminders, 3 due'],
    [true, 'zh-CN', '提醒', '提醒，3 条待处理'],
    [false, 'zh-CN', '提醒', '提醒，3 条待处理'],
  ] as const)('includes the badge count (desktop=%s, locale=%s)', (isDesktop, locale, plainName, badgedName) => {
    desktop = isDesktop;
    renderShell(locale);
    const button = screen.getByRole('button', { name: plainName });
    expect(button.textContent).toBe('');
    act(() => seedReminders(3));
    expect(screen.getByRole('button', { name: badgedName })).toBe(button);
    expect(screen.queryByRole('button', { name: plainName })).toBeNull();
  });

  it.each([
    [true, 'en', 'Reminders', 'Reminders, 2 due'],
    [false, 'en', 'Reminders', 'Reminders, 2 due'],
    [true, 'zh-CN', '提醒', '提醒，2 条待处理'],
    [false, 'zh-CN', '提醒', '提醒，2 条待处理'],
  ] as const)('returns to the plain name when the badge clears (desktop=%s, locale=%s)', (isDesktop, locale, plainName, badgedName) => {
    desktop = isDesktop;
    renderShell(locale);
    act(() => seedReminders(2));
    const button = screen.getByRole('button', { name: badgedName });
    act(() => seedReminders(0));
    expect(screen.getByRole('button', { name: plainName })).toBe(button);
    expect(screen.queryByRole('button', { name: badgedName })).toBeNull();
    expect(button.textContent).toBe('');
  });

  it.each([true, false])('updates the home name with connection status (desktop=%s)', (isDesktop) => {
    desktop = isDesktop;
    renderShell();
    if (!isDesktop) act(() => setDrawer(true));
    const brand = screen.getByRole('button', { name: 'NEO, Connected' });
    expect(brand.className).toBe('side__brand');
    act(() => useSession.setState({ wsStatus: 'reconnecting' }));
    expect(screen.getByRole('button', { name: 'NEO, Reconnecting…' })).toBe(brand);
    expect(screen.queryByRole('button', { name: 'NEO, Connected' })).toBeNull();
    expect(brand.textContent).toBe('');
  });

  it.each(['en', 'zh-CN'] as const)('announces the home connection status in %s', (locale) => {
    renderShell(locale);
    const expectedStatus = appDictionaries[locale]['status.open'];
    const expectedName = appDictionaries[locale]['nav.timeline'];
    const expectedHome = (appDictionaries[locale]['nav.home_label'] as string)
      .replace('{name}', expectedName as string)
      .replace('{status}', expectedStatus as string);
    expect(screen.getByRole('button', { name: expectedHome }).className).toBe('side__brand');
  });
});

describe('rail tooltips', () => {
  it('keeps home and badged navigation tooltip text unchanged', () => {
    renderShell();
    act(() => seedReminders(3));
    for (const [ariaLabel, label] of [['NEO, Connected', 'NEO'], ['Reminders, 3 due', 'Reminders']] as const) {
      const button = screen.getByRole('button', { name: ariaLabel });
      fireEvent.focus(button);
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(label);
      expect(screen.getByRole('button', { name: ariaLabel })).toBe(button);
      fireEvent.blur(button);
    }
  });

  it.each(['en', 'zh-CN'] as const)('shows the translated tooltip immediately on focus without repeating its accessible name in %s', (locale) => {
    renderShell(locale);
    const label = appDictionaries[locale]['nav.memory'];
    const button = screen.getByRole('button', { name: label });
    fireEvent.focus(button);
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip.textContent).toBe(label);
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(button.textContent).toBe('');
    expect(screen.getByRole('button', { name: label })).toBe(button);
    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('waits 300 ms on hover and cancels pending tooltips when the pointer leaves', () => {
    vi.useFakeTimers();
    renderShell();
    const button = screen.getByRole('button', { name: 'Memory' });
    fireEvent.mouseEnter(button);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Memory');
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    fireEvent.mouseEnter(button);
    fireEvent.mouseLeave(button);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('keeps the focused tooltip visible when the pointer leaves and dismisses it with Escape', () => {
    renderShell();
    const button = screen.getByRole('button', { name: 'Memory' });
    fireEvent.focus(button);
    fireEvent.mouseLeave(button);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Memory');
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('cancels pending hover tooltips on Escape and unmount', () => {
    vi.useFakeTimers();
    const { unmount } = renderShell();
    const button = screen.getByRole('button', { name: 'Memory' });
    fireEvent.mouseEnter(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(button);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('phone drawer', () => {
  it('retains icon navigation and closes after choosing a destination', () => {
    desktop = false;
    renderShell();
    act(() => setDrawer(true));
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    const nav = within(dialog).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('button')).toHaveLength(6);
    const memory = within(nav).getByRole('button', { name: 'Memory' });
    expect(memory.textContent).toBe('');
    fireEvent.click(memory);
    expect(window.location.hash).toBe('#/memory');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUi.getState().drawerOpen).toBe(false);
  });

  it('closes with Escape or the backdrop', () => {
    desktop = false;
    renderShell();
    act(() => setDrawer(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => setDrawer(true));
    fireEvent.click(document.querySelector('.drawer-backdrop')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUi.getState().drawerOpen).toBe(false);
  });
});
