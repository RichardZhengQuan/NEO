import { describe, expect, it } from 'vitest';
import { AI_CAPABILITIES, detectApiKeyProvider, modelSupportsCapability, pickDefaultCapabilities, resolveSearchMode } from './ai.js';
import { DEFAULT_SETTINGS, NeoSettingsSchema, applySettingsPatch, deepMerge, migrateSettings } from './config.js';
import { DEFAULT_CAPABILITIES, OPENROUTER_PRESET, type ModelCapabilities, type ModelInfo } from './providers.js';

function model(id: string, capabilities: Partial<ModelCapabilities> = {}): ModelInfo {
  return { id, provider: 'test', capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities } };
}

describe('API key detection', () => {
  it.each([
    ['sk-ant-api03-secret', 'anthropic'],
    ['sk-or-v1-secret', 'openrouter'],
    ['AIza-secret', 'gemini'],
    ['sk-proj-secret', 'openai'],
    ['sk-svcacct-secret', 'openai'],
    ['sk-secret', 'openai'],
    ['  sk-ant-secret\n', 'anthropic'],
    ['', 'unknown'],
    ['custom-key', 'unknown'],
    ['SK-ant-secret', 'unknown'],
  ])('detects %s as %s', (key, provider) => {
    expect(detectApiKeyProvider(key)).toBe(provider);
  });
});

describe('capability defaults from available models', () => {
  it('prefers Claude Sonnet 5.5 for Text and leaves unsupported slots empty', () => {
    const picks = pickDefaultCapabilities({ id: 'claude', kind: 'anthropic' }, [
      model('claude-opus-5-5'), model('claude-haiku-5-5'), model('claude-sonnet-5-5'), model('claude-fable-5-1'),
    ]);
    expect(picks.text).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
    for (const capability of AI_CAPABILITIES.filter(c => c !== 'text')) expect(picks[capability]).toBeNull();
  });

  it('chooses the newest general GPT and the economical embedding model', () => {
    const picks = pickDefaultCapabilities({ id: 'openai', kind: 'openai' }, [
      model('gpt-5'), model('gpt-5.2'), model('gpt-5.4-mini'),
      model('text-embedding-3-large', { tools: false, embeddings: true }),
      model('text-embedding-3-small', { tools: false, embeddings: true }),
    ]);
    expect(picks.text?.model).toBe('gpt-5.2');
    expect(picks.embedding?.model).toBe('text-embedding-3-small');
  });

  it('assigns only the best listed Text model for a ChatGPT plan', () => {
    const picks = pickDefaultCapabilities({ id: 'chatgpt', kind: 'chatgpt' }, [
      model('gpt-5'), model('gpt-5.2'), model('gpt-5.4-mini'),
      model('other', { embeddings: true, speechToText: true, textToSpeech: true, image: true, video: true }),
    ]);
    expect(picks.text).toEqual({ provider: 'chatgpt', model: 'gpt-5.2' });
    for (const capability of AI_CAPABILITIES.filter(c => c !== 'text')) expect(picks[capability]).toBeNull();
  });

  it('chooses the newest Gemini generation and available embedding model', () => {
    const picks = pickDefaultCapabilities({ id: 'gemini', kind: 'gemini' }, [
      model('gemini-2.5-pro'), model('gemini-3-pro'), model('gemini-3-flash'),
      model('gemini-embedding-001', { text: false, tools: false, embeddings: true }),
    ]);
    expect(picks.text?.model).toBe('gemini-3-pro');
    expect(picks.embedding?.model).toBe('gemini-embedding-001');
  });

  it('identifies OpenRouter without introducing a new adapter kind', () => {
    const picks = pickDefaultCapabilities({ id: 'router', kind: OPENROUTER_PRESET.kind, baseUrl: OPENROUTER_PRESET.baseUrl }, [
      model('openai/gpt-5'), model('anthropic/claude-sonnet-5-5'),
    ]);
    expect(picks.text).toEqual({ provider: 'router', model: 'anthropic/claude-sonnet-5-5' });
  });

  it('never assigns a model that was absent from the list', () => {
    const models = [model('claude-new-model')];
    const picks = pickDefaultCapabilities({ id: 'claude', kind: 'anthropic' }, models);
    expect(picks.text?.model).toBe('claude-new-model');
    expect(pickDefaultCapabilities({ id: 'claude', kind: 'anthropic' }, [])).toEqual(
      Object.fromEntries(AI_CAPABILITIES.map(c => [c, null])),
    );
  });

  it('assigns future modalities only when metadata explicitly offers them', () => {
    const picks = pickDefaultCapabilities({ id: 'custom', kind: 'openai-compatible' }, [
      model('chat'),
      model('audio-in', { text: false, tools: false, speechToText: true }),
      model('audio-out', { text: false, tools: false, textToSpeech: true }),
      model('image-gen', { text: false, tools: false, image: true }),
      model('video-gen', { text: false, tools: false, video: true }),
    ]);
    expect(picks.text?.model).toBe('chat');
    expect(picks.speechToText?.model).toBe('audio-in');
    expect(picks.textToSpeech?.model).toBe('audio-out');
    expect(picks.image?.model).toBe('image-gen');
    expect(picks.video?.model).toBe('video-gen');
  });

  it('retains old custom chat listings but excludes dedicated embeddings', () => {
    expect(modelSupportsCapability(model('local-chat'), 'text')).toBe(true);
    expect(modelSupportsCapability(model('embed', { embeddings: true, tools: false }), 'text')).toBe(false);
    expect(modelSupportsCapability(model('unknown-audio'), 'textToSpeech')).toBe(false);
  });
});

