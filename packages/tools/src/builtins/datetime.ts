import { z } from 'zod';
import { defineTool } from '@neo/protocol';
import { assertTimeZone } from '../time.js';
import { friendlyTime, localIso, weekdayName } from './format.js';

export const getDatetimeTool = defineTool({
  name: 'get_datetime',
  title: 'Current date & time',
  description:
    "Get the current date, time and weekday in the user's timezone (or another IANA timezone, e.g. to answer " +
    '"what time is it in Tokyo?"). Use it for date arithmetic such as "how many days until…". Not needed for ' +
    'reminders and tasks: their `when`/`due` fields accept phrases like "in 10 minutes" or "tomorrow 9am" directly.',
  inputSchema: z.object({
    timezone: z.string().min(1).max(64).optional().describe('IANA timezone such as "America/New_York". Default: the user\'s timezone.'),
  }),
  risk: 'read',
  defaultPermission: 'auto',
  async execute(input, ctx) {
    const timezone = assertTimeZone(input.timezone ?? ctx.timezone);
    const now = ctx.now();
    return {
      output: {
        epochMs: now,
        iso: new Date(now).toISOString(),
        local: localIso(now, timezone),
        timezone,
        weekday: weekdayName(now, timezone),
      },
      summary: `${friendlyTime(now, timezone, ctx.locale)} (${timezone})`,
    };
  },
});
