import type { ReactElement } from 'react';
import { CircuitTraces, HazardStripes, PrintBadges, RingGauge, StackedTabs } from './PrintGraphics.js';

export function PrintBackdrop({ compact = false, badges = !compact, persistent = false, className }: { compact?: boolean; badges?: boolean; persistent?: boolean; className?: string }): ReactElement {
  return (
    <div className={['print-backdrop', compact && 'print-backdrop--compact', className].filter(Boolean).join(' ')} aria-hidden="true">
      <CircuitTraces />
      {(persistent || !compact) && <><RingGauge /><HazardStripes /></>}
      {(persistent || badges) && <PrintBadges visible={badges} />}
      <StackedTabs className="print-stage-tabs" />
    </div>
  );
}
