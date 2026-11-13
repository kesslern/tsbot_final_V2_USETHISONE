import { Agent, estimateContextTokens, serializeConversation, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { Plugin } from '../plugin-manager.ts';
import type { BotConfig } from '../config-schema.ts';
import { deleteConversation, loadConversation, recordSeen, saveConversation, takeDueReminders, takeTellsFor, type Delivery } from '../bot-db.ts';
import { ago, buildTools, DEFAULT_TOOL_GROUPS, toolGuidance } from '../llm-tools.ts';

// Talks to any OpenAI-compatible chat completions API (llama.cpp's llama-server, vLLM, etc.)
// through the pi agent loop, so the model can call tools before answering.
// Conversations are saved to data/bot.db, with older parts summarized instead of dropped.

type LlamaConfig = NonNullable<BotConfig['llamacpp']>;
type IrcClient = Parameters<NonNullable<Plugin['onMessage']>>[0]['bot'];

// Leaves room for "PRIVMSG #channel :" and the bot's hostmask within IRC's 512-byte line limit
const MAX_LINE_LENGTH = 400;

const SUMMARY_PROMPT = `You maintain the long-term memory of an IRC bot. You will get the previous summary (if any) and a stretch of older conversation.
Write an updated summary that keeps everything worth remembering: who said what, facts about people, questions asked and the answers given, ongoing topics, and promises the bot made.
Drop small talk and tool-call details. Write plain prose or short bullet points, under 300 words. Output only the summary.`;

// One agent (and its conversation) per channel, or per nick for private messages
type ChannelAgent = {
  agent: Agent;
  config: LlamaConfig;
  summary: string; // summary of conversation older than what's in agent.state.messages
  asker: string; // nick of whoever asked the question being answered
  toolKey: string; // which tool groups this conversation has had
};
const agents = new Map<string, ChannelAgent>();

// An agent can only run once at a time, so requests in the same channel wait their turn
const queues = new Map<string, Promise<void>>();

// Store recent channel messages for context
// Key: channel name, Value: array of {nick, message}
type ChannelMessage = { nick: string; message: string };
const channelMessages = new Map<string, ChannelMessage[]>();

// Checks for due reminders; started once the plugin has seen the IRC client
let reminderTimer: NodeJS.Timeout | undefined;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isChannelName = (target: string) => /^[#&+!]/.test(target);

function trackChannelMessage(channel: string, nick: string, message: string, limit: number) {
  if (limit <= 0) return;
  const messages = channelMessages.get(channel) ?? [];
  messages.push({ nick, message });
  channelMessages.set(channel, messages.slice(-limit));
}

// Split a reply into IRC-sized lines: on newlines first, then on word boundaries
function splitIntoLines(text: string): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    while (line.length > MAX_LINE_LENGTH) {
      let cut = line.lastIndexOf(' ', MAX_LINE_LENGTH);
      if (cut <= 0) cut = MAX_LINE_LENGTH; // No space to break on, so hard-split the word
      lines.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function sayLines(bot: IrcClient, to: string, lines: string[]) {
  // A small delay between lines avoids flooding
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    bot.say(to, lines[i]);
  }
}

function buildModel(llamaConfig: LlamaConfig): Model<'openai-completions'> {
  const samplingParams: Record<string, number> = {};
  if (llamaConfig.temperature !== undefined) samplingParams.temperature = llamaConfig.temperature;
  if (llamaConfig.top_p !== undefined) samplingParams.top_p = llamaConfig.top_p;

  return {
    id: llamaConfig.model ?? 'local', // llama.cpp serves whatever model it was started with
    name: 'llama.cpp',
    api: 'openai-completions',
    provider: 'llamacpp',
    baseUrl: llamaConfig.baseUrl.replace(/\/+$/, ''),
    reasoning: llamaConfig.reasoning ?? false,
    input: llamaConfig.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: llamaConfig.contextWindow ?? 8192,
    maxTokens: llamaConfig.maxTokens ?? 1024,
    samplingParams,
    // llama.cpp doesn't support these OpenAI-only features. Many chat templates also
    // reject more than one system message, so later ones get folded into the first.
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsMidConvoSystemMessages: false,
      maxTokensField: 'max_tokens',
    },
  };
}

const apiKey = (llamaConfig: LlamaConfig) => llamaConfig.apiKey ?? 'none'; // llama-server ignores the key unless started with --api-key

// view_image is useless without a vision model, which would only be told the image was omitted
function toolGroupsFor(llamaConfig: LlamaConfig) {
  const groups = llamaConfig.tools ?? DEFAULT_TOOL_GROUPS;
  return llamaConfig.vision ? groups : groups.filter(group => group !== 'view_image');
}

// Identifies a tool set, so a conversation can be matched to the tools it was held with
const toolKeyFor = (llamaConfig: LlamaConfig) => [...toolGroupsFor(llamaConfig)].sort().join(',');

function createChannelAgent(channel: string, llamaConfig: LlamaConfig, messages: AgentMessage[], summary: string): ChannelAgent {
  // Tools read the asker from here, and answer() sets it before each question
  const holder = { asker: '' };
  if (!llamaConfig.vision && llamaConfig.tools?.includes('view_image')) {
    console.warn('llamacpp plugin: view_image needs vision: true in the config, leaving it out');
  }
  const tools = buildTools(toolGroupsFor(llamaConfig), {
    channel,
    isChannel: isChannelName(channel),
    asker: () => holder.asker,
    maxPageChars: llamaConfig.maxPageChars ?? 4000,
    maxImageBytes: llamaConfig.maxImageBytes ?? 8 * 1024 * 1024,
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: llamaConfig.systemPrompt ?? '',
      model: buildModel(llamaConfig),
      thinkingLevel: 'off',
      tools,
      messages,
    },
    // The model is always the openai-completions one built above
    streamFn: (model, context, options) => streamSimple(model as Model<'openai-completions'>, context, options),
    getApiKey: () => apiKey(llamaConfig),
    toolExecution: 'sequential',
  });
  return Object.assign(holder, { agent, config: llamaConfig, summary, toolKey: toolKeyFor(llamaConfig) });
}

