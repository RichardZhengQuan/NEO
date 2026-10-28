/**
 * Every string the app asks for exists in English and Simplified Chinese.
 */
import { describe, expect, it } from 'vitest';
import { buildMessages, createTranslator, dictionaries } from '@neo/ui';
import { AI_CAPABILITIES } from '@neo/protocol';
import { appDictionaries } from './i18n.js';
import { describeRecurrence } from './lib/recurrence.js';

const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Keys built at runtime from a prefix + a known set of values. */
const DYNAMIC: Record<string, readonly string[]> = {
  'ai.reasoning_': ['off', 'low', 'medium', 'high'],
  'ai.search_': ['auto', 'engine', 'off'],
  'chat.risk.': ['read', 'write', 'external', 'dangerous'],
  'chat.suggestion.': ['remind', 'remember', 'dashboard', 'tasks'],
  'dataSettings.mode_': ['local', 'server'],
  'dataSettings.source_': ['desktop', 'pair', 'saved', 'manual'],
  'devices.platform_': ['web', 'desktop', 'ios', 'android', 'cli', 'other'],
  'edge.': ['related', 'about', 'mentions', 'part_of', 'derived_from', 'supersedes', 'contradicts', 'precedes', 'causes', 'similar'],
  'journal.count_': ['factsCreated', 'episodesConsolidated', 'linksCreated', 'entitiesMerged', 'archived', 'edgesPruned'],
  'language.': ['auto', 'en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'it', 'ru'],
  'memory.kind.': ['episode', 'fact', 'entity', 'preference', 'skill', 'goal', 'summary'],
  'memory.status.': ['active', 'archived', 'superseded'],
  'memoryList.sort_': ['recent', 'importance', 'strength', 'relevance'],
  'memoryList.status_': ['active', 'archived', 'superseded', 'all'],
  'memoryScreen.tab_': ['net', 'list', 'journal', 'stats', 'data'],
  'nav.': ['timeline', 'memory', 'reminders', 'tasks', 'notes', 'settings'],
  'notify.': ['browser.title', 'browser.text', 'browser.denied', 'electron.title', 'electron.text', 'electron.denied', 'capacitor.title', 'capacitor.text', 'capacitor.denied'],
  'notify.reason.': ['insecure-context', 'no-vapid', 'ios-install', 'unsupported'],
  'provider.': ['anthropic', 'openai', 'gemini', 'openrouter'].map((k) => `${k}.label`),
  'provider.capability.': AI_CAPABILITIES,
  'provider.capability_help.': AI_CAPABILITIES,
  'reminders.repeat_': ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'],
  'settings.': ['ai', 'avatar', 'memory', 'tools', 'devices', 'notifications', 'appearance', 'data'],
  'source.': ['user', 'assistant', 'extraction', 'consolidation', 'import', 'tool'],
  'status.': ['idle', 'connecting', 'open', 'reconnecting', 'closed'],
  'tasks.priority_': ['0', '1', '2', '3'],
  'toolsSettings.risk_': ['read', 'write', 'external', 'dangerous'],
};

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) keys.add(m[1]!);
  }
  for (const [prefix, values] of Object.entries(DYNAMIC)) for (const v of values) keys.add(prefix + v);
  return keys;
}

