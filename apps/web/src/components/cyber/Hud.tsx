import type { ReactElement } from 'react';

export function Hud({ step, className }: { step?: string; className?: string }): ReactElement {
  return (
    <div className={['cyber-hud', className].filter(Boolean).join(' ')} aria-hidden="true">
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => <span key={corner} className={`cyber-hud-corner cyber-hud-corner--${corner}`} />)}
      {/* These mono brand identifiers intentionally stay untranslated. */}
      <span className="cyber-hud-brand">NEO://PERSONAL_AI v0.1</span>
      <span className="cyber-hud-status">PERSONAL AI · v0.1</span>
      {step && <span className="cyber-hud-step">{step}</span>}
    </div>
  );
}
