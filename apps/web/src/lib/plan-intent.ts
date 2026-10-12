/** High-confidence local scene entry. Other phrasing remains available to the AI tool. */
export function isPlanTomorrowIntent(text: string): boolean {
  const value = text.trim().replace(/[.!?。！？]+$/, '').trim();
  return /^(?:(?:please|can you|could you)\s+)?(?:help me\s+)?(?:plan tomorrow|plan my day tomorrow|plan tomorrow's day|make a plan for tomorrow)$/i.test(value) ||
    /^(?:请|帮我|请帮我)?(?:规划明天|安排明天|计划明天|制定明天的计划|明天的计划)$/.test(value);
}