describe('app dictionaries', () => {
  it('finds the app sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it.each(['en', 'zh-CN'])('%s has every key the app uses', (locale) => {
    const messages = buildMessages(locale, appDictionaries);
    const missing = [...usedKeys()].filter((k) => messages[k] === undefined && messages[`${k}_other`] === undefined);
    expect(missing).toEqual([]);
  });

  it('Chinese covers every English app string (plural variants aside)', () => {
    const zh = appDictionaries['zh-CN'];
    const missing = Object.keys(appDictionaries.en).filter((k) => !(k in zh) && !/_(one|other)$/.test(k));
    expect(missing).toEqual([]);
  });

  it('Chinese covers every English plural base for its plural categories', () => {
    const en = appDictionaries.en;
    const zh = appDictionaries['zh-CN'];
    const bases = [...new Set(Object.keys(en)
      .filter((key) => /_(one|other)$/.test(key))
      .map((key) => key.replace(/_(one|other)$/, '')))];
    const categories = new Intl.PluralRules('zh-CN').resolvedOptions().pluralCategories;
    const missing = bases.flatMap((base) => categories
      .filter((category) => zh[`${base}_${category}`] === undefined && zh[`${base}_other`] === undefined)
      .map((category) => `${base}_${category}`));
    // Check the raw Chinese dictionary: buildMessages would hide gaps with English.
    expect(missing).toEqual([]);
  });

  it.each([
    ['toast.snoozed', '已推迟 {n} 分钟'],
    ['memoryList.count', '共 {n} 条记忆'],
    ['memoryDetail.days', '{n} 天'],
    ['memoryDetail.links', '{n} 条关联'],
    ['memoryDetail.coactivations', '一起被想起 {n} 次'],
    ['journal.count_factsCreated', '新领悟 {n} 条'],
    ['journal.count_episodesConsolidated', '消化经历 {n} 段'],
    ['journal.count_linksCreated', '新关联 {n} 条'],
    ['journal.count_entitiesMerged', '合并 {n} 处'],
    ['journal.count_archived', '淡去 {n} 条'],
    ['journal.count_edgesPruned', '清理弱关联 {n} 条'],
    ['memoryData.exported', '已导出 {n} 条记忆'],
    ['memoryData.forget_selected', '忘掉 {n} 条记忆'],
    ['memoryData.forget_confirm', '{n} 条记忆将被永久删除。'],
    ['memoryData.forgotten', '已忘掉 {n} 条记忆'],
    ['recur.count', '共 {n} 次'],
    ['ai.minutes', '{n} 分钟'],
    ['memorySettings.hours', '每 {n} 小时'],
  ])('localizes %s for Chinese counts of 1 and 5', (key, expected) => {
    const t = createTranslator('zh-CN', buildMessages('zh-CN', appDictionaries));
    for (const n of [1, 5]) expect(t(key, { n })).toBe(expected.replace('{n}', String(n)));
  });

  it.each([
    ['hourly', '每 2 小时'],
    ['daily', '每 2 天'],
    ['weekly', '每 2 周'],
    ['monthly', '每 2 个月'],
    ['yearly', '每 2 年'],
  ] as const)('localizes the repeat count in a Chinese %s recurrence summary', (freq, expected) => {
    const t = createTranslator('zh-CN', buildMessages('zh-CN', appDictionaries));
    expect(describeRecurrence({ freq, interval: 2, count: 5 }, t, 'zh-CN')).toBe(`${expected} · 共 5 次`);
  });

  it('has no removed persona or trait settings keys', () => {
    for (const dictionary of Object.values(appDictionaries)) {
      expect(Object.keys(dictionary).filter((key) => /(?:^|[.])persona(?:[.]|$)|^personaSettings[.]|^trait[.]/.test(key))).toEqual([]);
    }
  });

  it('Chinese is actually translated (no English left in zh-CN where en differs)', () => {
    const zh = appDictionaries['zh-CN'];
    const untranslated = Object.entries(zh).filter(([k, v]) => /[a-z]{4,}\s[a-z]{4,}\s[a-z]{4,}/i.test(v) && !k.startsWith('language.') && !k.startsWith('provider.') && v === appDictionaries.en[k]);
    expect(untranslated).toEqual([]);
  });

  it('placeholders match between languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const zh = { ...dictionaries['zh-CN'], ...appDictionaries['zh-CN'] };
    const en = { ...dictionaries.en, ...appDictionaries.en };
    const mismatched = Object.keys(zh).filter((k) => en[k] !== undefined && vars(en[k]!) !== vars(zh[k]!) && !(k === 'memorySettings.hours_one'));
    expect(mismatched).toEqual([]);
  });
});
