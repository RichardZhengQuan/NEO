/**
 * Settings → Memory: what NEO may remember and how (mode, recall, blocked
 * topics, kinds, episodes, sensitive memories, consolidation).
 */
import type { ReactElement } from 'react';
import { MEMORY_KINDS, type MemoryPolicy, type NeoSettingsPatch } from '@neo/protocol';
import { Button, Chip, Icon, Select, Switch, useT } from '@neo/ui';
import { openLink } from '../../actions/links.js';
import { ChipInput } from '../../components/ChipInput.js';
import { errorMessage } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { updateSettings, useSession } from '../../state/session.js';
import { BLOCKED_SUGGESTIONS } from '../OnboardingScreen.js';
import { Section, SettingRow } from './common.js';

const MODE_ICON: Record<MemoryPolicy['mode'], string> = { auto: 'sparkles', approve: 'check-square', off: 'eye-off' };

export function MemorySection(): ReactElement {
  const t = useT();
  const policy = useSession((s) => s.settings!.memory);
  const save = (patch: NonNullable<NeoSettingsPatch['memory']>) => {
    updateSettings({ memory: patch }).catch((err) => pushToast({ tone: 'error', title: errorMessage(err, t) }));
  };
  return (
    <>
      <Section
        title={t('memorySettings.mode')}
        description={t('memorySettings.mode_help')}
        actions={
          <Button size="sm" variant="secondary" icon="brain" onClick={() => openLink('neo://memory')}>
            {t('memorySettings.open')}
          </Button>
        }
      >
        <div role="radiogroup" aria-label={t('memorySettings.mode')} style={{ display: 'grid', gap: '0.5rem' }}>
          {(['auto', 'approve', 'off'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={policy.mode === m} className="option-card" onClick={() => save({ mode: m })}>
              <span className="option-card__icon">
                <Icon name={MODE_ICON[m]} size={18} />
              </span>
              <span style={{ flex: 1 }}>
                <span className="option-card__title">{t(`memoryMode.${m}.title`)}</span>
                <span className="option-card__text">{t(`memoryMode.${m}.text`)}</span>
              </span>
              {policy.mode === m && <Icon name="check" size={16} className="option-check" />}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('memorySettings.privacy')} description={t('memorySettings.privacy_help')}>
        <div className="neo-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <ChipInput
            label={t('memoryPolicy.blocked')}
            values={policy.blockedTopics}
            onChange={(v) => save({ blockedTopics: v })}
            placeholder={t('memoryPolicy.blocked_placeholder')}
            suggestions={BLOCKED_SUGGESTIONS.map((k) => t(`topic.${k}`))}
            help={t('memoryPolicy.blocked_help')}
            max={50}
            maxLength={100}
          />
          <Switch checked={policy.sendSensitiveToCloud} onChange={(v) => save({ sendSensitiveToCloud: v })} label={t('memoryPolicy.sensitive_cloud')} description={t('memoryPolicy.sensitive_cloud_help')} />
          <div className="neo-field">
            <span className="neo-label">{t('memorySettings.kinds')}</span>
            <div className="neo-tags" role="group" aria-label={t('memorySettings.kinds')}>
              {MEMORY_KINDS.map((k) => {
                const on = policy.allowedKinds.includes(k);
                return (
                  <Chip key={k} size="sm" pressed={on} onClick={() => save({ allowedKinds: on ? policy.allowedKinds.filter((x) => x !== k) : [...policy.allowedKinds, k] })}>
                    <span className="neo-kind-dot" data-kind={k} />
                    {t(`memory.kind.${k}`)}
                  </Chip>
                );
              })}
            </div>
            <p className="neo-help" style={{ margin: 0 }}>
              {t('memorySettings.kinds_help')}
            </p>
          </div>
        </div>
      </Section>

      <Section title={t('memorySettings.recall')} description={t('memorySettings.recall_help')}>
        <div className="neo-card">
          <SettingRow label={t('memorySettings.recall_on')} help={t('memorySettings.recall_on_help')}>
            <Switch checked={policy.recall} onChange={(v) => save({ recall: v })} ariaLabel={t('memorySettings.recall_on')} />
          </SettingRow>
          <SettingRow label={t('memorySettings.recall_limit')} help={t('memorySettings.recall_limit_help')}>
            <Select size="sm" ariaLabel={t('memorySettings.recall_limit')} value={String(policy.recallLimit)} onChange={(v) => save({ recallLimit: Number(v) })} options={[4, 8, 12, 16, 24, 32].map((n) => ({ value: String(n), label: String(n) }))} />
          </SettingRow>
          <SettingRow label={t('memorySettings.episodes')} help={t('memorySettings.episodes_help')}>
            <Switch checked={policy.storeEpisodes} onChange={(v) => save({ storeEpisodes: v })} ariaLabel={t('memorySettings.episodes')} />
          </SettingRow>
        </div>
      </Section>

      <Section title={t('memorySettings.consolidation')} description={t('memorySettings.consolidation_help')}>
        <div className="neo-card">
          <SettingRow label={t('memorySettings.consolidation_on')}>
            <Switch checked={policy.consolidation.enabled} onChange={(v) => save({ consolidation: { enabled: v } })} ariaLabel={t('memorySettings.consolidation_on')} />
          </SettingRow>
          <SettingRow label={t('memorySettings.interval')}>
            <Select
              size="sm"
              ariaLabel={t('memorySettings.interval')}
              value={String(policy.consolidation.intervalHours)}
              disabled={!policy.consolidation.enabled}
              onChange={(v) => save({ consolidation: { intervalHours: Number(v) } })}
              options={[1, 3, 6, 12, 24, 168].map((h) => ({ value: String(h), label: h === 168 ? t('memorySettings.weekly') : t('memorySettings.hours', { n: h }) }))}
            />
          </SettingRow>
        </div>
      </Section>
    </>
  );
}
