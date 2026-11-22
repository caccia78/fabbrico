// Browser end of the Claude Code bridge.
// The local bridge (bridge/server.ts) is an MCP server that Claude Code
// starts; it forwards each tool call over a localhost WebSocket to this page,
// which runs it on the live scene and sends the result back.

import { create } from 'zustand';
import { useStore } from '../model/store';
import { callTool, summarize } from './tools';
import type { ChatEvent } from './agent';

export const BRIDGE_PORT = 5180;

const MUTATING = new Set(['add_object', 'update_object', 'delete_objects', 'group_objects', 'ungroup', 'place_on_bed', 'orient_for_print', 'duplicate_objects']);
/** Calls closer together than this are treated as one AI turn = one undo step. */
const TURN_GAP_MS = 20_000;

interface BridgeState {
  connected: boolean;
  events: ChatEvent[];
}
export const useBridge = create<BridgeState>(() => ({ connected: false, events: [] }));

const push = (e: ChatEvent) => useBridge.setState((s) => ({ events: [...s.events.slice(-200), e] }));

let lastCall = 0;
let started = false;

export function startBridge() {
  if (started) return;
  started = true;
  let delay = 1000;

  const connect = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    } catch {
      setTimeout(connect, delay);
      return;
    }
    ws.onopen = () => {
      delay = 1000;
      ws.send(JSON.stringify({ type: 'hello', app: 'fabbrico' }));
      useBridge.setState({ connected: true });
    };
    ws.onclose = () => {
      useBridge.setState({ connected: false });
      // Back off gently while Claude Code is not running.
      delay = Math.min(delay * 1.5, 3000);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = async (ev) => {
      let msg: { type: string; id: string; name: string; input: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type !== 'call') return;

      const now = Date.now();
      if (MUTATING.has(msg.name) && now - lastCall > TURN_GAP_MS) useStore.getState().checkpoint();
      lastCall = now;

      try {
        const output = await callTool(msg.name, msg.input);
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, output }));
        if (msg.name !== 'get_scene') push({ kind: 'tool', name: msg.name, summary: summarize(msg.name, msg.input), ok: true });
      } catch (e) {
        const error = (e as Error).message;
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error }));
        push({ kind: 'tool', name: msg.name, summary: `${summarize(msg.name, msg.input)} — ${error}`, ok: false });
      }
    };
  };
  connect();
}
