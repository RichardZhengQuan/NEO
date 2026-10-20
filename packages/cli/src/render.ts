/**
 * Pure rendering functions: agent events → terminal output lines.
 * No side effects, no I/O — safe to unit-test.
 */
import type { AgentEvent } from '@neo/protocol';
import { uiBlockToText, uiBlocksToText } from '@neo/protocol';
import { bold, cyan, dim, green, magenta, red, stripModelText, yellow } from './ansi.js';

export interface RenderOptions {
  showReasoning?: boolean;
  /** Width in characters for tool chips / dividers. */
  width?: number;
}

export interface RenderedLine {
  /** The text to print. */
  text: string;
  /** Whether this replaces the previous line (streaming delta). */
  delta?: boolean;
}

/** Render a single AgentEvent into zero or more output lines. */
export function renderEvent(event: AgentEvent, opts: RenderOptions = {}): RenderedLine[] {
  switch (event.type) {
    case 'turn.started':
      return [{ text: '' }]; // blank line before assistant response

    case 'text.delta':
      // Caller is responsible for accumulating and printing incrementally.
      return [{ text: stripModelText(event.text), delta: true }];

    case 'reasoning.delta':
      if (!opts.showReasoning) return [];
      return [{ text: dim(`[thinking] ${stripModelText(event.text)}`), delta: true }];

    case 'tool.started': {
      const chip = `  ⚙ ${event.title || event.name}…`;
      return [{ text: dim(chip) }];
    }

    case 'tool.confirmation': {
      const c = event.confirmation;
      return [
        { text: '' },
        { text: yellow(`  ❓ ${c.title}`) },
        { text: dim(`     ${c.description}`) },
        { text: dim('     [y]es  [n]o  [a]lways') },
      ];
    }

    case 'tool.finished': {
      if (event.isError) {
        const chip = `  ✗ ${event.name}${event.summary ? `: ${event.summary}` : ''}`;
        return [{ text: red(chip) }];
      }
      const chip = `  ✓ ${event.name}${event.summary ? `: ${event.summary}` : ''}`;
      return [{ text: green(chip) }];
    }

    case 'part.added': {
      const part = event.part;
      if (part.type === 'ui') {
        const lines: RenderedLine[] = [{ text: dim('  ┄'.padEnd(opts.width ?? 60, '┄')) }];
        const rendered = uiBlockToText(part.block, 1);
        for (const line of rendered.split('\n')) {
          lines.push({ text: dim('  │ ') + line });
        }
        lines.push({ text: dim('  ┄'.padEnd(opts.width ?? 60, '┄')) });
        return lines;
      }
      if (part.type === 'reasoning' && opts.showReasoning) {
        return [{ text: dim(`[reasoning] ${stripModelText(part.text)}`) }];
      }
      if (part.type === 'sources' && part.items.length) {
        return [
          { text: dim('  Sources') },
          ...part.items.map((source, index) => ({ text: `  ${index + 1}. ${source.title || source.url} — ${source.url}` })),
        ];
      }
      return [];
    }

    case 'memory.recalled': {
      if (!event.items.length) return [];
      const labels = stripModelText(event.items.slice(0, 5).map((m) => m.label).join(', '));
      const more = event.items.length > 5 ? ` +${event.items.length - 5} more` : '';
      return [{ text: dim(`  🧠 remembered: ${labels}${more}`) }];
    }

    case 'memory.written': {
      const n = event.created.length + event.updated.length;
      if (n === 0) return [];
      const parts: string[] = [];
      if (event.created.length) parts.push(`${event.created.length} new`);
      if (event.updated.length) parts.push(`${event.updated.length} updated`);
      return [{ text: dim(`  💭 ${parts.join(', ')} memor${n === 1 ? 'y' : 'ies'}`) }];
    }

    case 'turn.finished': {
      const lines: RenderedLine[] = [{ text: '' }]; // blank line after response
      if (event.usage) {
        const { inputTokens, outputTokens } = event.usage;
        lines.push({ text: dim(`  [${inputTokens} in / ${outputTokens} out tokens]`) });
      }
      return lines;
    }

    case 'turn.failed': {
      return [
        { text: '' },
        { text: red(`  ✗ ${event.error.message}`) },
      ];
    }

    case 'message.completed':
      return []; // we've already been streaming

    case 'conversation.updated':
      return []; // handled by REPL separately if needed

    // All other event types are silently ignored in the CLI.
    default:
      return [];
  }
}

/** Render a complete event sequence to a single string (for snapshot tests). */
export function renderEvents(events: AgentEvent[], opts: RenderOptions = {}): string {
  const lines: string[] = [];
  for (const ev of events) {
    for (const line of renderEvent(ev, opts)) {
      lines.push(line.text);
    }
  }
  return lines.join('\n');
}

/** Format the `neo serve` startup banner. */
export function renderBanner(opts: {
  url: string;
  mode: string;
  dataDir: string;
  ownerToken: string;
  showToken: boolean;
  /** Explicit terminal state; defaults to captured output for safe rendering. */
  isInteractive?: boolean;
  webDir: string | null;
  qrText?: string;
  pairingUrl?: string;
}): string {
  const { url, mode, dataDir, ownerToken, showToken, isInteractive, webDir, qrText, pairingUrl } = opts;
  const discloseOwnerToken = showToken || (mode === 'local' && isInteractive === true);
  const lines: string[] = [
    '',
    bold(cyan('  ✦ NEO')),
    '',
    `  ${bold('URL')}        ${green(url)}`,
    `  ${bold('Mode')}       ${mode}`,
    `  ${bold('Data dir')}   ${dataDir}`,
  ];
  if (webDir) {
    lines.push(`  ${bold('Web app')}    ${url}`);
  } else {
    lines.push(`  ${bold('Web app')}    ${dim('none — run `neo init` or set --web-dir')}`);
  }
  if (discloseOwnerToken) {
    lines.push(`  ${bold('Owner token')} ${magenta(ownerToken)}`);
  }
  if (mode === 'server' && !discloseOwnerToken) {
    lines.push(`  ${bold('Pairing')}    ${dim('run `neo pair` to add a device')}`);
  }
  if (discloseOwnerToken && qrText && pairingUrl) {
    lines.push('');
    lines.push(`  ${bold('Pair a device:')} ${pairingUrl}`);
    lines.push('');
    for (const line of qrText.split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  lines.push('');
  lines.push(dim('  Press Ctrl+C to stop.'));
  lines.push('');
  return lines.join('\n');
}

/** Format a remembered-memories banner line. */
export function renderRecalled(labels: string[]): string {
  if (!labels.length) return '';
  return dim(`🧠 remembered: ${labels.join(', ')}`);
}

/** Render UI blocks from a `part.added` ui part as indented plain text. */
export function renderUiPart(blocks: unknown[]): string {
  // Cast is safe here — blocks come from a typed ui part.
  return uiBlocksToText(blocks as Parameters<typeof uiBlocksToText>[0]);
}
