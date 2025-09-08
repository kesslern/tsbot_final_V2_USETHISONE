import z from 'zod';

export const BotConfigSchema = z.object({
  server: z.string().min(1),
  port: z.number().int().min(1),
  nick: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
