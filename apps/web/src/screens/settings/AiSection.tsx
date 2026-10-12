/** Settings → AI connections, capability models, and agent behaviour. */
import type { ReactElement } from 'react';
import type { AgentSettings } from '@neo/protocol';
import { SegmentedControl, Select, useT } from '@neo/ui';
import { ProviderSetup } from '../../components/ProviderSetup.js';
import { errorMessage } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { updateSettings, useSession } from '../../state/session.js';
import { Section, SettingRow } from './common.js';

export function AiSection(): ReactElement {
  const t = useT();
  const providers = useSession((s) => s.providers);
  const settings = useSession((s) => s.settings!);
  const setAgent = async (patch: Partial<AgentSettings>) => {
    try { await updateSettings({ agent: patch }); }
    catch (err) { pushToast({ tone: 'error', title: errorMessage(err, t) }); }
  };

  return (
    <>
      <Section title={t('ai.connections')} description={t('ai.connections_help')}>
        <ProviderSetup existing={providers?.items ?? []} onDone={() => undefined} />
      </Section>
      <Section title={t('ai.behaviour')} description={t('ai.behaviour_help')}>
        <div className="neo-card">
          <SettingRow label={t('ai.reasoning')} help={t('ai.reasoning_help')} stack>
            <SegmentedControl label={t('ai.reasoning')} value={settings.agent.reasoning} onChange={(v) => void setAgent({ reasoning: v })} options={(['off', 'low', 'medium', 'high'] as const).map((v) => ({ value: v, label: t(`ai.reasoning_${v}`) }))} />
          </SettingRow>
          <SettingRow label={t('ai.max_steps')} help={t('ai.max_steps_help')}>
            <Select size="sm" ariaLabel={t('ai.max_steps')} value={String(settings.agent.maxSteps)} onChange={(v) => void setAgent({ maxSteps: Number(v) })} options={[4, 8, 12, 16, 24, 32].map((n) => ({ value: String(n), label: String(n) }))} />
          </SettingRow>
          <SettingRow label={t('ai.confirm_timeout')} help={t('ai.confirm_timeout_help')}>
            <Select size="sm" ariaLabel={t('ai.confirm_timeout')} value={String(settings.agent.confirmationTimeoutSec)} onChange={(v) => void setAgent({ confirmationTimeoutSec: Number(v) })} options={[60, 120, 300, 900, 3600].map((s) => ({ value: String(s), label: t('ai.minutes', { n: Math.round(s / 60) }) }))} />
          </SettingRow>

        </div>
      </Section>
    </>
  );
}
