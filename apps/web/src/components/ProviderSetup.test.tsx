import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { AI_CAPABILITIES, DEFAULT_CAPABILITIES, DEFAULT_SETTINGS, NeoError, applySettingsPatch, deepMerge, type AiCapability, type ModelInfo, type NeoSettings, type NeoSettingsPatch, type ProviderView } from '@neo/protocol';
import { I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useSession } from '../state/session.js';
import { ProviderSetup } from './ProviderSetup.js';

const openExternal = vi.fn();
vi.mock('../platform/index.js', () => ({ getPlatform: () => ({ openExternal }) }));

const provider: ProviderView = { id: 'anthropic', kind: 'anthropic', label: 'Anthropic Claude', enabled: true, hasApiKey: true, isLocal: false };
const router: ProviderView = { ...provider, id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' };
const chatgpt: ProviderView = { ...provider, id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT', hasApiKey: false };
const onDone = vi.fn();
let providerItems: ProviderView[];
let storedSettings: NeoSettings;
let modelItems: ModelInfo[];

const client = {
  auth: { openrouterStart: vi.fn(), openrouterCancel: vi.fn(), chatgptStart: vi.fn(), chatgptCancel: vi.fn(), chatgptStatus: vi.fn() },
  providers: { create: vi.fn(), list: vi.fn(), models: vi.fn(), testDraft: vi.fn(), delete: vi.fn(), update: vi.fn() },
  settings: { get: vi.fn(), update: vi.fn() },
};

function model(id: string, capability: AiCapability): ModelInfo {
  return { id, provider: provider.id, capabilities: { ...DEFAULT_CAPABILITIES, tools: capability === 'text', text: capability === 'text', embeddings: capability === 'embedding', ...(capability !== 'text' && capability !== 'embedding' ? { [capability]: true } : {}) } };
}

function setup(locale: 'en' | 'zh-CN' = 'en', offerExisting = false) {
  function Setup() {
    const providers = useSession((s) => s.providers);
    return <ProviderSetup existing={providers?.items ?? []} onDone={onDone} offerExisting={offerExisting} />;
  }
  return render(<I18nProvider locale={locale} messages={appDictionaries}><Setup /></I18nProvider>);
}

async function click(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  providerItems = [];
  storedSettings = deepMerge(DEFAULT_SETTINGS, {});
  modelItems = AI_CAPABILITIES.map((capability) => model(`${capability}-model`, capability));
  client.providers.list.mockImplementation(async () => ({ items: providerItems, defaultModel: storedSettings.ai.capabilities.text, ai: storedSettings.ai }));
  client.providers.models.mockImplementation(async () => ({ items: modelItems }));
  client.providers.create.mockImplementation(async () => {
    providerItems = [provider];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'simple', capabilities: { text: { provider: provider.id, model: 'claude-sonnet-5-5' } } } });
    return provider;
  });
  client.providers.testDraft.mockResolvedValue({ ok: true, latencyMs: 1 });
  client.providers.delete.mockImplementation(async () => { providerItems = []; storedSettings = deepMerge(DEFAULT_SETTINGS, {}); });
  client.settings.get.mockImplementation(async () => storedSettings);
  client.settings.update.mockImplementation(async (patch: NeoSettingsPatch) => { storedSettings = applySettingsPatch(storedSettings, patch); return storedSettings; });
  client.auth.openrouterStart.mockImplementation(async () => ({ url: 'https://openrouter.ai/auth?state=test-state', state: 'test-state', expiresAt: Date.now() + 600_000 }));
  client.auth.openrouterCancel.mockResolvedValue({ cancelled: true });
  client.auth.chatgptStart.mockImplementation(async () => ({ url: 'https://auth.openai.com/api/accounts/authorize?state=chatgpt-state', state: 'chatgpt-state', expiresAt: Date.now() + 600_000 }));
  client.auth.chatgptCancel.mockResolvedValue({ cancelled: true });
  client.auth.chatgptStatus.mockResolvedValue({ status: 'waiting' });
  useSession.setState({ client: client as unknown as NeoClient, settings: storedSettings, health: { ok: true, name: 'neo', version: '0.1.0', apiVersion: '1', mode: 'local', onboarded: false, time: 0 }, providers: { items: [], defaultModel: null }, models: {}, sessionEpoch: 1 });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('AI connection setup', () => {
  it.each(['en', 'zh-CN'] as const)('keeps account sign-in and one private key field simple in %s', (locale) => {
    const { container } = setup(locale);
    const t = appDictionaries[locale];
    expect((screen.getByRole('button', { name: t['provider.signin_chatgpt']! }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(t['provider.chatgpt_help']!)).toBeTruthy();
    expect(screen.getByRole('button', { name: t['provider.signin_openrouter']! })).toBeTruthy();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelector('.preset-grid')).toBeNull();
    expect(screen.queryByText(t['provider.custom']!)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.textContent).not.toMatch(/Demo mode|演示模式/);
  });

  it('detects a key, connects with server-tested defaults, and keeps the summary until Continue', async () => {
    setup('en', true);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-private' } });
    expect(screen.getByText('Detected: Anthropic Claude')).toBeTruthy();
    await click('Connect');
    expect(client.providers.create).toHaveBeenCalledWith({ kind: 'anthropic', label: 'Anthropic Claude', apiKey: 'sk-ant-private', simple: true });
    expect(screen.getByText('Anthropic Claude is connected')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getByText('Local memory index')).toBeTruthy();
    expect(screen.getAllByText('Not configured')).toHaveLength(4);
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(onDone).not.toHaveBeenCalled();
    await click('Continue');
    expect(onDone).toHaveBeenCalledWith({ provider, model: 'claude-sonnet-5-5' });
  });

  it('detects OpenRouter separately from OpenAI keys', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-private' } });
    expect(screen.getByText('Detected: OpenRouter')).toBeTruthy();
    await click('Connect');
    expect(client.providers.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter', simple: true }));
  });

  it('asks for the service only when the key format is unknown and allows retry after failure', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'unfamiliar-private-key' } });
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'AI service' }), { target: { value: 'gemini' } });
    client.providers.create.mockRejectedValueOnce(new Error('The service rejected this key'));
    await click('Connect');
    expect(screen.getByRole('alert').textContent).toContain('The service rejected this key');
    expect((screen.getByLabelText('API key') as HTMLInputElement).type).toBe('password');
    expect(screen.queryByText('unfamiliar-private-key')).toBeNull();
    await click('Connect');
    expect(client.providers.create).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'gemini', simple: true }));
  });

  it.each(AI_CAPABILITIES)('stores the %s capability independently and clears it to null', async (capability) => {
    providerItems = [provider];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    setup();
    const name = appDictionaries.en[`provider.capability.${capability}`]!;
    await waitFor(() => expect(useSession.getState().models[provider.id]).toHaveLength(6));
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: `${name} service` }), { target: { value: provider.id } }); });
    expect(storedSettings.ai.capabilities[capability]).toEqual({ provider: provider.id, model: `${capability}-model` });
    for (const other of AI_CAPABILITIES.filter((other) => other !== capability)) expect(storedSettings.ai.capabilities[other]).toBeNull();
    const select = screen.getByRole('combobox', { name: `${name} model` });
    expect(within(select).getAllByRole('option')).toHaveLength(7);
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    expect(storedSettings.ai.capabilities[capability]).toBeNull();
  });

  it('preserves every Advanced assignment when adding another API key', async () => {
    providerItems = [provider];
    const capabilities = Object.fromEntries(AI_CAPABILITIES.map((capability) => [capability, { provider: provider.id, model: `${capability}-model` }]));
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced', capabilities } });
    const before = structuredClone(storedSettings.ai);
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: storedSettings.ai.capabilities.text } });
    const added: ProviderView = { ...provider, id: 'gemini', kind: 'gemini', label: 'Google Gemini' };
    client.providers.create.mockImplementationOnce(async () => { providerItems = [provider, added]; return added; });
    setup();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-new-private-key' } });
    await click('Connect');
    expect(client.providers.testDraft).toHaveBeenCalledWith({ kind: 'gemini', apiKey: 'AIza-new-private-key' });
    expect(client.providers.create).toHaveBeenCalledWith({ kind: 'gemini', label: 'Google Gemini', apiKey: 'AIza-new-private-key', simple: false });
    expect(storedSettings.ai).toEqual(before);
    expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('NEO picked these models for each capability:')).toBeNull();
  });

  it('allows an explicit Advanced voice assignment when a custom model has no modality metadata', async () => {
    providerItems = [provider];
    modelItems = [{ id: 'bark-custom', provider: provider.id, capabilities: DEFAULT_CAPABILITIES }];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    setup();
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Voice · Text to speech service' }), { target: { value: provider.id } }); });
    expect(storedSettings.ai.capabilities.textToSpeech).toBeNull();
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Voice · Text to speech model' }), { target: { value: 'bark-custom' } }); });
    expect(storedSettings.ai.capabilities.textToSpeech).toEqual({ provider: provider.id, model: 'bark-custom' });
  });

  it('makes a failed model list visible and retryable', async () => {
    providerItems = [provider];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    client.providers.models.mockRejectedValueOnce(new Error('Models are temporarily unavailable'));
    setup();
    await screen.findByText('Couldn’t load models for Anthropic Claude');
    await click('Retry');
    await waitFor(() => expect(useSession.getState().models[provider.id]).toHaveLength(6));
    expect(screen.queryByText('Couldn’t load models for Anthropic Claude')).toBeNull();
  });

  it('adds a tested custom endpoint only in Advanced with an optional key and honest success copy', async () => {
    setup();
    await click('Advanced');
    expect(client.settings.update).toHaveBeenCalledWith({ ai: { mode: 'advanced' } });
    await click('Add a custom endpoint');
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://127.0.0.1:11434/v1' } });
    const endpoint: ProviderView = { ...provider, id: 'custom', kind: 'openai-compatible', label: 'Custom endpoint', hasApiKey: false, isLocal: true };
    client.providers.create.mockImplementationOnce(async () => { providerItems = [endpoint]; return endpoint; });
    await click('Connect endpoint');
    expect(client.providers.testDraft).toHaveBeenCalledWith({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(client.providers.create).toHaveBeenCalledWith({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', label: 'Custom endpoint', simple: false });
    expect(screen.getByText('Choose this connection and models for the capabilities below.')).toBeTruthy();
    expect(screen.queryByText('NEO picked these models for each capability:')).toBeNull();
  });

  it('disconnects a saved connection and clears its assignments', async () => {
    providerItems = [provider];
    useSession.setState({ providers: { items: providerItems, defaultModel: null } });
    setup();
    await click('Disconnect Anthropic Claude');
    expect(client.providers.delete).toHaveBeenCalledWith(provider.id);
    expect(screen.queryByRole('region', { name: 'Already set up' })).toBeNull();
    expect(useSession.getState().settings!.ai.capabilities.text).toBeNull();
  });
});

describe.each([
  { locale: 'en' as const, local: 'Local', cloud: 'Cloud', withheld: 'Sensitive memories aren’t sent to this connection.', shared: 'Sensitive memories are shared with this connection.' },
  { locale: 'zh-CN' as const, local: '本地', cloud: '云端', withheld: '敏感记忆不会发送到此连接。', shared: '敏感记忆会发送到此连接。' },
])('connected provider privacy in $locale', ({ locale, local, cloud, withheld, shared }) => {
  it.each([
    { baseUrl: 'http://localhost.:18441/v1', sendSensitiveToCloud: false },
    { baseUrl: 'http://localhost.:18441/v1', sendSensitiveToCloud: true },
    { baseUrl: 'http://[::ffff:127.0.0.1]:18441/v1', sendSensitiveToCloud: false },
    { baseUrl: 'http://[::ffff:127.0.0.1]:18441/v1', sendSensitiveToCloud: true },
    { baseUrl: 'https://models.example/v1', sendSensitiveToCloud: false },
  ])('marks a local provider at $baseUrl with sharing $sendSensitiveToCloud and no cloud note', ({ baseUrl, sendSensitiveToCloud }) => {
    const endpoint: ProviderView = { ...router, id: 'local', label: 'Local endpoint', baseUrl, hasApiKey: false, isLocal: true };
    storedSettings = applySettingsPatch(storedSettings, { memory: { sendSensitiveToCloud } });
    useSession.setState({ settings: storedSettings, providers: { items: [endpoint], defaultModel: null } });
    setup(locale);
    const row = screen.getByRole('listitem', { name: `Local endpoint ${local}` });
    expect(within(row).getByText(local)).toBeTruthy();
    expect(row.querySelector('[data-icon="monitor"][aria-hidden="true"]')).toBeTruthy();
    expect(within(row).getByText(appDictionaries[locale]['provider.saved_endpoint']!)).toBeTruthy();
    expect(within(row).queryByText(cloud)).toBeNull();
    expect(within(row).queryByText(withheld)).toBeNull();
    expect(within(row).queryByText(shared)).toBeNull();
    expect(row.getAttribute('aria-describedby')).toBeNull();
  });

  const cloudProviders: ProviderView[] = [
    provider,
    { ...router, label: 'Remote endpoint', hasApiKey: false },
    chatgpt,
    { ...provider, label: 'Disabled cloud', enabled: false },
    { ...chatgpt, label: 'Expired ChatGPT', needsReauthorization: true },
    { ...router, label: 'Cloud override', baseUrl: 'http://localhost.:18441/v1' },
  ];
  it.each(cloudProviders.flatMap((connection) => [false, true].map((sendSensitiveToCloud) => ({ connection, sendSensitiveToCloud }))))(
    'marks cloud provider $connection.label with sharing $sendSensitiveToCloud',
    ({ connection, sendSensitiveToCloud }) => {
      storedSettings = applySettingsPatch(storedSettings, { memory: { sendSensitiveToCloud } });
      useSession.setState({ settings: storedSettings, providers: { items: [connection], defaultModel: null } });
      setup(locale);
      const row = screen.getByRole('listitem', { name: `${connection.label} ${cloud}` });
      expect(within(row).getByText(cloud)).toBeTruthy();
      expect(row.querySelector('[data-icon="cloud"][aria-hidden="true"]')).toBeTruthy();
      const note = within(row).getByText(sendSensitiveToCloud ? shared : withheld);
      expect(row.getAttribute('aria-describedby')).toBe(note.id);
      expect(within(row).queryByText(sendSensitiveToCloud ? withheld : shared)).toBeNull();
      expect(within(row).queryByText(local)).toBeNull();
    },
  );

  it('updates only the cloud note when the session privacy setting changes', () => {
    const endpoint: ProviderView = { ...router, id: 'local', label: 'Local endpoint', isLocal: true };
    useSession.setState({ providers: { items: [endpoint, provider], defaultModel: null } });
    setup(locale);
    expect(within(screen.getByRole('listitem', { name: `${provider.label} ${cloud}` })).getByText(withheld)).toBeTruthy();
    act(() => { useSession.setState({ settings: applySettingsPatch(storedSettings, { memory: { sendSensitiveToCloud: true } }) }); });
    expect(within(screen.getByRole('listitem', { name: `${provider.label} ${cloud}` })).getByText(shared)).toBeTruthy();
    expect(screen.queryByText(withheld)).toBeNull();
    const localRow = screen.getByRole('listitem', { name: `Local endpoint ${local}` });
    expect(within(localRow).getByText(local)).toBeTruthy();
    expect(within(localRow).queryByText(shared)).toBeNull();
    act(() => { useSession.setState({ settings: storedSettings }); });
    expect(within(screen.getByRole('listitem', { name: `${provider.label} ${cloud}` })).getByText(withheld)).toBeTruthy();
    expect(screen.queryByText(shared)).toBeNull();
  });

  it('shows the cloud indicator without a privacy claim while settings are unavailable', () => {
    useSession.setState({ settings: null, providers: { items: [provider], defaultModel: null } });
    setup(locale);
    const row = screen.getByRole('listitem', { name: `${provider.label} ${cloud}` });
    expect(within(row).getByText(cloud)).toBeTruthy();
    expect(within(row).queryByText(withheld)).toBeNull();
    expect(within(row).queryByText(shared)).toBeNull();
    expect(row.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('OpenRouter sign-in waiting', () => {
  it('opens the host browser and resolves through polling without auto-continuing', async () => {
    vi.useFakeTimers();
    setup('en', true);
    await click('Sign in with OpenRouter');
    expect(openExternal).toHaveBeenCalledWith('https://openrouter.ai/auth?state=test-state');
    expect(screen.getByText('Waiting for OpenRouter…')).toBeTruthy();
    providerItems = [router];
    storedSettings = applySettingsPatch(storedSettings, { ai: { capabilities: { text: { provider: router.id, model: 'anthropic/claude-sonnet-5-5' } } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByText('Waiting for OpenRouter…')).toBeNull();
    expect(screen.getByText('OpenRouter is connected')).toBeTruthy();
    expect(screen.getByText('anthropic/claude-sonnet-5-5')).toBeTruthy();
    expect(client.auth.openrouterCancel).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('cancels server state and discards an in-flight polling response', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { items: ProviderView[]; defaultModel: null }) => void;
    client.providers.list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    setup();
    await click('Sign in with OpenRouter');
    await click('Cancel');
    expect(client.auth.openrouterCancel).toHaveBeenCalledWith('test-state');
    await act(async () => { resolve({ items: [router], defaultModel: null }); await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByText('OpenRouter is connected')).toBeNull();
    expect(useSession.getState().providers!.items).toEqual([]);
    expect(client.settings.get).not.toHaveBeenCalled();
  });

  it('expires waiting and allows a new sign-in', async () => {
    vi.useFakeTimers();
    client.auth.openrouterStart.mockResolvedValueOnce({ url: 'https://openrouter.ai/auth', state: 'expired-soon', expiresAt: Date.now() + 1000 });
    setup();
    await click('Sign in with OpenRouter');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('alert').textContent).toContain('The sign-in expired');
    expect(client.auth.openrouterCancel).toHaveBeenCalledWith('expired-soon');
    expect((screen.getByRole('button', { name: 'Sign in with OpenRouter' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('cancels a late start response after the active server changes', async () => {
    let resolve!: (value: { url: string; state: string; expiresAt: number }) => void;
    client.auth.openrouterStart.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    setup();
    await click('Sign in with OpenRouter');
    await act(async () => { useSession.setState({ sessionEpoch: 2 }); });
    await act(async () => { resolve({ url: 'https://openrouter.ai/auth', state: 'late-state', expiresAt: Date.now() + 600_000 }); });
    expect(client.auth.openrouterCancel).toHaveBeenCalledWith('late-state');
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByText('Waiting for OpenRouter…')).toBeNull();
  });

  it('cancels the state on unmount and when opening the browser fails', async () => {
    const first = setup();
    await click('Sign in with OpenRouter');
    first.unmount();
    expect(client.auth.openrouterCancel).toHaveBeenCalledWith('test-state');
    client.auth.openrouterCancel.mockClear();
    openExternal.mockImplementationOnce(() => { throw new Error('Could not open the browser'); });
    setup();
    await click('Sign in with OpenRouter');
    expect(client.auth.openrouterCancel).toHaveBeenCalledWith('test-state');
    expect(screen.getByRole('alert').textContent).toContain('Could not open the browser');
  });
});

describe('ChatGPT sign-in', () => {
  it.each(['en', 'zh-CN'] as const)('disables local callback sign-in for server mode in %s', (locale) => {
    useSession.setState((s) => ({ health: { ...s.health!, mode: 'server' } }));
    setup(locale);
    const t = appDictionaries[locale];
    const button = screen.getByRole('button', { name: t['provider.signin_chatgpt']! }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(t['provider.chatgpt_remote']!)).toBeTruthy();
    fireEvent.click(button);
    expect(client.auth.chatgptStart).not.toHaveBeenCalled();
  });

  it('waits for safe status then shows text-only defaults without continuing', async () => {
    vi.useFakeTimers();
    setup('en', true);
    await click('Sign in with ChatGPT');
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/api/accounts/authorize?state=chatgpt-state');
    expect(screen.getByText('Waiting for ChatGPT…')).toBeTruthy();
    expect(client.auth.chatgptStatus).toHaveBeenCalledWith('chatgpt-state');
    expect(client.providers.list).not.toHaveBeenCalled();
    providerItems = [chatgpt];
    storedSettings = applySettingsPatch(storedSettings, { ai: { capabilities: { text: { provider: chatgpt.id, model: 'gpt-5' } } } });
    client.auth.chatgptStatus.mockResolvedValue({ status: 'connected', provider: chatgpt });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText('ChatGPT is connected')).toBeTruthy();
    expect(screen.getByText('Local memory index')).toBeTruthy();
    expect(screen.getAllByText('Not configured')).toHaveLength(4);
    expect(onDone).not.toHaveBeenCalled();
    expect(client.auth.chatgptCancel).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh-CN'] as const)('shows needs-sign-in state and reconnects the same provider in %s', async (locale) => {
    vi.useFakeTimers();
    providerItems = [{ ...chatgpt, needsReauthorization: true }];
    useSession.setState({ providers: { items: providerItems, defaultModel: null } });
    setup(locale);
    const t = appDictionaries[locale];
    expect(screen.getByText(t['provider.chatgpt_disconnected']!)).toBeTruthy();
    await click(locale === 'en' ? 'Sign in to ChatGPT again' : '重新登录 ChatGPT');
    expect(client.auth.chatgptStart).toHaveBeenCalledWith('chatgpt');
    providerItems = [chatgpt];
    client.auth.chatgptStatus.mockResolvedValue({ status: 'connected', provider: chatgpt });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByText(t['provider.chatgpt_disconnected']!)).toBeNull();
    expect(screen.getByText(t['provider.saved_account']!)).toBeTruthy();
  });

  it.each(['en', 'zh-CN'] as const)('maps callback failure reasons to plan guidance in %s', async (locale) => {
    const reasons = [
      ['subscription_sharing_usage_limit_exceeded', 'provider.chatgpt_limit'],
      ['subscription_sharing_usage_unavailable', 'provider.chatgpt_unavailable'],
      ['subscription_sharing_user_not_eligible', 'provider.chatgpt_ineligible'],
      ['subscription_sharing_invalid_user', 'provider.chatgpt_disconnected'],
      ['invalid_grant', 'provider.chatgpt_disconnected'],
    ] as const;
    setup(locale);
    for (const [reason, key] of reasons) {
      client.auth.chatgptStatus.mockResolvedValueOnce({ status: 'failed', error: { code: 'provider_auth', message: 'Safe connection error', details: { reason } } });
      await click(appDictionaries[locale]['provider.signin_chatgpt']!);
      expect(screen.getByRole('alert').textContent).toBe(appDictionaries[locale][key]);
      expect((screen.getByRole('button', { name: appDictionaries[locale]['provider.signin_chatgpt']! }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('uses the same guidance for start errors', async () => {
    client.auth.chatgptStart.mockRejectedValueOnce(new NeoError('provider_auth', 'Safe connection error', { details: { reason: 'subscription_sharing_user_not_eligible' } }));
    setup();
    await click('Sign in with ChatGPT');
    expect(screen.getByRole('alert').textContent).toBe('Needs ChatGPT Plus or Pro.');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cancels and ignores an in-flight status response', async () => {
    let resolve!: (status: { status: 'connected'; provider: ProviderView }) => void;
    client.auth.chatgptStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    setup();
    await click('Sign in with ChatGPT');
    await click('Cancel');
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('chatgpt-state');
    await act(async () => { resolve({ status: 'connected', provider: chatgpt }); });
    expect(screen.queryByText('ChatGPT is connected')).toBeNull();
    expect(client.providers.list).not.toHaveBeenCalled();
    expect(client.settings.get).not.toHaveBeenCalled();
  });

  it('expires, cancels server state, and allows retry', async () => {
    vi.useFakeTimers();
    client.auth.chatgptStart.mockResolvedValueOnce({ url: 'https://auth.openai.com/api/accounts/authorize', state: 'chatgpt-state', expiresAt: Date.now() + 1000 });
    setup();
    await click('Sign in with ChatGPT');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('alert').textContent).toBe('The sign-in expired. Start again to connect ChatGPT.');
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('chatgpt-state');
  });

  it('cancels a late start after the active server changes', async () => {
    let resolve!: (value: { url: string; state: string; expiresAt: number }) => void;
    client.auth.chatgptStart.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    setup();
    await click('Sign in with ChatGPT');
    await act(async () => { useSession.setState({ sessionEpoch: 2 }); });
    await act(async () => { resolve({ url: 'https://auth.openai.com/api/accounts/authorize', state: 'late-state', expiresAt: Date.now() + 600_000 }); });
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('late-state');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cancels waiting on server change and unmount', async () => {
    const first = setup();
    await click('Sign in with ChatGPT');
    await act(async () => { useSession.setState({ sessionEpoch: 2 }); });
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('chatgpt-state');
    first.unmount();
    client.auth.chatgptCancel.mockClear();
    const second = setup();
    await click('Sign in with ChatGPT');
    second.unmount();
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('chatgpt-state');
  });

  it('cancels when opening the host browser fails', async () => {
    openExternal.mockImplementationOnce(() => { throw new Error('Could not open the browser'); });
    setup();
    await click('Sign in with ChatGPT');
    expect(client.auth.chatgptCancel).toHaveBeenCalledWith('chatgpt-state');
    expect(screen.getByRole('alert').textContent).toContain('Could not open the browser');
  });

  it('offers ChatGPT only for text capability in Advanced', async () => {
    providerItems = [provider, chatgpt];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    setup();
    for (const capability of AI_CAPABILITIES) {
      const name = appDictionaries.en[`provider.capability.${capability}`]!;
      const select = screen.getByRole('combobox', { name: `${name} service` });
      expect(within(select).queryByRole('option', { name: 'ChatGPT' }) !== null).toBe(capability === 'text');
    }
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Memory service' }), { target: { value: chatgpt.id } }); });
    expect(storedSettings.ai.capabilities.embedding).toBeNull();
  });

  it.each(['subscription_sharing_invalid_user', 'invalid_grant'])('shows immediate reauthorization after Advanced model discovery reports %s', async (reason) => {
    providerItems = [chatgpt];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    client.providers.models.mockImplementationOnce(async () => {
      providerItems = [{ ...chatgpt, needsReauthorization: true }];
      throw new NeoError('provider_auth', 'Disconnected; sign in again.', { details: { reason } });
    });
    setup();
    expect(await screen.findByText('Disconnected; sign in again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to ChatGPT again' })).toBeTruthy();
    expect(client.providers.list).toHaveBeenCalledOnce();
    expect(useSession.getState().providers?.items[0]?.needsReauthorization).toBe(true);
  });

  it('ignores a late reauthorization refresh after the active server changes', async () => {
    let resolve!: (value: { items: ProviderView[]; defaultModel: null }) => void;
    providerItems = [chatgpt];
    storedSettings = applySettingsPatch(storedSettings, { ai: { mode: 'advanced' } });
    useSession.setState({ settings: storedSettings, providers: { items: providerItems, defaultModel: null } });
    client.providers.models.mockRejectedValueOnce(new NeoError('provider_auth', 'Disconnected; sign in again.', { details: { reason: 'subscription_sharing_invalid_user' } }));
    client.providers.list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    setup();
    await screen.findByText('Disconnected; sign in again.');
    await act(async () => { useSession.setState({ sessionEpoch: 2, providers: { items: [], defaultModel: null } }); });
    await act(async () => { resolve({ items: [{ ...chatgpt, needsReauthorization: true }], defaultModel: null }); });
    expect(useSession.getState().providers?.items).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT again' })).toBeNull();
  });
});
