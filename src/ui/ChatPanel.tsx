import { useEffect, useRef, useState } from 'react';
import { findNode, useStore } from '../model/store';
import { resetConversation, runAgent, stopAgent, type ChatEvent } from '../ai/agent';
import { useBridge } from '../ai/bridge';
import { ColumnResizer } from './ColumnResizer';

const SUGGESTIONS_SELECTED = [
  'Round the edges by 2 mm',
  'Add a knurled texture on the sides',
  'Shape it like a shark fin',
  'Add a 4.2 mm hole for an M3 insert in the centre',
  'Make it look organic, like a pebble',
];
const SUGGESTIONS_EMPTY = [
  'Make a small vase with a twisted ribbed surface',
  'Make a phone stand at 60°',
  'Create a cute ghost keychain with a ring',
];

export function ChatPanel() {
  const [log, setLog] = useState<ChatEvent[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const selected = useStore((s) => (s.selectedId ? findNode(s.nodes, s.selectedId) : null));
  const hasKey = useStore((s) => !!s.settings.apiKey);
  const bridgeOn = useBridge((s) => s.connected);
  const bridgeEvents = useBridge((s) => s.events);
  const entries = [...log, ...bridgeEvents];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log, bridgeEvents]);

  const send = async (msg: string) => {
    if (!msg.trim() || busy) return;
    setText('');
    setBusy(true);
    setLog((l) => [...l, { kind: 'user', text: msg }]);
    await runAgent(msg, (e) => setLog((l) => [...l, e]));
    setBusy(false);
  };

  // Other panels can ask the assistant something (e.g. the Diary tab: "propose experiences").
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const onAsk = (e: Event) => void sendRef.current((e as CustomEvent<string>).detail);
    window.addEventListener('fabbrico:ask', onAsk);
    return () => window.removeEventListener('fabbrico:ask', onAsk);
  }, []);

  const suggestions = selected ? SUGGESTIONS_SELECTED : SUGGESTIONS_EMPTY;

  return (
    <aside className="chat">
      <ColumnResizer side="right" />
      <header>
        <h3>
          AI assistant
          {bridgeOn && (
            <span className="badge" title="Claude Code is driving Fabbrico through the MCP bridge">
              ● Claude Code
            </span>
          )}
        </h3>
        <button
          className="small ghost"
          disabled={busy}
          onClick={() => {
            resetConversation();
            setLog([]);
            useBridge.setState({ events: [] });
          }}
        >
          New chat
        </button>
      </header>

      <div className="log">
        {!entries.length && (
          <div className="intro">
            <p>
              Select an object, then describe what you want: shape it, add surface details, cut functional features. Every
              AI turn is a single undo step (⌘Z).
            </p>
            {bridgeOn ? (
              <p className="ok">
                Connected to Claude Code. Write your requests in the Claude Code terminal: it sees what you select here.
              </p>
            ) : (
              !hasKey && (
                <p className="warn">
                  To start, either run <code>claude</code> in the project folder (uses your Claude subscription), or add an
                  Anthropic API key in ⚙ Settings.
                </p>
              )
            )}
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className={`msg ${e.kind} ${e.kind === 'tool' && !e.ok ? 'failed' : ''}`}>
            {e.kind === 'tool' ? (
              <>
                <span className="tool-dot">{e.ok ? '⚙' : '⚠'}</span> {e.summary}
              </>
            ) : (
              e.text
            )}
          </div>
        ))}
        {busy && <div className="msg thinking">Working…</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="target">
          {selected ? (
            <>
              Target: <span className="chip">{selected.name}</span>
            </>
          ) : (
            <span className="muted">No selection: the AI works on the whole scene</span>
          )}
        </div>
        <div className="suggestions">
          {suggestions.map((s) => (
            <button key={s} className="sugg" disabled={busy} onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="input-row">
          <textarea
            rows={2}
            placeholder={selected ? `What should I do with "${selected.name}"?` : 'Describe what to make or change…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          {busy ? (
            <button className="primary" onClick={stopAgent}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!text.trim()} onClick={() => send(text)}>
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
