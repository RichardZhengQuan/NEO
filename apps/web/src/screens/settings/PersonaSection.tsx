/**
 * Settings → Persona: the avatar, name, voice and standing instructions.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { Persona } from '@neo/protocol';
import { Button, NeoAvatar, TextField, useT } from '@neo/ui';
import { errorMessage } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { updateSettings, useSession } from '../../state/session.js';
import { PersonaFields } from '../OnboardingScreen.js';
import { Section } from './common.js';

export function PersonaSection(): ReactElement {
  const t = useT();
  const saved = useSession((s) => s.settings!.persona);
  const [persona, setPersona] = useState<Persona>(saved);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(persona) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) setPersona(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const save = async () => {
    if (!persona.name.trim()) return;
    setSaving(true);
    try {
      await updateSettings({ persona: { ...persona, name: persona.name.trim(), greeting: persona.greeting?.trim() || null } });
      pushToast({ tone: 'success', title: t('personaSettings.saved') });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={t('personaSettings.title')}
      description={t('personaSettings.help')}
      actions={
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setPersona(saved)}>
              {t('common.reset')}
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || !persona.name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="neo-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <NeoAvatar avatar={persona.avatar} size={64} shape="squircle" state="idle" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{persona.name || 'NEO'}</div>
          <div className="neo-help">{persona.tagline}</div>
        </div>
      </div>
      <div className="neo-card">
        <PersonaFields persona={persona} onChange={setPersona} />
        <div style={{ marginTop: '1.125rem' }}>
          <TextField label={t('persona.greeting')} value={persona.greeting ?? ''} onChange={(v) => setPersona({ ...persona, greeting: v })} maxLength={500} placeholder={t('chat.greeting', { name: persona.name || 'NEO' })} help={t('persona.greeting_help')} />
        </div>
      </div>
    </Section>
  );
}
