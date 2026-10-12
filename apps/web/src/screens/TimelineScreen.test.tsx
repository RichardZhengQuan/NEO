import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, applySettingsPatch, type ProviderView } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { navigate } from '../router.js';
import { emptyEntry, useTimeline } from '../state/timeline.js';
import { useSession } from '../state/session.js';
import { ProviderSetup } from '../components/ProviderSetup.js';
import { AiSection } from './settings/AiSection.js';
import { TimelineScreen } from './TimelineScreen.js';

vi.mock('../router.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../router.js')>(),
  navigate: vi.fn(),
}));

const provider: ProviderView = { id: 'ollama', kind: 'ollama', label: 'Local AI', defaultModel: 'local-model', enabled: true, hasApiKey: false, isLocal: true };
const testProvider: ProviderView = { id: 'test', kind: 'mock', label: 'Internal test provider', defaultModel: 'neo-test', enabled: true, hasApiKey: false, isLocal: true };

function renderTimeline(locale = 'en') {
  return render(<I18nProvider locale={locale} messages={appDictionaries}><ConfirmProvider><TimelineScreen /></ConfirmProvider></I18nProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ settings: DEFAULT_SETTINGS, providers: { items: [], defaultModel: null }, models: {}, client: null });
  useTimeline.setState({ ...emptyEntry(), loaded: true, offRecordLoaded: true }, true);
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);

describe('timeline without AI', () => {
  it.each([
    ['en', 'Connect an AI to start chatting', 'Open AI settings'],
    ['zh-CN', '连接 AI 后即可开始聊天', '打开 AI 设置'],
  ])('shows empty-chat and composer guidance in %s and opens Settings → AI', (locale, prompt, action) => {
    renderTimeline(locale);

    expect(screen.getByRole('heading', { name: prompt })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: prompt }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole('list', { name: /Things to try/ })).toBeNull();
    const buttons = screen.getAllByRole('button', { name: action });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(navigate).toHaveBeenCalledWith({ name: 'settings', section: 'ai' });
    expect(useTimeline.getState().messages).toEqual([]);
  });

  it.each([
    ['en', 'Hi, I’m NEO. What can I do for you?', 'Message NEO…'],
    ['zh-CN', '你好，我是 NEO。有什么可以帮你？', '给 NEO 发消息…'],
  ])('uses a fixed NEO greeting and name in %s', (locale, greeting, placeholder) => {
    const legacyPersona = { ...DEFAULT_SETTINGS.persona, name: 'Nova', greeting: 'A custom greeting', tagline: 'A custom tagline' };
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, persona: legacyPersona }, providers: { items: [provider], defaultModel: { provider: provider.id, model: provider.defaultModel! } } });
    renderTimeline(locale);

    expect(screen.getByRole('heading', { name: greeting })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'NEO' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(placeholder);
    expect(screen.queryByText('A custom greeting')).toBeNull();
    expect(screen.queryByText('A custom tagline')).toBeNull();
  });

  it('keeps an existing transcript visible while the composer asks to connect AI', () => {
    useTimeline.setState({ ...emptyEntry(), loaded: true, messages: [{ id: 'msg_1', episodeId: 'ep_1', conversationId: 'ep_1', role: 'user', parts: [{ type: 'text', text: 'My saved message' }], createdAt: 0, status: 'complete' }] });
    renderTimeline();

    expect(screen.getByText('My saved message')).toBeTruthy();
    expect(screen.getByText('Connect an AI to start chatting')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Connect an AI to start chatting' }) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI settings' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings', section: 'ai' });
    expect(useTimeline.getState().messages).toHaveLength(1);
  });

  it('becomes ready when an enabled provider connects and returns to guidance when disabled', () => {
    renderTimeline();
    act(() => useSession.setState({ providers: { items: [provider], defaultModel: { provider: provider.id, model: provider.defaultModel! } } }));

    expect(screen.queryByRole('heading', { name: 'Connect an AI to start chatting' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    act(() => useSession.setState({ providers: { items: [{ ...provider, enabled: false }], defaultModel: null } }));
    expect(screen.getByRole('heading', { name: 'Connect an AI to start chatting' })).toBeTruthy();
  });

  it('asks to connect AI until an incomplete provider has a usable selected model', () => {
    useSession.setState({ providers: { items: [{ ...provider, defaultModel: undefined }], defaultModel: null } });
    renderTimeline();
    expect(screen.getByRole('heading', { name: 'Connect an AI to start chatting' })).toBeTruthy();

    act(() => useSession.setState((state) => ({ settings: { ...state.settings!, ai: { ...state.settings!.ai, capabilities: { ...state.settings!.ai.capabilities, text: { provider: provider.id, model: 'selected-model' } } } } })));
    expect(screen.queryByRole('heading', { name: 'Connect an AI to start chatting' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('uses the authoritative Text assignment while the old default-model alias is stale', () => {
    const text = { provider: provider.id, model: 'local-model' };
    const canonical = applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { text } } });
    useSession.setState({ settings: { ...canonical, defaultModel: { provider: provider.id, model: 'legacy-model' } }, providers: { items: [{ ...provider, defaultModel: undefined }], defaultModel: null } });
    renderTimeline();
    expect(screen.queryByRole('heading', { name: 'Connect an AI to start chatting' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('option', { name: /legacy-model/ })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('never offers an internal mock provider in setup, settings or the model picker', () => {
    useSession.setState({ providers: { items: [testProvider], defaultModel: null }, settings: applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { text: { provider: 'test', model: 'neo-test' } } } }) });
    const setup = render(<I18nProvider locale="en" messages={appDictionaries}><ProviderSetup existing={[testProvider]} offerExisting onDone={vi.fn()} /></I18nProvider>);
    expect(screen.queryByText('Internal test provider')).toBeNull();
    expect(screen.queryByRole('button', { name: /Demo mode/ })).toBeNull();
    setup.unmount();

    const settings = render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><AiSection /></ConfirmProvider></I18nProvider>);
    expect(screen.queryByText('Internal test provider')).toBeNull();
    expect(screen.queryByRole('option', { name: /neo-test/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Already set up' })).toBeNull();
    settings.unmount();

    renderTimeline();
    expect(screen.getByRole('heading', { name: 'Connect an AI to start chatting' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /neo-test/ })).toBeNull();
  });
});
