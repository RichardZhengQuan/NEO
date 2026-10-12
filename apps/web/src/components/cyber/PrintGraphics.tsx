import { useId, type ReactElement } from 'react';
import { Icon } from '@neo/ui';
import { useReducedMotion } from './useReducedMotion.js';

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** Offset rectangles are kept separate so the ink edges remain crisp. */
export function StackedTabs({ className }: { className?: string }): ReactElement {
  return (
    <div className={classes('print-tabs', className)} aria-hidden="true">
      <span /><span /><span />
    </div>
  );
}

/** Right-angle paths frame the stage without drawing through the figure. */
export function CircuitTraces({ className }: { className?: string }): ReactElement {
  return (
    <svg className={classes('print-traces', className)} viewBox="0 0 1200 800" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="1.25">
        <path vectorEffect="non-scaling-stroke" d="M24 166H94V84H310M1128 92H1022V156H958M1180 418H1116V520H1028M26 636H114V720H326" />
        <path className="print-traces-dashed" vectorEffect="non-scaling-stroke" strokeDasharray="4 7" d="M316 84H386M886 156H954M1028 520H968M332 720H414" />
      </g>
      <g className="print-traces-dots" fill="currentColor">
        <circle cx="24" cy="166" r="2.5" /><circle cx="1128" cy="92" r="2.5" />
        <circle cx="1180" cy="418" r="2.5" /><circle cx="26" cy="636" r="2.5" />
        <circle cx="386" cy="84" r="2.5" /><circle cx="886" cy="156" r="2.5" />
        <circle cx="968" cy="520" r="2.5" /><circle cx="414" cy="720" r="2.5" />
      </g>
    </svg>
  );
}

export function RingGauge({ className }: { className?: string }): ReactElement {
  const reducedMotion = useReducedMotion();
  const pathId = `print-ring-${useId().replace(/:/g, '')}`;
  return (
    <svg
      className={classes('print-ring-gauge', !reducedMotion && 'print-ring-gauge--animated', className)}
      viewBox="0 0 240 240"
      aria-hidden="true"
      focusable="false"
      data-motion={reducedMotion ? 'off' : 'on'}
    >
      <defs>
        <path id={pathId} d="M120 27a93 93 0 1 1 0 186a93 93 0 1 1 0-186" />
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="1.25">
        <circle cx="120" cy="120" r="110" strokeDasharray="125 22 56 18 125 22 56 267" transform="rotate(-90 120 120)" />
        <circle cx="120" cy="120" r="78" strokeDasharray="4 13" />
        <path d="M120 4v12M120 224v12M4 120h12M224 120h12" />
      </g>
      <text className="print-ring-label" fill="currentColor">
        <textPath href={`#${pathId}`} textLength="578" lengthAdjust="spacing">NEO · PERSONAL AI · v0.1 ·</textPath>
      </text>
    </svg>
  );
}

export function HazardStripes({ className }: { className?: string }): ReactElement {
  return (
    <div className={classes('print-hazards', className)} aria-hidden="true">
      <span className="print-hazard print-hazard--left" />
      <span className="print-hazard print-hazard--right" />
    </div>
  );
}

/** Small brand ornaments: existing line icons and original geometric shields. */
export function PrintBadges({ className, visible = true }: { className?: string; visible?: boolean }): ReactElement {
  return (
    <div className={classes('print-badges', className)} data-visible={visible} aria-hidden="true">
      {(['lock', 'brain', 'cpu'] as const).map((name, index) => (
        <span key={name} className={`print-pill print-pill--${index}`} aria-hidden="true"><Icon name={name} size={17} strokeWidth={1.5} /></span>
      ))}
      {[0, 1].map((index) => (
        <svg key={index} className={`print-shield print-shield--${index}`} viewBox="0 0 42 50" fill="none" aria-hidden="true" focusable="false">
          <path className="print-shield-border" d="M3 3h36v27L21 47 3 30Z" stroke="currentColor" strokeWidth="1.5" />
          {index === 0
            ? <path className="print-shield-glyph" d="m21 13 10 17H11Z" fill="currentColor" />
            : <path className="print-shield-glyph" d="m12 17 9 8 9-8M12 26l9 8 9-8" stroke="currentColor" strokeWidth="2" />}
        </svg>
      ))}
    </div>
  );
}
