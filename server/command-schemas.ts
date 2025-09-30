import { z } from "zod";
import { PhaseId } from "./types/branded-types.js";

const phaseIdSchema = z.string().transform((id) => PhaseId(id));

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("phase.start"),
    data: z.object({
      phaseId: phaseIdSchema,
      skipPreCommands: z.boolean().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.next"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.skip"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("phase.redo"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("server.shutdown"),
    data: z
      .object({
        reason: z.string().optional(),
      })
      .optional(),
  }),

  // Query checkpoints
  z.object({
    id: z.string(),
    type: z.literal("checkpoint.list"),
    data: z
      .object({
        runId: z.string().optional(), // Defaults to current run
      })
      .optional(),
  }),

  // Force stop current phase
  z.object({
    id: z.string(),
    type: z.literal("phase.forceStop"),
    data: z
      .object({
        reason: z.string().optional(),
      })
      .optional(),
  }),

  // Rollback to specific checkpoint
  z.object({
    id: z.string(),
    type: z.literal("rollback.toCheckpoint"),
    data: z.object({
      checkpointSha: z.string(),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to phase + checkpoint type
  z.object({
    id: z.string(),
    type: z.literal("rollback.toPhase"),
    data: z.object({
      phaseId: phaseIdSchema,
      checkpointType: z.enum(["start", "end", "workspace-setup", "completed", "error", "skipped"]),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to last successful phase
  z.object({
    id: z.string(),
    type: z.literal("rollback.toLastSuccess"),
    data: z
      .object({
        autoRestart: z.boolean().optional().default(false),
      })
      .optional(),
  }),

  // Ping commands for testing
  z.object({
    id: z.string(),
    type: z.literal("ping"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("ping.broadcast"),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
