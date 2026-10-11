import type { ReactElement } from 'react';
import { useT } from '@neo/ui';
import { useSession } from '../state/session.js';

/** Live-connection indicator (green open, amber connecting, red closed). */
export function StatusDot(): ReactElement {
  const t = useT();
  const status = useSession((s) => s.wsStatus);
  const label = t(`status.${status}`);
  return <span className="status-dot" data-status={status} role="img" aria-label={label} title={label} />;
}