// Reuse the channel's agent. Rebuild it after !reloadconfig, and load it from the database after a restart.
function getChannelAgent(channel: string, llamaConfig: LlamaConfig): ChannelAgent {
  const existing = agents.get(channel);
  if (existing?.config === llamaConfig) return existing;

  let messages: AgentMessage[];
  let summary: string;
  let toolKey: string;
  if (existing) {
    messages = existing.agent.state.messages.filter(m => m.role !== 'system');
    summary = existing.summary;
    toolKey = existing.toolKey;
  } else {
    const saved = loadConversation(channel);
    messages = (saved?.messages ?? []) as AgentMessage[];
    summary = saved?.summary ?? '';
    toolKey = saved?.tools ?? '';
  }

  // Models trust their own earlier replies over the tool list, so after tools change, an old
  // "I can't do that" keeps getting repeated. Start the conversation fresh instead.
  if ((messages.length > 0 || summary) && toolKey !== toolKeyFor(llamaConfig)) {
    console.log(`llamacpp plugin: tools changed, starting a fresh conversation in ${channel}`);
    messages = [];
    summary = '';
  }

  const entry = createChannelAgent(channel, llamaConfig, messages, summary);
  agents.set(channel, entry);
  return entry;
}

function persist(channel: string, entry: ChannelAgent) {
  saveConversation(channel, entry.agent.state.messages.filter(m => m.role !== 'system'), entry.summary, entry.toolKey);
}

// Ask the model to fold `older` into the running summary
async function summarize(older: AgentMessage[], previousSummary: string, llamaConfig: LlamaConfig): Promise<string> {
  const conversation = serializeConversation(older.filter((m): m is Message => m.role !== 'system'));
  const request = `${previousSummary ? `Previous summary:\n${previousSummary}\n\n` : ''}Older conversation:\n${conversation}`;
  const context = normalizeContext({
    systemPrompt: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: request, timestamp: Date.now() }],
  });
  const reply = await streamSimple(buildModel(llamaConfig), context, {
    apiKey: apiKey(llamaConfig),
    maxTokens: 4096, // room for a thinking model to think before writing the summary
    signal: AbortSignal.timeout((llamaConfig.timeoutSeconds ?? 60) * 2000),
  }).result();
  const text = reply.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('').trim();
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted' || !text) {
    throw new Error(`summary failed (${reply.stopReason}${reply.errorMessage ? `: ${reply.errorMessage}` : ''})`);
  }
  return text;
}

