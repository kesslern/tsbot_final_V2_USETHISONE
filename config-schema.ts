import z from 'zod';

// Groups of tools the llamacpp plugin can give the model (see llm-tools.ts)
export const TOOL_GROUPS = ['current_time', 'weather', 'web_search', 'fetch_page', 'calculate', 'notes', 'seen', 'tell', 'view_image'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const BotConfigSchema = z.object({
  server: z.string().min(1),
  port: z.number().int().min(1),
  nick: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1),
  admins: z.array(z.string().min(1)).min(1),
  prefix: z.string().length(1), // Command prefix, one character
  plugins: z.array(z.string().min(1)).optional(), // Plugins to load on start
  llamacpp: z.object({
    baseUrl: z.url(), // OpenAI-compatible API base URL, e.g. http://localhost:8080/v1
    apiKey: z.string().min(1).optional(), // Sent as a Bearer token if set (llama-server --api-key)
    model: z.string().min(1).optional(), // Model name; llama.cpp ignores it, other OpenAI-compatible servers require it
    systemPrompt: z.string().optional(), // System prompt to set context/personality
    temperature: z.number().min(0).max(2).optional(), // Controls randomness (0-2, lower is more focused)
    top_p: z.number().min(0).max(1).optional(), // Controls diversity via nucleus sampling (0-1)
    maxHistoryExchanges: z.number().int().min(0).max(25).optional(), // Question/answer pairs kept word for word per channel; older ones are summarized (0 = no history)
    channelContextMessages: z.number().int().min(0).max(100).optional(), // Number of recent channel messages to include as context (0 = disabled)
    timeoutSeconds: z.number().int().min(1).max(600).optional(), // Give up waiting for a reply after this long (default 60)
    maxReplyLines: z.number().int().min(1).max(10).optional(), // IRC lines sent per reply before truncating (default 3)
    contextWindow: z.number().int().min(512).optional(), // Match llama-server's --ctx-size (default 8192); replies are capped at this minus the prompt size
    maxTokens: z.number().int().min(16).optional(), // Longest reply the model may generate (default 1024)
    reasoning: z.boolean().optional(), // true for thinking models (Qwen3, gpt-oss, ...); default false
    tools: z.array(z.enum(TOOL_GROUPS)).optional(), // Tool groups the model may use (default: all but fetch_page; [] = plain chat)
    maxToolTurns: z.number().int().min(1).max(20).optional(), // Model calls per reply before giving up, to stop tool loops (default 5)
    maxPageChars: z.number().int().min(500).max(200000).optional(), // Longest page text fetch_page gives the model (default 4000; roughly 4 characters per token)
    compactAtTokens: z.number().int().min(1000).optional(), // Summarize older history once it's this big (default: half of contextWindow, at most 16000)
    vision: z.boolean().optional(), // true if the model can see images (llama-server started with --mmproj); needed for view_image
    maxImageBytes: z.number().int().min(10_000).max(50_000_000).optional(), // Largest image view_image downloads (default 8 MB)
  }).optional(),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
