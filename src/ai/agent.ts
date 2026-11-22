// In-app chat: Claude edits the scene through the tools in toolSpecs.ts.
// The loop is written by hand so we fully control history (append-only),
// validation of every tool input, and undo checkpoints.
//
// Bring-your-own-key: the request goes straight from the browser to the
// Anthropic API with the user's key, which is stored only in localStorage.
// (Users with a Claude subscription can use Claude Code instead: see bridge/.)

import Anthropic from '@anthropic-ai/sdk';
import { useStore } from '../model/store';
import { viewportApi } from '../ui/viewportApi';
import { SYSTEM_PROMPT } from './prompt';
import { jsonSchemaOf, TOOL_SPECS, type ToolName, type ToolOutput } from './toolSpecs';
import { callTool, sceneContext, summarize } from './tools';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam['content'];

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string; ok: boolean }
  | { kind: 'error'; text: string };

// In the API flow the scene arrives with every user message, so get_scene is not offered.
const API_TOOLS: Anthropic.Beta.BetaTool[] = (Object.keys(TOOL_SPECS) as ToolName[])
  .filter((n) => n !== 'get_scene')
  .map((name) => ({
    name,
    description: TOOL_SPECS[name].description,
    input_schema: jsonSchemaOf(name) as Anthropic.Beta.BetaTool['input_schema'],
  }));

function toApiContent(out: ToolOutput): ToolResultContent {
  const parts = Array.isArray(out) ? out : [out];
  return parts.map((p) =>
    typeof p === 'string'
      ? { type: 'text' as const, text: p }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: p.image } },
  );
}

let history: MessageParam[] = [];
let abort: AbortController | null = null;

export function resetConversation() {
  history = [];
}
export function stopAgent() {
  abort?.abort();
}

export async function runAgent(userText: string, emit: (e: ChatEvent) => void): Promise<void> {
  const { settings, checkpoint } = useStore.getState();
  if (!settings.apiKey) {
    emit({ kind: 'error', text: 'Add your Anthropic API key in Settings, or drive Fabbrico from Claude Code (see README).' });
    return;
  }
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  checkpoint(); // one undo step for the whole AI turn
  abort = new AbortController();

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const shot = viewportApi.capture('current');
  if (shot) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot } });
  content.push({ type: 'text', text: `<context>${await sceneContext()}</context>\n\n${userText}` });
  // On any abnormal exit we drop this whole turn, so the history always stays
  // a valid, append-only conversation (the scene itself is re-sent each turn).
  const startLen = history.length;
  const rollback = () => {
    history.length = startLen;
  };
  history.push({ role: 'user', content });

  try {
    for (let step = 0; step < 25; step++) {
      const res = await client.beta.messages.create(
        {
          model: settings.model,
          max_tokens: 16000,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: API_TOOLS,
          messages: history,
          output_config: { effort: settings.effort },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: abort.signal },
      );
      history.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

      for (const b of res.content) if (b.type === 'text' && b.text.trim()) emit({ kind: 'assistant', text: b.text });

      if (res.stop_reason === 'refusal') {
        emit({ kind: 'error', text: 'The model declined this request.' });
        rollback();
        return;
      }
      if (res.stop_reason === 'max_tokens') {
        emit({ kind: 'error', text: 'The reply was cut off (max tokens). Try a smaller request.' });
        rollback();
        return;
      }
      if (res.stop_reason === 'pause_turn') continue;

      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!calls.length) return;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          const out = await callTool(call.name, call.input);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: toApiContent(out) });
          emit({ kind: 'tool', name: call.name, summary: summarize(call.name, call.input), ok: true });
        } catch (e) {
          const msg = (e as Error).message;
          results.push({ type: 'tool_result', tool_use_id: call.id, content: msg, is_error: true });
          emit({ kind: 'tool', name: call.name, summary: `${summarize(call.name, call.input)} — ${msg}`, ok: false });
        }
      }
      history.push({ role: 'user', content: results });
    }
    emit({ kind: 'error', text: 'Stopped after 25 steps.' });
    rollback();
  } catch (e) {
    rollback();
    if (e instanceof Anthropic.APIUserAbortError) emit({ kind: 'error', text: 'Stopped.' });
    else if (e instanceof Anthropic.AuthenticationError) emit({ kind: 'error', text: 'Invalid API key.' });
    else if (e instanceof Anthropic.RateLimitError) emit({ kind: 'error', text: 'Rate limited, retry in a moment.' });
    else if (e instanceof Anthropic.APIError) emit({ kind: 'error', text: `API error ${e.status}: ${e.message}` });
    else emit({ kind: 'error', text: (e as Error).message });
  } finally {
    abort = null;
  }
}
