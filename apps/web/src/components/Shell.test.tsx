import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@neo/ui';
import { DEFAULT_SETTINGS } from '@neo/protocol';
import { appDictionaries } from '../i18n.js';
import { useData } from '../state/data.js';
import { useSession } from '../state/session.js';
import { useUi } from '../state/ui.js';
import { Shell } from './Shell.js';

let desktop = true;
vi.mock('../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => desktop }));

beforeEach(() => {
  desktop = true;
  useUi.setState({ drawerOpen: false });
  useData.setState({ reminders: {} });
  useSession.setState({ settings: DEFAULT_SETTINGS });
  window.history.replaceState(null, '', '#/');
});
afterEach(cleanup);

function renderShell(locale: 'en' | 'zh-CN' = 'en') {
  return render(<I18nProvider locale={locale} messages={appDictionaries}><Shell route={{ name: 'timeline' }}><div>Timeline content</div></Shell></I18nProvider>);
}

describe('timeline navigation', () => {
  it.each(['en', 'zh-CN'] as const)('shows six destinations with no conversation controls in %s', (locale) => {
    renderShell(locale);
    const nav = screen.getByRole('navigation', { name: appDictionaries[locale]['nav.main'] });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['NEO', ...['memory', 'reminders', 'tasks', 'notes', 'settings'].map((key) => appDictionaries[locale][`nav.${key}`])]);
    expect(buttons[0]!.getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText(/New chat|Archived chats|Recent|新对话|已归档|最近/)).toBeNull();
    expect(document.querySelector('.conv-item')).toBeNull();
  });

  it('opens the home timeline from the brand and settings from the navigation', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(window.location.hash).toBe('#/settings');
    fireEvent.click(screen.getAllByRole('button', { name: 'NEO' })[0]!);
    expect(window.location.hash).toBe('#/');
  });

  it('includes Settings in the phone navigation', () => {
    desktop = false;
    renderShell();
    const nav = screen.getByRole('navigation', { name: appDictionaries.en['nav.main'] });
    expect(within(nav).getAllByRole('button')).toHaveLength(6);
    fireEvent.click(within(nav).getByRole('button', { name: 'Settings' }));
    expect(window.location.hash).toBe('#/settings');
  });
});
