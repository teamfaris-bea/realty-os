// Zod response and request schemas of module 53 (snapshotted in gbp/snapshots.test.ts: no tenant id, no confidence,
// no reviewer matching, no contact field).
import { z } from 'zod';

export const LocationStatus = z.object({ connectionId: z.uuid(), displayName: z.string(), sentence: z.string() });
export const StatusResponse = z.object({
  status: z.object({
    state: z.enum(['not_cleared', 'not_set_up', 'not_connected', 'connected']),
    sentence: z.string(),
    locations: z.array(LocationStatus),
  }),
});