describe('AI settings compatibility', () => {
  const text = { provider: 'claude', model: 'claude-sonnet-5-5' };
  const embedding = { provider: 'openai', model: 'text-embedding-3-small' };

  it('migrates an old settings blob and mirrors the canonical assignments', () => {
    const old = { defaultModel: text, memoryModel: { provider: 'other', model: 'other-model' }, embedding, locale: 'zh' };
    const parsed = NeoSettingsSchema.parse(old);
    expect(parsed.ai).toEqual({ mode: 'simple', search: { mode: 'auto', engine: null }, capabilities: { text, embedding, speechToText: null, textToSpeech: null, image: null, video: null } });
    expect(parsed.memoryModel).toEqual(text);
    expect(parsed.defaultModel).toEqual(text);
    expect(parsed.embedding).toEqual(embedding);
    expect(parsed.locale).toBe('zh');
  });

  it('migrates before current defaults can obscure an old document', () => {
    const parsed = NeoSettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, migrateSettings({ defaultModel: text, embedding })));
    expect(parsed.ai.capabilities.text).toEqual(text);
    expect(parsed.ai.capabilities.embedding).toEqual(embedding);
  });

  it('uses legacy memoryModel as Text when there was no chat default', () => {
    expect(NeoSettingsSchema.parse({ memoryModel: text }).ai.capabilities.text).toEqual(text);
  });

  it('does not erase caller defaults when the database has no legacy model fields', () => {
    const defaults = applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { text } } });
    const parsed = NeoSettingsSchema.parse(deepMerge(defaults, migrateSettings({ locale: 'zh' })));
    expect(parsed.ai.capabilities.text).toEqual(text);
    expect(parsed.locale).toBe('zh');
  });

  it('respects explicit null assignments instead of reviving stale legacy refs', () => {
    const parsed = NeoSettingsSchema.parse({ ai: { capabilities: { text: null } }, defaultModel: text, embedding });
    expect(parsed.defaultModel).toBeNull();
    expect(parsed.embedding).toBeNull();
  });

  it('accepts old clients patches and retains other capability assignments', () => {
    const base = applySettingsPatch(DEFAULT_SETTINGS, { ai: { mode: 'advanced', capabilities: { image: text } } });
    const updated = applySettingsPatch(base, { defaultModel: text, embedding });
    expect(updated.ai.mode).toBe('advanced');
    expect(updated.ai.capabilities).toMatchObject({ text, embedding, image: text });
    expect(updated.memoryModel).toEqual(text);
    expect(applySettingsPatch(updated, { memoryModel: null }).ai.capabilities.text).toEqual(text);
    expect(applySettingsPatch(updated, { defaultModel: null }).ai.capabilities.text).toBeNull();
  });

  it('makes new settings authoritative when clients send both shapes', () => {
    const updated = applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { text } }, defaultModel: { provider: 'stale', model: 'stale' } });
    expect(updated.defaultModel).toEqual(text);
    expect(updated.memoryModel).toEqual(text);
  });

  it('validates every reserved capability now', () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { video: { provider: '', model: '' } } } })).toThrow();
  });

  it('coerces an invalid stored timezone to UTC instead of wiping all settings', () => {
    const stored = { locale: 'zh', timezone: 'Not/A_Zone' };
    const parsed = NeoSettingsSchema.safeParse(deepMerge(DEFAULT_SETTINGS, migrateSettings(stored)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timezone).toBe('UTC');
      expect(parsed.data.locale).toBe('zh');
    }
  });
});

describe('search mode resolution', () => {
  it('replaces endpoint-specific settings when switching engine providers', () => {
    const base = applySettingsPatch(DEFAULT_SETTINGS, { ai: { search: { engine: { provider: 'searxng', baseUrl: 'https://search.example' } } } });
    expect(applySettingsPatch(base, { ai: { search: { engine: { provider: 'brave' } } } }).ai.search.engine).toEqual({ provider: 'brave' });
  });
  it.each([
    ['auto', true, true, 'native'], ['auto', true, false, 'native'],
    ['auto', false, true, 'engine'], ['auto', false, false, 'off'],
    ['engine', true, true, 'engine'], ['engine', true, false, 'off'],
    ['off', true, true, 'off'], ['off', false, false, 'off'],
  ] as const)('%s with native=%s and engine=%s resolves to %s', (mode, native, engine, expected) => {
    expect(resolveSearchMode({ mode, engine: null }, native, engine)).toBe(expected);
  });
});