// Keep the last `maxHistoryExchanges` exchanges word for word (fewer if they're over the token budget)
// and fold everything older into the summary
async function compact(entry: ChannelAgent, llamaConfig: LlamaConfig) {
  const maxExchanges = llamaConfig.maxHistoryExchanges ?? 0;
  const messages = entry.agent.state.messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const history = messages.slice(system.length);

  if (maxExchanges <= 0) {
    // History is off: nothing carries over between questions
    entry.agent.state.messages = system;
    entry.summary = '';
    return;
  }

  const contextWindow = llamaConfig.contextWindow ?? 8192;
  const budget = llamaConfig.compactAtTokens ?? Math.min(Math.floor(contextWindow / 2), 16000);
  const exchangeStarts = history.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  let keepFrom = exchangeStarts.length > maxExchanges ? exchangeStarts[exchangeStarts.length - maxExchanges] : 0;
  // Keep dropping the oldest kept exchange while over budget, but always keep the latest one
  for (const start of exchangeStarts) {
    if (start <= keepFrom) continue;
    if (estimateContextTokens(history.slice(keepFrom)).tokens <= budget) break;
    keepFrom = start;
  }
  if (keepFrom === 0) return;

  const older = history.slice(0, keepFrom);
  try {
    entry.summary = await summarize(older, entry.summary, llamaConfig);
    console.log(`llamacpp plugin: summarized ${older.length} older messages`);
  } catch (err) {
    // Usually the server is down or restarting. Keep the history and try again after the next reply,
    // unless it has grown so big it would no longer fit in the context window.
    if (estimateContextTokens(history).tokens < contextWindow * 0.75) {
      console.error('llamacpp plugin: could not summarize older history, will retry later:', err);
      return;
    }
    console.error('llamacpp plugin: could not summarize older history and it is too big to keep, dropping it:', err);
  }
  entry.agent.state.messages = [...system, ...history.slice(keepFrom)];
}

function buildChannelContext(channel: string, bot: IrcClient, contextLimit: number): string {
  if (contextLimit <= 0) return '';
  const recentMessages = channelMessages.get(channel) ?? [];

  // Get active nicknames from IRC client's channel user list (excluding the bot itself)
  const users = bot.chans[channel]?.users;
  const activeNicks = users ? Object.keys(users).filter(nick => nick !== bot.nick) : [];

  if (recentMessages.length === 0 && activeNicks.length === 0) return '';

  let contextContent = 'Channel Context:\n';
  if (activeNicks.length > 0) {
    contextContent += `Active users: ${activeNicks.join(', ')}\n`;
  }
  if (recentMessages.length > 0) {
    contextContent += '\nRecent conversation:\n';
    for (const msg of recentMessages) {
      contextContent += `${msg.nick}: ${msg.message}\n`;
    }
  }
  return contextContent.trim();
}

// Once the model has answered about an image, keep only a note of it. Otherwise every later question
// resends the whole image, and the saved history fills up with base64.
function dropImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(m => {
    if ((m.role !== 'user' && m.role !== 'toolResult') || typeof m.content === 'string') return m;
    if (!m.content.some(block => block.type === 'image')) return m;
    return {
      ...m,
      content: m.content.map(block =>
        block.type === 'image' ? { type: 'text' as const, text: '(image no longer attached; your earlier reply describes it)' } : block),
    } as AgentMessage;
  });
}

// Only send reasoning from the turn being answered, so it can follow its own tool calls. Some servers
// (Strata's Qwen template with preserve_thinking) otherwise replay every earlier turn's thinking, and after
// a few "<think>...let me give a concise answer</think> Sepsis" turns the model learns to stop after one word.
function dropOldThinking<T extends { role: string }>(messages: T[]): T[] {
  const lastUser = messages.map(m => m.role).lastIndexOf('user');
  return messages.map((m, i) => {
    if (i > lastUser || m.role !== 'assistant') return m;
    const { content } = m as unknown as AssistantMessage;
    return { ...m, content: content.filter(block => block.type !== 'thinking') };
  });
}

const textOf = (message: AgentMessage | undefined) =>
  message?.role === 'assistant'
    ? message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('').trim()
    : '';

