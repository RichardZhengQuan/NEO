import { describe, expect, it } from 'vitest';
import { NeoError } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { errorMessage } from './errors.js';

describe('ChatGPT plan error guidance', () => {
  it.each(['en', 'zh-CN'] as const)('translates typed plan errors in %s', (locale) => {
    const t = createTranslator(locale, buildMessages(locale, appDictionaries));
    const reasons = [
      ['subscription_sharing_usage_limit_exceeded', 'provider.chatgpt_limit'],
      ['subscription_sharing_usage_unavailable', 'provider.chatgpt_unavailable'],
      ['subscription_sharing_user_not_eligible', 'provider.chatgpt_ineligible'],
      ['subscription_sharing_invalid_user', 'provider.chatgpt_disconnected'],
      ['invalid_grant', 'provider.chatgpt_disconnected'],
    ] as const;
    for (const [reason, key] of reasons) {
      const error = new NeoError(reason === 'subscription_sharing_usage_limit_exceeded' ? 'rate_limited' : 'provider_auth', 'Safe upstream error', { details: { reason } });
      expect(errorMessage(error, t)).toBe(appDictionaries[locale][key]);
      expect(errorMessage(error.toJSON(), t)).toBe(appDictionaries[locale][key]);
    }
  });

  it('retains ordinary error messages', () => {
    const t = createTranslator('en', buildMessages('en', appDictionaries));
    expect(errorMessage(new NeoError('provider_error', 'Models are unavailable'), t)).toBe('Models are unavailable');
  });
});
