import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt.js';

const planningTool = { name: 'propose_changes', description: 'Propose concrete edits for review.', inputSchema: { type: 'object', properties: {} } };

describe('planning guidance', () => {
  it('reads saved context and proposes edits without applying them', () => {
    const prompt = buildSystemPrompt({ nativeTools: true, tools: [planningTool] });
    expect(prompt).toContain('## Planning');
    expect(prompt).toContain('`list_tasks` and `list_reminders`');
    expect(prompt).toContain('one `propose_changes` call');
    expect(prompt).toContain('Nothing changes until they apply it');
    expect(prompt).toContain('tell you what to adjust');
    expect(prompt).toContain('Do not invent durations or calendar availability');
    expect(prompt).toContain('For a single direct edit');
  });

  it('only includes planning when the tool is available', () => {
    expect(buildSystemPrompt({ nativeTools: true, tools: [] })).not.toContain('## Planning');
    expect(buildSystemPrompt({ nativeTools: false, tools: [planningTool] })).not.toContain('propose_changes');
    expect(buildSystemPrompt({ nativeTools: false, tools: [] })).not.toMatch(/Block types:.*changes/);
  });
});