async function answer(to: string, from: string, userMessage: string, channelContext: string, bot: IrcClient, llamaConfig: LlamaConfig) {
  const entry = getChannelAgent(to, llamaConfig);
  const agent = entry.agent;
  entry.asker = from;
  const timeoutSeconds = llamaConfig.timeoutSeconds ?? 60;
  const maxToolTurns = llamaConfig.maxToolTurns ?? 5;

  // The system prompt, the summary of older conversation, and this request's channel context,
  // sent as the one leading system message
  const systemText = [
    llamaConfig.systemPrompt ?? '',
    toolGuidance(toolGroupsFor(llamaConfig)),
    entry.summary && `Summary of earlier conversation with you here:\n${entry.summary}`,
    channelContext,
  ].filter(Boolean).join('\n\n');
  agent.prepareRequest = ({ context: original }) => {
    const context = { ...original, messages: dropOldThinking(original.messages) };
    const [first, ...rest] = context.messages;
    if (first?.role === 'system') {
      return { context: { ...context, messages: [{ ...first, content: systemText }, ...rest] } };
    }
    if (!systemText) return { context };
    return { context: { ...context, messages: [{ role: 'system', content: systemText, timestamp: Date.now() }, ...context.messages] } };
  };

  // Stop runaway tool loops
  let turns = 0;
  let hitTurnLimit = false;
  agent.finishTurn = ({ message: reply }) => {
    turns++;
    if (reply.stopReason === 'toolUse' && turns >= maxToolTurns) {
      hitTurnLimit = true;
      return { action: 'end' };
    }
    return undefined;
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutSeconds * 1000);

  const startIndex = agent.state.messages.length;
  let newMessages: AgentMessage[] = [];
  let failed = false;
  try {
    await agent.prompt(`${from}: ${userMessage}`);
  } catch (err) {
    console.error('llamacpp plugin error:', err);
    failed = true;
  } finally {
    clearTimeout(timer);
    newMessages = agent.state.messages.slice(startIndex);
  }

  await sayLines(bot, to, replyLines(newMessages, { failed, timedOut, hitTurnLimit, llamaConfig }));

  // If the question never got an answer (server down or restarting, error, timeout), take it back out,
  // so the saved history only holds real exchanges and is left as it was before the outage
  const lastReply = newMessages.filter(m => m.role === 'assistant').at(-1);
  const stopReason = lastReply?.role === 'assistant' ? lastReply.stopReason : undefined;
  if (failed || timedOut || stopReason === 'error' || stopReason === 'aborted') {
    agent.state.messages = agent.state.messages.slice(0, startIndex);
    return;
  }

  // Summarize and save after replying, so the person asking doesn't wait for it
  agent.state.messages = dropImages(agent.state.messages);
  await compact(entry, llamaConfig);
  persist(to, entry);
}

function replyLines(newMessages: AgentMessage[], run: { failed: boolean; timedOut: boolean; hitTurnLimit: boolean; llamaConfig: LlamaConfig }): string[] {
  const { llamaConfig } = run;
  for (const m of newMessages) {
    if (m.role === 'toolResult') console.log(`llamacpp plugin: tool ${m.toolName}${m.isError ? ' failed' : ''}`);
  }
  const lastReply = newMessages.filter(m => m.role === 'assistant').at(-1);

  if (run.failed) {
    return ['Sorry, I encountered an error while processing your request.'];
  }
  if (run.timedOut) {
    return [`Request timed out after ${llamaConfig.timeoutSeconds ?? 60} seconds. The model may be taking too long to respond.`];
  }
  if (lastReply?.role === 'assistant' && lastReply.stopReason === 'error') {
    console.error('llamacpp plugin: model error:', lastReply.errorMessage);
    if (/connection error|ECONNREFUSED|fetch failed|\b50[23]\b|loading model/i.test(lastReply.errorMessage ?? '')) {
      return ['The LLM server isn\'t available right now (it may be restarting or loading the model). Try again in a minute.'];
    }
    return [`LLM error: ${lastReply.errorMessage ?? 'unknown error'}`];
  }

  const reply = textOf(lastReply);
  if (!reply) {
    const stopReason = lastReply?.role === 'assistant' ? lastReply.stopReason : 'no reply';
    const thought = lastReply?.role === 'assistant' && lastReply.content.some(block => block.type === 'thinking');
    console.error('llamacpp plugin: empty reply:', JSON.stringify(lastReply));
    if (run.hitTurnLimit) {
      return [`Gave up after ${llamaConfig.maxToolTurns ?? 5} rounds of tool calls without an answer.`];
    }
    if (stopReason === 'length') {
      return [`Ran out of tokens${thought ? ' while thinking' : ''} before answering (maxTokens is ${llamaConfig.maxTokens ?? 1024}).`];
    }
    return [`The model returned an empty response (stop reason: ${stopReason}${thought ? ', it only produced thinking' : ''}).`];
  }

  const lines = splitIntoLines(reply);
  const maxLines = llamaConfig.maxReplyLines ?? 3;
  return lines.length > maxLines ? [...lines.slice(0, maxLines), '... (response truncated)'] : lines;
}

