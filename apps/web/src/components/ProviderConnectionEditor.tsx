/** Editing a saved connection belongs to Advanced; blank keys keep the secret. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ProviderView, UpdateProviderRequest } from '@neo/protocol';
import { Button, Modal, TextField, useT } from '@neo/ui';
import { errorMessage } from '../lib/errors.js';
import { currentSessionEpoch, isCurrentSession } from '../state/session.js';
import { providerLabel } from './ModelLabel.js';

export function ProviderConnectionEditor({ provider, onSave, onClose }: {
  provider: ProviderView;
  onSave: (patch: UpdateProviderRequest) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const t = useT();
  const [label, setLabel] = useState(provider.label ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async () => {
    const epoch = currentSessionEpoch();
    setSaving(true);
    setError(null);
    try {
      await onSave({ label: label.trim() || provider.label, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    } catch (err) {
      if (mounted.current && isCurrentSession(epoch)) setError(errorMessage(err, t));
    } finally {
      if (mounted.current && isCurrentSession(epoch)) setSaving(false);
    }
  };
  return (
    <Modal open title={t('provider.edit_connection', { name: providerLabel(provider) })} onClose={() => { if (!saving) onClose(); }} footer={<><Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => void save()} loading={saving}>{t('common.save')}</Button></>}>
      <div className="ai-setup__section">
        <TextField label={t('provider.connection_name')} value={label} onChange={setLabel} maxLength={100} disabled={saving} />
        {(provider.kind === 'ollama' || provider.kind === 'openai-compatible' || provider.baseUrl) && <TextField label={t('provider.base_url')} value={baseUrl} onChange={setBaseUrl} type="url" spellCheck={false} disabled={saving} />}
        {provider.kind !== 'chatgpt' && <TextField label={t('provider.replace_key')} value={apiKey} onChange={setApiKey} type="password" autoComplete="off" spellCheck={false} help={t('provider.replace_key_help')} disabled={saving} />}
        {error && <p className="neo-error-text" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
