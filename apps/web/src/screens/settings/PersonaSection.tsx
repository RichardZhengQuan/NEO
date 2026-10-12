/**
 * Settings → Avatar: choose the assistant's appearance.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { AvatarPicker, Button, useT } from '@neo/ui';
import { errorMessage } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { updateSettings, useSession } from '../../state/session.js';
import { Section } from './common.js';

export function AvatarSection(): ReactElement {
  const t = useT();
  const saved = useSession((s) => s.settings!.persona.avatar);
  const [avatar, setAvatar] = useState(saved);
  const [saving, setSaving] = useState(false);
  const dirty = avatar !== saved;

  useEffect(() => {
    if (!dirty) setAvatar(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateSettings({ persona: { avatar } });
      pushToast({ tone: 'success', title: t('avatarSettings.saved') });
    } catch (err) {
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={t('avatarSettings.title')}
      description={t('avatarSettings.help')}
      actions={
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          {t('common.save')}
        </Button>
      }
    >
      <div className="neo-card">
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>
    </Section>
  );
}
