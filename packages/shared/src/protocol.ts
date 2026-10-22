/**
 * Wire protocol between browsers and the gateway, validated with zod on the server.
 */

import { z } from 'zod';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`), 'Room codes are 6 letters/digits');

export const studentNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(40, 'Keep your name under 40 characters')
  .transform((s) => s.replace(/\s+/g, ' '));

const idLike = z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-]+$/);

export const runSignalSchema = z.object({
  exerciseId: idLike,
  result: z.enum(['pass', 'fail', 'error']),
  testsPassed: z.number().int().min(0).max(1000),
  testsTotal: z.number().int().min(0).max(1000),
  errorType: z.string().max(64).nullable(),
  errorMessage: z.string().max(400).nullable(),
  failingTest: z.string().max(80).nullable(),
});

export const activitySignalSchema = z.object({ exerciseId: idLike });

/** Messages a student socket may send. */
export const studentClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('run'), id: z.string().max(40), signal: runSignalSchema }),
  z.object({ t: z.literal('activity'), signal: activitySignalSchema }),
  z.object({ t: z.literal('ping') }),
]);
export type StudentClientMessage = z.infer<typeof studentClientMessage>;

export const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(80),
  labId: idLike,
  stuckMinutes: z.number().int().min(1).max(60),
});

export const sendHintSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{14}$/),
  text: z.string().trim().min(1, 'Write a hint first').max(600),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  inviteCode: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(1).max(200),
});

export const joinSchema = z.object({
  code: roomCodeSchema,
  name: studentNameSchema,
});

/** Server -> client messages. */
export type ServerMessage =
  | { t: 'snapshot'; serverNow: number; room: import('./types.js').RoomInfo; events: import('./types.js').RoomEvent[] }
  | { t: 'event'; event: import('./types.js').RoomEvent }
  | { t: 'room'; room: import('./types.js').RoomInfo }
  | { t: 'welcome'; serverNow: number; studentId: string; name: string; room: import('./types.js').RoomInfo; lab: import('./types.js').LabDefinition; hints: StudentHint[]; progress: Record<string, 'not_started' | 'failing' | 'passing'> }
  | { t: 'hint'; hint: StudentHint }
  | { t: 'ack'; id: string; ok: boolean; error?: string }
  | { t: 'lab_ended' }
  | { t: 'error'; message: string }
  | { t: 'pong'; serverNow: number };

export interface StudentHint {
  hintId: string;
  exerciseId: string;
  text: string;
  sentAt: number;
}
