import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useReducedMotion } from './useReducedMotion.js';

const CHARACTER_DELAY_MS = 45;
const BACKSPACE_MS = 90;
const STEP_TYPING_MS = 450;

/** The accessible line stays complete while its decorative copy types. */
export function TerminalLine({ text, className, animateOnMount = true }: {
  text: string;
  className?: string;
  animateOnMount?: boolean;
}): ReactElement {
  const reducedMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(reducedMotion || !animateOnMount ? text : '');
  const visible = useRef(displayed);
  const sequence = useRef({ text, stepChange: false, settled: reducedMotion || !animateOnMount });

  useEffect(() => {
    if (sequence.current.text !== text) sequence.current = { text, stepChange: true, settled: false };
    const show = (value: string) => { visible.current = value; setDisplayed(value); };
    if (reducedMotion || sequence.current.settled) {
      sequence.current.settled = true;
      show(text);
      return;
    }

    let timer: number | undefined;
    const type = () => {
      show('');
      if (text.length === 0) { sequence.current.settled = true; return; }
      let count = 0;
      const delay = sequence.current.stepChange ? STEP_TYPING_MS / text.length : CHARACTER_DELAY_MS;
      timer = window.setInterval(() => {
        count += 1;
        show(text.slice(0, count));
        if (count >= text.length) {
          sequence.current.settled = true;
          window.clearInterval(timer);
        }
      }, delay);
    };
    const outgoing = visible.current;
    if (sequence.current.stepChange && outgoing.length > 0) {
      let tick = 0;
      timer = window.setInterval(() => {
        tick += 1;
        show(outgoing.slice(0, Math.ceil(outgoing.length * (1 - tick / 6))));
        if (tick === 6) { window.clearInterval(timer); type(); }
      }, BACKSPACE_MS / 6);
    } else type();
    return () => window.clearInterval(timer);
  }, [text, reducedMotion]);

  return (
    <p className={['print-terminal-line', className].filter(Boolean).join(' ')} data-motion={reducedMotion ? 'off' : 'on'}>
      <span className="print-terminal-accessible">{text}</span>
      <span className="print-terminal-copy" aria-hidden="true" style={{ '--neo-terminal-characters': Math.max(text.length, 1) } as CSSProperties}>
        <span className="print-terminal-text" aria-hidden="true">{reducedMotion ? text : displayed}</span>
        <span className="print-terminal-target" aria-hidden="true">{text}</span>
        <span className="print-terminal-cursor" aria-hidden="true">█</span>
      </span>
    </p>
  );
}