// Messages someone asked the bot to pass on when this person next spoke
function deliverTells(bot: IrcClient, channel: string, nick: string) {
  const tells = takeTellsFor(channel, nick);
  if (tells.length === 0) return;
  void sayLines(bot, channel, tells.map(t => `${nick}: ${t.from_nick} asked me to tell you (${ago(t.created_at)}): ${t.message}`));
}

function startReminderTimer(bot: IrcClient) {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    let due: Delivery[];
    try {
      due = takeDueReminders(Date.now());
    } catch (err) {
      console.error('llamacpp plugin: could not check reminders:', err);
      return;
    }
    for (const r of due) {
      const from = r.from_nick.toLowerCase() === r.to_nick.toLowerCase() ? 'you asked me to remind you' : `${r.from_nick} asked me to remind you`;
      bot.say(r.channel, `${r.to_nick}: reminder (${from} ${ago(r.created_at)}): ${r.message}`);
    }
  }, 15_000);
}

const llamacpp: Plugin = {
  name: 'llamacpp',
  onJoin: ({ bot }) => {
    // The bot joining its channels at startup is the first chance to start the reminder timer
    startReminderTimer(bot);
  },
  onMessage: async ({ from, to, message, bot, config }) => {
    const llamaConfig = config.llamacpp;
    if (!llamaConfig) {
      return; // Silently skip if not configured
    }

    // Never react to the bot's own messages
    if (from === bot.nick) return;

    startReminderTimer(bot);
    if (isChannelName(to)) {
      recordSeen(to, from, message);
      deliverTells(bot, to, from);
    }

    const contextLimit = llamaConfig.channelContextMessages ?? 0;

    // Check for !forget command to clear the conversation (saved notes are kept)
    if (message.toLowerCase() === `${config.prefix}forget`) {
      agents.get(to)?.agent.abort();
      agents.delete(to);
      channelMessages.delete(to);
      deleteConversation(to);
      bot.say(to, 'Conversation history cleared. (Saved notes are kept.)');
      return;
    }

    // Check if message is addressed to the bot (with :, comma, or space after nickname)
    const addressPattern = new RegExp(`^${escapeRegExp(bot.nick)}\\s*[:\\s,]\\s*(.+)`, 'i');
    const userMessage = message.match(addressPattern)?.[1].trim();

    if (!userMessage) {
      // Not addressed to the bot; just remember it as channel context
      trackChannelMessage(to, from, message, contextLimit);
      return;
    }

    // Snapshot the context before this question is added to it
    const channelContext = buildChannelContext(to, bot, contextLimit);
    if ((llamaConfig.maxHistoryExchanges ?? 0) <= 0) {
      // Without history, keep the question as channel context for later replies
      trackChannelMessage(to, from, message, contextLimit);
    }

    const queued = (queues.get(to) ?? Promise.resolve())
      .then(() => answer(to, from, userMessage, channelContext, bot, llamaConfig))
      .catch(err => console.error('llamacpp plugin error:', err));
    queues.set(to, queued);
    await queued;
    if (queues.get(to) === queued) queues.delete(to);
  },
  unload: () => {
    // Conversations are already saved after every reply; just stop work in progress
    for (const { agent } of agents.values()) agent.abort();
    agents.clear();
    queues.clear();
    channelMessages.clear();
    clearInterval(reminderTimer);
    reminderTimer = undefined;
    console.log('llamacpp plugin: unloaded (conversations stay saved in data/bot.db)');
  },
};

export default llamacpp;
