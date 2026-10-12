/**
 * Memory tools: remember, recall and forget.
 */
import { z } from 'zod';
import { MemoryKindSchema, NeoError, defineTool, type MemoryNode, type MemoryService, type UIBlock } from '@neo/protocol';
import { clip } from './format.js';

const SENSITIVE_LABEL = '(a sensitive memory)';

export function createMemoryTools(memory: MemoryService) {
  /** id → label of memories this process has seen, so confirmations can name them synchronously. */
  const labels = new Map<string, Pick<MemoryNode, 'label' | 'sensitivity'>>();
  const remember = (n: Pick<MemoryNode, 'id' | 'label' | 'sensitivity'>) => {
    labels.delete(n.id);
    labels.set(n.id, { label: n.label, sensitivity: n.sensitivity });
    if (labels.size > 2000) labels.delete(labels.keys().next().value as string);
  };
  const shown = (n: Pick<MemoryNode, 'label' | 'sensitivity'>, allowSensitive: boolean) => (n.sensitivity === 'sensitive' && !allowSensitive ? SENSITIVE_LABEL : n.label);

  const rememberTool = defineTool({
    name: 'remember',
    title: 'Remember',
    description:
      'Save something about the user to long-term memory when they ask you to remember it, or when they share a lasting fact, ' +
      'preference, goal or relationship that will clearly matter later ("I\'m allergic to peanuts", "my sister Mia lives in Lyon"). ' +
      'Write `content` as a self-contained third-person statement ("The user is allergic to peanuts"). Don\'t store passing ' +
      'chit-chat. The user sees a memory card and can review, edit or forget it in Memory.',
    inputSchema: z.object({
      content: z.string().min(1).max(10_000).describe('Self-contained statement in third person.'),
      label: z.string().min(1).max(300).optional().describe('Short title, e.g. "Peanut allergy".'),
      kind: MemoryKindSchema.optional().describe('fact (default), preference, entity, goal, skill, episode…'),
      importance: z.number().min(0).max(1).optional().describe('0-1, how much this should matter later.'),
      entities: z.array(z.string().min(1).max(120)).max(20).optional().describe('People, places or things it is about, e.g. ["Mia"].'),
      pinned: z.boolean().optional().describe('Pinned memories never fade.'),
      sensitivity: z.enum(['normal', 'sensitive']).optional().describe('"sensitive" for health, finances, credentials and similar.'),
    }),
    risk: 'write',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      if (ctx.offRecord) throw new NeoError('forbidden', 'Memory writes are unavailable off the record.');
      const node = await memory.remember({
        content: input.content,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.entities !== undefined ? { entities: input.entities } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        source: { by: 'tool', conversationId: ctx.conversationId ?? null, messageId: ctx.messageId ?? null },
      }, ctx.signal);
      remember(node);
      const ui: UIBlock[] = [
        {
          type: 'memory',
          title: 'Remembered',
          nodes: [{ id: node.id, kind: clip(node.kind, 30), label: clip(node.label, 300), content: clip(node.content, 2000), status: node.status }],
        },
      ];
      return {
        output: { id: node.id, label: node.label, kind: node.kind, status: node.status },
        ui,
        summary: `Remembered “${clip(node.label, 60)}”`,
        ...(node.sensitivity === 'sensitive' ? { sensitive: true } : {}),
      };
    },
  });

  const recall = defineTool({
    name: 'recall',
    title: 'Recall memories',
    description:
      'Search long-term memory for what you know about the user or a topic ("what do I know about Mia?", "user\'s diet"). ' +
      'Relevant memories are already added to each message automatically; call this to look deeper or for something specific.',
    inputSchema: z.object({
      query: z.string().min(1).max(1000),
      limit: z.number().int().min(1).max(20).optional().describe('Default 8.'),
    }),
    risk: 'read',
    defaultPermission: 'auto',
    async execute(input, ctx) {
      // The user turned recall off: answer plainly (not an error the model would retry).
      if (!memory.getPolicy().recall) {
        return {
          output: { memories: [], note: "Memory recall is turned off in the user's settings, so no memories were looked up. Don't call recall again; answer without memories." },
          summary: 'Memory recall is turned off',
        };
      }
      const result = await memory.recall({
        text: input.query,
        limit: input.limit ?? 8,
        allowSensitive: ctx.allowSensitive,
        get reinforce() { return ctx.offRecord ? false : undefined; },
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      });
      const memories = result.items.map((m) => {
        remember(m.node);
        return { id: m.node.id, kind: m.node.kind, label: m.node.label, content: m.node.content, reason: m.reason };
      });
      const hasSensitive = result.items.some((m) => m.node.sensitivity === 'sensitive');
      return {
        output: { memories },
        summary: `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} recalled`,
        ...(hasSensitive ? { sensitive: true } : {}),
      };
    },
  });

  const forget = defineTool({
    name: 'forget',
    title: 'Forget memories',
    description:
      'Permanently delete memories, when the user asks you to forget something. Pass `ids` (from recall or the context) or a ' +
      '`query` describing what to forget ("everything about my old job"); the user confirms first.',
    inputSchema: z
      .object({
        query: z.string().min(1).max(1000).optional().describe('What to forget, in words.'),
        ids: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
      })
      .refine((v) => v.ids !== undefined || v.query !== undefined, 'Give `ids` or a `query`.'),
    risk: 'dangerous',
    defaultPermission: 'confirm',
    describeCall: (input) => {
      if (input.ids?.length) {
        const named = input.ids.map((id) => labels.get(id)?.label);
        if (named.every((l) => l !== undefined)) return `Forget ${named.map((l) => `“${clip(l as string, 60)}”`).join(', ')}`;
        return `Forget ${input.ids.length} memor${input.ids.length === 1 ? 'y' : 'ies'}${named.some(Boolean) ? ` (${named.filter(Boolean).map((l) => `“${clip(l as string, 40)}”`).join(', ')}…)` : ''}`;
      }
      return `Forget everything matching “${clip(input.query ?? '', 80)}”`;
    },
    async execute(input, ctx) {
      if (ctx.offRecord) throw new NeoError('forbidden', 'Memory writes are unavailable off the record.');
      let ids: string[];
      let forgotten: string[];
      let sensitive = false;
      if (input.ids?.length) {
        ids = [...new Set(input.ids)];
        const details = await Promise.all(ids.map((id) => memory.get(id).catch(() => null)));
        forgotten = ids.map((id, i) => {
          const n = details[i]?.node ?? labels.get(id);
          if (n?.sensitivity === 'sensitive' && ctx.allowSensitive) sensitive = true;
          return n ? shown(n, ctx.allowSensitive) : id;
        });
      } else {
        const found = await memory.findForForget(input.query as string, 20);
        if (!found.length) return { output: { forgotten: [], note: `No memories match “${input.query}”.` }, summary: 'Nothing to forget' };
        ids = found.map((n) => n.id);
        forgotten = found.map((n) => shown(n, ctx.allowSensitive));
        sensitive = ctx.allowSensitive && found.some((n) => n.sensitivity === 'sensitive');
      }
      if (ctx.offRecord) throw new NeoError('forbidden', 'Memory writes are unavailable off the record.');
      if (ctx.signal.aborted) throw new NeoError('cancelled', 'The operation was cancelled.');
      const deleted = await memory.forget(ids);
      for (const id of ids) labels.delete(id);
      if (deleted === 0) throw new NeoError('not_found', 'None of those memories exist (already forgotten?).');
      return { output: { forgotten }, summary: `Forgot ${deleted} memor${deleted === 1 ? 'y' : 'ies'}`, ...(sensitive ? { sensitive: true } : {}) };
    },
  });

  return [rememberTool, recall, forget];
}
