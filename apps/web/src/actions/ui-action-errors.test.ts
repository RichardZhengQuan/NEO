import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import { widgetActionId, type ToolResult, type UIAction, type UiActionRequest } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useToasts } from '../state/notifications.js';
import { emptyEntry, useTimeline } from '../state/timeline.js';
import { runUiAction } from './timeline.js';

const t = createTranslator('en', buildMessages('en', appDictionaries));
const action: UIAction = { id: widgetActionId.taskToggle('task_1'), kind: 'tool', tool: 'update_task', label: 'Complete task', input: {} };
const applyAction: UIAction = { id: widgetActionId.changeApply('chg_1'), kind: 'tool', tool: 'apply_change', label: 'Apply change', input: {} };
const conflict = 'This task changed after NEO proposed this. Ask NEO for a fresh plan.';

beforeEach(() => {
  useTimeline.setState(emptyEntry(), true);
  useToasts.setState({ toasts: [] });
});

describe('UI action tool errors', () => {
  it.each<[ToolResult, string, string]>([
    [{ isError: true, output: { error: conflict, code: 'conflict' } }, conflict, conflict],
    [{ isError: true, output: { error: conflict }, summary: 'Could not apply' }, conflict, conflict],
    [{ isError: true, output: { error: 409 }, summary: 'Could not apply' }, 'Could not apply', 'Could not apply'],
    [{ isError: true, output: null }, 'tool failed', "That didn't work"],
  ])('propagates the result error with summary and fallback support %#', async (result, expectedError, expectedToast) => {
    const uiAction = vi.fn(async (_request: UiActionRequest) => ({ kind: 'tool' as const, ...result }));
    const client = { timeline: { uiAction } } as unknown as NeoClient;

    await expect(runUiAction(client, { messageId: 'msg_1', uiId: 'ui_1', action }, t)).rejects.toThrow(expectedError);
    expect(useToasts.getState().toasts).toMatchObject([{ tone: 'error', title: expectedToast }]);
    expect(uiAction).toHaveBeenCalledExactlyOnceWith({ messageId: 'msg_1', uiId: 'ui_1', actionId: action.id });
  });

  it('keeps change.apply results out of toasts, since the changes widget shows them per item', async () => {
    const uiAction = vi.fn(async (_request: UiActionRequest) => ({ kind: 'tool' as const, isError: true, output: { error: conflict, code: 'conflict' } }));
    const client = { timeline: { uiAction } } as unknown as NeoClient;
    await expect(runUiAction(client, { messageId: 'msg_1', uiId: 'ui_1', action: applyAction }, t)).rejects.toThrow(conflict);

    uiAction.mockResolvedValueOnce({ kind: 'tool', isError: false, output: { change: { id: 'chg_1', status: 'applied' } }, summary: 'Updated “Dentist”' } as never);
    await runUiAction(client, { messageId: 'msg_1', uiId: 'ui_1', action: applyAction }, t);
    expect(useToasts.getState().toasts).toEqual([]);
  });
});
