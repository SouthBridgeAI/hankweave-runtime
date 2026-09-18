import { z } from "zod";

export default z.object({
  followedRule: z.boolean(),
  note: z.string().optional(),
});
