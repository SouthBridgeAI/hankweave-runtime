import { z } from "zod";
import { CodonId } from "./types/branded-types.js";

const codonIdSchema = z.string().transform((id) => CodonId(id));

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("codon.start"),
    data: z.object({
      codonId: codonIdSchema,
      skipPreCommands: z.boolean().optional(),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("codon.next"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("codon.skip"),
  }),
  z.object({
    id: z.string(),
    type: z.literal("codon.redo"),
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

  // Force stop current codon
  z.object({
    id: z.string(),
    type: z.literal("codon.forceStop"),
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

  // Rollback to codon + checkpoint type
  z.object({
    id: z.string(),
    type: z.literal("rollback.toCodon"),
    data: z.object({
      codonId: codonIdSchema,
      checkpointType: z.enum(["start", "end", "rig-setup", "completed", "error", "skipped"]),
      autoRestart: z.boolean().optional().default(false),
    }),
  }),

  // Rollback to last successful codon
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

  // History synchronization
  z.object({
    id: z.string(),
    type: z.literal("history.sync"),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
