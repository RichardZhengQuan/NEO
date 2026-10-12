import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

const planningTool = { name: 'plan_tomorrow', description: 'Read-only preview of tomorrow.', inputSchema: { type: 'object', properties: {} } };

describe('planning scene guidance', () => {
  it('directs a capable model to the offered read-only scene instead of scheduling automatically', () => {
    const prompt = buildSystemPrompt({ nativeTools: true, tools: [planningTool] });
    expect(prompt).toContain('use `plan_tomorrow`');
    expect(prompt).toContain('read-only preview');
    expect(prompt).toContain('do not invent durations or calendar availability');
    expect(prompt).toContain('create reminders automatically');
  });

  it('does not instruct models to call a planning tool they cannot use', () => {
    expect(buildSystemPrompt({ nativeTools: true, tools: [] })).not.toContain('plan_tomorrow');
    expect(buildSystemPrompt({ nativeTools: false, tools: [planningTool] })).not.toContain('plan_tomorrow');
  });
});
