import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS, applySettingsPatch, type ModelInfo, type NeoSettings, type NeoSettingsPatch, type ProviderView } from '@neo/protocol';
import { I18nProvider, LinkProvider, MessageView } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { openLink } from '../actions/links.js';
import { useSession } from '../state/session.js';
import { AiSection } from '../screens/settings/AiSection.js';
import { SearchSettings } from './SearchSettings.js';

const openExternal = vi.fn();
vi.mock('../platform/index.js', () => ({ getPlatform: () => ({ openExternal }) }));

const provider: ProviderView = { id: 'custom', kind: 'openai-compatible', label: 'Custom AI', enabled: true, hasApiKey: false, isLocal: true };
const model: ModelInfo = { id: 'text-model', provider: provider.id, capabilities: { ...DEFAULT_CAPABILITIES, nativeWebSearch: false } };
const client = { settings: { update: vi.fn() }, providers: { models: vi.fn() } };
let storedSettings: NeoSettings;

function setup(locale: 'en' | 'zh-CN' = 'en') {
  return render(<I18nProvider locale={locale} messages={appDictionaries}><SearchSettings /></I18nProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  storedSettings = applySettingsPatch(DEFAULT_SETTINGS, { ai: { mode: 'advanced', capabilities: { text: { provider: provider.id, model: model.id } } } });
  client.settings.update.mockImplementation(async (patch: NeoSettingsPatch) => { storedSettings = applySettingsPatch(storedSettings, patch); return storedSettings; });
  client.providers.models.mockResolvedValue({ items: [model] });
  useSession.setState({ client: client as unknown as NeoClient, settings: storedSettings, providers: { items: [provider], defaultModel: { provider: provider.id, model: model.id } }, models: { [provider.id]: [model] }, sessionEpoch: 1 });
});
afterEach(cleanup);

describe('advanced search settings', () => {
  it.each(['en', 'zh-CN'] as const)('shows auto and the unsupported-provider hint in %s', (locale) => {
    setup(locale);
    const strings = appDictionaries[locale];
    expect((screen.getByRole('combobox', { name: strings['ai.search'] }) as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByRole('option', { name: strings['ai.search_auto'] })).toBeTruthy();
    expect(screen.getByText(strings['ai.search_unavailable']!)).toBeTruthy();
  });

  it('hides the unsupported hint when the selected Text model supports native search', () => {
    useSession.setState({ models: { [provider.id]: [{ ...model, capabilities: { ...model.capabilities, nativeWebSearch: true } }] } });
    setup();
    expect(screen.queryByText(appDictionaries.en['ai.search_unavailable']!)).toBeNull();
  });

  it('saves a runtime engine and clears its private key from the input and settings', async () => {
    setup();
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'engine' } }); });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine service' }), { target: { value: 'brave' } });
    const key = screen.getByLabelText('Search engine API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'private-search-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save search engine' })); });
    expect(client.settings.update).toHaveBeenLastCalledWith({ ai: { search: { engine: { provider: 'brave', apiKey: 'private-search-key' } } } });
    expect(key.value).toBe('');
    expect(JSON.stringify(useSession.getState().settings)).not.toContain('private-search-key');
    expect(storedSettings.ai.search.mode).toBe('engine');
  });

  it('saves a SearXNG URL and can restore the configured server default', async () => {
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine service' }), { target: { value: 'searxng' } });
    expect((screen.getByRole('button', { name: 'Save search engine' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('SearXNG URL'), { target: { value: 'https://search.example' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save search engine' })); });
    expect(client.settings.update).toHaveBeenLastCalledWith({ ai: { search: { engine: { provider: 'searxng', baseUrl: 'https://search.example' } } } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine service' }), { target: { value: '' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save search engine' })); });
    expect(client.settings.update).toHaveBeenLastCalledWith({ ai: { search: { engine: null } } });
  });

  it('keeps saved keys private and omits them when retaining an engine', async () => {
    storedSettings = applySettingsPatch(storedSettings, { ai: { search: { engine: { provider: 'tavily', hasApiKey: true } } } });
    useSession.setState({ settings: storedSettings });
    setup();
    expect((screen.getByLabelText('Search engine API key') as HTMLInputElement).value).toBe('');
    expect(screen.getByPlaceholderText('Saved key; leave blank to keep it')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save search engine' })); });
    expect(client.settings.update).toHaveBeenLastCalledWith({ ai: { search: { engine: { provider: 'tavily' } } } });
  });

  it('hides engine configuration when off and rolls back after a failed save', async () => {
    setup();
    client.settings.update.mockRejectedValueOnce(new Error('Try again'));
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'off' } }); });
    expect(screen.getByRole('alert').textContent).toBe('Try again');
    expect((screen.getByRole('combobox', { name: 'Search' }) as HTMLSelectElement).value).toBe('auto');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Search' }), { target: { value: 'off' } }); });
    expect(screen.queryByRole('combobox', { name: 'Search engine service' })).toBeNull();
    expect(storedSettings.ai.search.mode).toBe('off');
  });

  it('clears an unsaved key when the connected NEO session changes', () => {
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine service' }), { target: { value: 'tavily' } });
    fireEvent.change(screen.getByLabelText('Search engine API key'), { target: { value: 'private-draft' } });
    act(() => { useSession.setState({ sessionEpoch: 2 }); });
    expect(screen.queryByLabelText('Search engine API key')).toBeNull();
  });

  it('keeps a failed engine-save error visible after the optimistic engine rolls back', async () => {
    let rejectUpdate!: (error: Error) => void;
    client.settings.update.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectUpdate = reject; }));
    setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search engine service' }), { target: { value: 'brave' } });
    fireEvent.change(screen.getByLabelText('Search engine API key'), { target: { value: 'private-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save search engine' })); });
    expect(useSession.getState().settings?.ai.search.engine?.provider).toBe('brave');
    expect((screen.getByRole('combobox', { name: 'Search' }) as HTMLSelectElement).disabled).toBe(true);
    await act(async () => { rejectUpdate(new Error('Engine settings could not be saved')); });
    expect(useSession.getState().settings?.ai.search.engine).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Engine settings could not be saved');
    act(() => { useSession.setState({ sessionEpoch: 2 }); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds search only inside the Settings AI Advanced section', async () => {
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'simple' } });
    useSession.setState({ settings: storedSettings });
    render(<I18nProvider locale="en" messages={appDictionaries}><AiSection /></I18nProvider>);
    expect(screen.queryByRole('combobox', { name: 'Search' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Advanced' })); });
    await waitFor(() => { expect(screen.getByRole('combobox', { name: 'Search' })).toBeTruthy(); });
  });

  it('opens timeline source links with the platform openExternal', () => {
    render(<I18nProvider locale="en"><LinkProvider onLink={openLink}><MessageView message={{ id: 'message', episodeId: 'episode', conversationId: 'episode', role: 'assistant', status: 'complete', createdAt: 0, parts: [{ type: 'sources', items: [{ title: 'Article', url: 'https://example.com/article' }] }] }} /></LinkProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'Article' }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/article');
  });
});
