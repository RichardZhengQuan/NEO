import { useState, type ReactElement } from 'react';
import { Button, Modal, TextField, useT } from '@neo/ui';
import { fromDateInputValue, toDateInputValue } from '../../lib/time.js';
import { useSession } from '../../state/session.js';

export function JumpToDate({ onClose, onJump }: { onClose: () => void; onJump: (date: string) => Promise<void> }): ReactElement {
  const t = useT();
  const timezone = useSession((s) => s.settings?.timezone);
  const [date, setDate] = useState(() => toDateInputValue(Date.now(), timezone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const jump = async () => {
    const instant = fromDateInputValue(date, timezone, 0);
    if (instant === null) return;
    setBusy(true);
    setError(false);
    try { await onJump(new Date(instant).toISOString()); onClose(); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <Modal open title={t('timeline.jump_date')} onClose={onClose} footer={<Button variant="primary" disabled={!date} loading={busy} onClick={() => void jump()}>{t('timeline.jump')}</Button>}>
      <TextField type="date" label={t('timeline.date')} value={date} onChange={setDate} />
      {error && <p role="alert">{t('timeline.jump_error')}</p>}
    </Modal>
  );
}
