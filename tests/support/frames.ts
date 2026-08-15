// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The envelope the proxy sends to a client, decoded once for the suites.
 *
 * Declared here because a dozen tests were each parsing the same frames into
 * `Record<string, unknown>` and then reading fields off them, which gave the
 * assertions no contract at all. `looseObject` keeps any field a frame
 * carries beyond the ones named here.
 */
import { z } from 'zod';

export const proxyFrameSchema = z.looseObject({
  type: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  reason: z.string().optional(),
  field: z.string().optional(),
  sessionId: z.string().optional(),
  token: z.string().optional(),
  payload: z.string().optional(),
  seq: z.number().optional(),
  replayed: z.boolean().optional(),
  suppressed: z.boolean().optional(),
});

export type ProxyFrame = z.infer<typeof proxyFrameSchema>;

/** Decode one frame as it came off the socket. */
export const parseFrame = (raw: string): ProxyFrame =>
  proxyFrameSchema.parse(JSON.parse(raw));
