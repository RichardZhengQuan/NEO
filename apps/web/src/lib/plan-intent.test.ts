import { describe, expect, it } from 'vitest';
import { isPlanTomorrowIntent } from './plan-intent.js';

describe('on-demand planning entry', () => {
  it.each(['Plan tomorrow', 'Please plan tomorrow.', 'Can you help me plan tomorrow?', 'plan my day tomorrow', 'Make a plan for tomorrow', '帮我安排明天', '请帮我规划明天。'])('opens for explicit intent: %s', (text) => {
    expect(isPlanTomorrowIntent(text)).toBe(true);
  });
  it.each(["Don't plan tomorrow", 'What does plan tomorrow mean?', 'Remind me to plan tomorrow', 'Tell me about planning tomorrow', '不要安排明天', '明天的天气怎么样'])('leaves other requests to the assistant: %s', (text) => {
    expect(isPlanTomorrowIntent(text)).toBe(false);
  });
});
