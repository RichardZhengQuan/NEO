import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmProvider, I18nProvider, buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { navigate, parseRoute } from '../../router.js';
import { useToasts } from '../../state/notifications.js';
import { SettingsScreen } from '../SettingsScreen.js';
import { DesktopSection } from './DesktopSection.js';

const platform = vi.hoisted(() => ({ kind: 'electron' }));
vi.mock('../../platform/index.js', () => ({ getPlatform: () => platform }));
vi.mock('../../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => true }));
vi.mock('../../router.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../router.js')>(),
  navigate: vi.fn(),
}));

const t = createTranslator('en', buildMessages('en', appDictionaries));
const remoteBody = "This Mac's NEO keeps its memories but stops running. Paired phones won't reach it while it's stopped. NEO will restart to show the pairing screen.";
const localBody = "NEO will restart on this Mac with its existing memories. The remote NEO you had connected to isn't changed.";

function section() {
  return <I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><DesktopSection /></ConfirmProvider></I18nProvider>;
}

function renderSection() {
  return render(section());
}

function renderSettings() {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><SettingsScreen section="desktop" /></ConfirmProvider></I18nProvider>);
}

async function confirmSwitch() {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Switch' }));
}

beforeEach(() => {
  platform.kind = 'electron';
  window.neoDesktop = {
    platform: 'darwin',
    getConfig: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:7777', token: 'owner-token' }),
    openExternal: vi.fn(),
    getMode: vi.fn().mockResolvedValue({ kind: 'local' }),
    switchMode: vi.fn().mockResolvedValue(undefined),
  };
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  delete window.neoDesktop;
  vi.clearAllMocks();
});

describe('Settings desktop mode', () => {
  it('renders only on electron and reads the desktop mode only there', async () => {
    platform.kind = 'web';
    const { container, rerender } = renderSection();
    expect(container.firstChild).toBeNull();
    expect(window.neoDesktop!.getMode).not.toHaveBeenCalled();
    platform.kind = 'electron';
    rerender(section());
    expect(await screen.findByText('NEO on this Mac')).toBeDefined();
    expect(window.neoDesktop!.getMode).toHaveBeenCalledTimes(1);
  });

  it('shows this Mac and confirms its memories and phone access before switching to a different NEO', async () => {
    renderSection();
    expect(await screen.findByText('NEO on this Mac')).toBeDefined();
    expect(window.neoDesktop!.getMode).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Connect to a NEO' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect to a different NEO?' });
    expect(within(dialog).getByText(remoteBody)).toBeDefined();
    expect(window.neoDesktop!.switchMode).not.toHaveBeenCalled();
    await confirmSwitch();
    await waitFor(() => expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('remote'));
  });

  it('shows the remote address and confirms before running NEO on this Mac', async () => {
    vi.mocked(window.neoDesktop!.getMode!).mockResolvedValue({ kind: 'remote', serverUrl: 'https://example' });
    renderSection();
    expect(await screen.findByText('A NEO at https://example')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Run NEO on this Mac' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run NEO on this Mac?' });
    expect(within(dialog).getByText(localBody)).toBeDefined();
    expect(window.neoDesktop!.switchMode).not.toHaveBeenCalled();
    await confirmSwitch();
    await waitFor(() => expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('local'));
  });

  it('identifies a remote NEO that has not been paired yet', async () => {
    vi.mocked(window.neoDesktop!.getMode!).mockResolvedValue({ kind: 'remote' });
    renderSection();
    expect(await screen.findByText('A remote NEO (not paired yet)')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Run NEO on this Mac' })).toBeDefined();
  });

  it('falls back to this Mac when the desktop bridge is missing', async () => {
    delete window.neoDesktop;
    renderSection();
    expect(await screen.findByText('NEO on this Mac')).toBeDefined();
  });

  it('keeps the current mode when the confirmation is cancelled', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to a NEO' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(remoteBody)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.neoDesktop!.switchMode).not.toHaveBeenCalled();
    expect(screen.getByText('NEO on this Mac')).toBeDefined();
  });

  it('pushes an error toast when switching fails', async () => {
    vi.mocked(window.neoDesktop!.switchMode!).mockRejectedValue(new Error('Could not save startup mode'));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect to a NEO' }));
    await confirmSwitch();
    await waitFor(() => expect(window.neoDesktop!.switchMode).toHaveBeenCalledExactlyOnceWith('remote'));
    await waitFor(() => expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ tone: 'error', title: 'Could not save startup mode' })]));
  });
});

describe('Desktop section in Settings navigation', () => {
  it('recognizes the desktop Settings route and shows its navigation item and content on electron', async () => {
    expect(parseRoute('#/settings/desktop')).toEqual({ name: 'settings', section: 'desktop' });
    renderSettings();
    const nav = screen.getByRole('navigation', { name: t('nav.settings') });
    const desktopItem = within(nav).getByRole('button', { name: 'This Mac' });
    expect(desktopItem.getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('NEO on this Mac')).toBeDefined();
    expect(window.neoDesktop!.getMode).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(desktopItem);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ name: 'settings', section: 'desktop' }, { replace: true });
  });

  it.each(['web', 'capacitor'])('hides the desktop item and redirects a direct desktop Settings route on %s', (kind) => {
    platform.kind = kind;
    renderSettings();
    const nav = screen.getByRole('navigation', { name: t('nav.settings') });
    expect(within(nav).queryByRole('button', { name: 'This Mac' })).toBeNull();
    expect(screen.queryByText('NEO on this Mac')).toBeNull();
    expect(window.neoDesktop!.getMode).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ name: 'settings' });
  });
});
