import { z } from "zod";
import { PhaseId } from "./branded-types.js";

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
  }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
