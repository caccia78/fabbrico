// "Diary" tab (experimental): the print attempts of the project with their
// outcomes, and the experiences the AI proposed from them.

import { useState } from 'react';
import {
  addAttemptPhoto,
  OUTCOME_ICON,
  OUTCOME_LABEL,
  OUTCOMES,
  recordAttempt,
  removeAttempt,
  removeAttemptPhoto,
  removeProposal,
  setMaterial,
  setOutcome,
  useDiary,
  type Attempt,
  type Proposal,
} from '../model/diary';
import { saveProposal, useLibrary } from '../model/library';
import { KIND_LABEL } from '../model/experienceSchema';
import { pickPhotoFiles } from '../model/references';
import { useStore } from '../model/store';
import { useBridge } from '../ai/bridge';
import { runAction } from './runAction';

export const HARVEST_PROMPT =
  'Read the project diary and propose experiences for my library: what we learnt from these attempts (fits and tolerances, techniques, components, solved problems).';

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const VIA: Record<string, string> = { '3mf': 'exported 3MF', stl: 'exported STL', manual: 'recorded by hand' };
const viaLabel = (v: string) => VIA[v] ?? (v.startsWith('slicer:') ? `sent to ${v.slice(7)}` : v);

function PhotoView({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-img">
          <img src={src} alt="" />
        </div>
        <div className="modal-actions">
          <button className="small primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function AttemptCard({ a, onView }: { a: Attempt; onView: (src: string) => void }) {
  const [note, setNote] = useState(a.outcome?.note ?? '');
  const [open, setOpen] = useState(false);
  const commitNote = () => {
    if (a.outcome && note !== a.outcome.note) setOutcome(a.id, { ...a.outcome, note });
  };
  const pick = (r: (typeof OUTCOMES)[number]) =>
    setOutcome(a.id, a.outcome?.result === r ? null : { result: r, note, source: 'fabbrico' });

  return (
    <div className={`attempt ${a.outcome ? `out-${a.outcome.result}` : 'out-none'}`}>
      <div className="attempt-head">
        {a.render ? <img className="attempt-render" src={a.render} alt="" onClick={() => onView(a.render)} /> : <span className="attempt-render" />}
        <div className="attempt-title">
          <b>
            #{a.n} · {a.plate}
          </b>
          <span className="muted">
            {when(a.at)} · {viaLabel(a.via)}
          </span>
          <span className="muted">
            {a.context.printer} · {a.context.material || '?'} · ⌀{a.context.nozzle}
          </span>
        </div>
      </div>
      {a.previous > 0 && (
        <div className="attempt-changes" onClick={() => setOpen(!open)} title="Changes since the previous attempt of this plate">
          {a.changes.length ? (
            <>
              <span className="muted">vs #{a.previous}:</span> {(open ? a.changes : a.changes.slice(0, 2)).join(' · ')}
              {!open && a.changes.length > 2 && <span className="muted"> +{a.changes.length - 2} more</span>}
            </>
          ) : (
            <span className="muted">vs #{a.previous}: no geometry change (other printer or material)</span>
          )}
        </div>
      )}
      <div className="outcome-row">
        {OUTCOMES.map((r) => (
          <button key={r} className={`small chip ${a.outcome?.result === r ? 'active' : ''}`} title={OUTCOME_LABEL[r]} onClick={() => pick(r)}>
            {OUTCOME_ICON[r]} {OUTCOME_LABEL[r]}
          </button>
        ))}
      </div>
      {a.outcome && (
        <input
          className="attempt-note"
          value={note}
          placeholder="How did it go? (e.g. enters with a bit of force, retainer clicks in)"
          onChange={(e) => setNote(e.target.value)}
          onBlur={commitNote}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {a.outcome && a.outcome.source !== 'fabbrico' && <div className="muted attempt-src">reported {a.outcome.source === 'chat' ? 'in the chat' : 'from the phone'}</div>}
      <div className="attempt-photos">
        {a.photos.map((p, k) => (
          <img
            key={k}
            src={p}
            alt=""
            title="Click to view, ⌥-click to remove"
            onClick={(e) => (e.altKey ? confirm('Remove this photo?') && removeAttemptPhoto(a.id, k) : onView(p))}
          />
        ))}
        <button
          className="small ghost"
          title="Photos of the real print (or send them from the phone: Print outcome)"
          onClick={() =>
            runAction(async () => {
              for (const f of await pickPhotoFiles()) await addAttemptPhoto(a.id, f);
            })
          }
        >
          + Photo
        </button>
        <span className="spacer" />
        <button className="small ghost danger" title="Delete this attempt" onClick={() => confirm(`Delete attempt #${a.n}?`) && removeAttempt(a.id)}>
          ✕
        </button>
      </div>
    </div>
  );
}

function ProposalCard({ p }: { p: Proposal }) {
  const [lang, setLang] = useState<'it' | 'en'>('it');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const libraryOn = useLibrary((s) => s.available);
  const allAttempts = useDiary((s) => s.attempts);
  const attempts = allAttempts.filter((a) => p.attempts.includes(a.n));
  const reported = attempts.filter((a) => a.outcome);
  const last = [...attempts].sort((a, b) => a.n - b.n).pop();
  const status = !reported.length ? 'hypothesis' : last?.outcome?.result === 'ok' ? 'confirmed' : 'tested';

  return (
    <div className="proposal">
      <div className="proposal-head">
        <span className="tag">{KIND_LABEL[p.kind]}</span>
        <span className={`tag status-${status}`} title="From the outcomes you reported">{status}</span>
        <span className="spacer" />
        <button className="small ghost" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} title="Language">
          {lang.toUpperCase()}
        </button>
      </div>
      <b>{p.title[lang]}</b>
      <p className="muted proposal-summary">{p.summary[lang]}</p>
      {Object.keys(p.values).length > 0 && (
        <div className="proposal-values">
          {Object.entries(p.values).map(([k, v]) => (
            <code key={k}>
              {k}: {v}
            </code>
          ))}
        </div>
      )}
      <div className="muted proposal-meta">
        Attempts {p.attempts.map((n) => `#${n}`).join(', ') || '—'} · {p.objectIds.length ? `model: ${p.objectIds.length} object(s)` : 'no model'}
        {p.tags.length ? ` · ${p.tags.join(', ')}` : ''}
      </div>
      {open && <pre className="exp-text">{p.body[lang]}</pre>}
      <div className="proposal-actions">
        <button className="small ghost" onClick={() => setOpen(!open)}>{open ? 'Hide text' : 'Read text'}</button>
        <span className="spacer" />
        <button className="small ghost danger" onClick={() => confirm('Discard this proposal?') && removeProposal(p.id)}>Discard</button>
        <button
          className="small primary"
          disabled={!libraryOn || saving}
          title={libraryOn ? 'Save it in the experience library on this computer' : 'The library needs Fabbrico started with npm start'}
          onClick={() =>
            runAction(async () => {
              setSaving(true);
              try {
                await saveProposal(p);
              } finally {
                setSaving(false);
              }
            })
          }
        >
          {saving ? 'Saving…' : 'Keep'}
        </button>
      </div>
    </div>
  );
}

export function DiaryPanel() {
  const attempts = useDiary((s) => s.attempts);
  const proposals = useDiary((s) => s.proposals);
  const material = useDiary((s) => s.material);
  const hasNodes = useStore((s) => s.nodes.length > 0);
  const hasKey = useStore((s) => !!s.settings.apiKey);
  const bridgeOn = useBridge((s) => s.connected);
  const [viewing, setViewing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A series closed well: the latest outcome is "good" and that plate was printed more than once.
  const latest = [...attempts].reverse().find((a) => a.outcome);
  const seriesClosed = latest?.outcome?.result === 'ok' && attempts.filter((a) => a.plate === latest.plate).length > 1 && !proposals.length;

  const harvest = () => {
    if (hasKey && !bridgeOn) {
      window.dispatchEvent(new CustomEvent('fabbrico:ask', { detail: HARVEST_PROMPT }));
      return;
    }
    void navigator.clipboard.writeText('proponi esperienze dal diario').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <div className="diary">
      <div className="diary-bar">
        <label title="Material of the next prints, recorded with each attempt">
          Material <input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="PLA" />
        </label>
        <span className="spacer" />
        <button
          className="small"
          disabled={!hasNodes}
          title="Record the current plate as a print attempt (exports and Send to slicer do it by themselves)"
          onClick={() => runAction(() => recordAttempt('manual'))}
        >
          + Attempt
        </button>
      </div>

      {(seriesClosed || proposals.length > 0 || attempts.some((a) => a.outcome)) && (
        <div className={`harvest ${seriesClosed ? 'hot' : ''}`}>
          {seriesClosed && <p>This series ended well. Turn what you learnt into experiences?</p>}
          <button className="small" onClick={harvest} title={hasKey && !bridgeOn ? HARVEST_PROMPT : 'Copies a request to paste in Claude Code'}>
            {copied ? 'Copied: paste it in Claude Code' : 'Propose experiences'}
          </button>
        </div>
      )}

      {proposals.length > 0 && (
        <section>
          <h4 className="diary-h">Proposed experiences</h4>
          {proposals.map((p) => (
            <ProposalCard key={p.id} p={p} />
          ))}
        </section>
      )}

      <section>
        <h4 className="diary-h">Attempts</h4>
        {attempts.length ? (
          [...attempts].reverse().map((a) => // Keyed on the outcome too, so the note field resets when the outcome changes elsewhere (phone, chat).
            <AttemptCard key={`${a.id}-${a.outcome?.at ?? ''}`} a={a} onView={setViewing} />)
        ) : (
          <p className="muted diary-empty">
            Each plate you export or send to the slicer is recorded here, with what changed since the last print. Then tell how it went (here, from the phone or in the chat): the outcomes become experiences for your library.
          </p>
        )}
      </section>
      {viewing && <PhotoView src={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
