import { expect, it } from 'vitest';
import { ev, harness, runTurn, standardTools } from './fakes.test-utils.js';

it('keeps a frozen episode usable after a tool is removed', async () => {
  const h = harness({ tools: [{ ...standardTools()[0]!, name: 'retired_preview' }] });
  await runTurn(h, 'First turn');
  const frozen = h.conversations.get(h.conv.id)!;
  expect(frozen.toolset).toContain('retired_preview');
  h.tools.unregister('retired_preview');
  h.model.script([ev.call('removed-call', 'retired_preview', {}), ev.done('tool_use')], [ev.text('Please ask for a new plan.'), ev.done()]);
  const next = await runTurn(h, 'Continue');
  expect(next.message.status).toBe('complete');
  expect(next.message.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'retired_preview', isError: true }));
  expect(h.conversations.get(h.conv.id)?.toolset).toEqual(frozen.toolset);
  expect(h.conversations.get(h.conv.id)?.systemPrompt).toBe(frozen.systemPrompt);
  expect(h.model.requests.at(-1)?.tools ?? []).toEqual([]);
});
