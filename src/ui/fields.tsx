import { useEffect, useState } from 'react';
import { ChamferEdges, DisplaceFaces, FontNames, ImageModes, TeardropTips, TextAligns } from '../model/schema';

export function NumInput({ value, onCommit, step = 1 }: { value: number; onCommit: (v: number) => void; step?: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(draft);
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      className="num"
      type="number"
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function VecInput({ value, onCommit, step }: { value: number[]; onCommit: (v: number[]) => void; step?: number }) {
  return (
    <div className="vec">
      {value.map((v, i) => (
        <NumInput
          key={i}
          value={v}
          step={step}
          onCommit={(nv) => {
            const next = [...value];
            next[i] = nv;
            onCommit(next);
          }}
        />
      ))}
    </div>
  );
}

export function TextInput({
  value,
  onCommit,
  multiline,
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const props = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => draft !== value && onCommit(draft),
  };
  return multiline ? <textarea rows={3} spellCheck={false} {...props} /> : <input type="text" {...props} />;
}

/** JSON editor for point lists like [[x,y], ...]. */
export function JsonInput({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const text = JSON.stringify(value);
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);
  useEffect(() => setDraft(text), [text]);
  return (
    <textarea
      rows={3}
      spellCheck={false}
      className={bad ? 'bad' : ''}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        try {
          const v = JSON.parse(draft);
          setBad(false);
          if (draft !== text) onCommit(v);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="row">
      <span>{label}</span>
      {children}
    </label>
  );
}

const ENUMS: Record<string, readonly string[]> = {
  pattern: ['noise', 'waves', 'ribs', 'knurl', 'bumps', 'cells', 'expression'],
  faces: DisplaceFaces,
  op: ['union', 'intersection'],
  edges: ChamferEdges,
  tip: TeardropTips,
  font: FontNames,
  align: TextAligns,
  mode: ImageModes,
};

/** Generic editor for a flat parameter object (shape or modifier). */
export function ParamEditor<T extends Record<string, unknown>>({
  value,
  skip,
  onChange,
}: {
  value: T;
  skip: string[];
  onChange: (v: T) => void;
}) {
  return (
    <>
      {Object.entries(value)
        .filter(([k]) => !skip.includes(k))
        .map(([k, v]) => {
          const set = (nv: unknown) => onChange({ ...value, [k]: nv });
          let input: React.ReactNode;
          if (ENUMS[k])
            input = (
              <select value={String(v)} onChange={(e) => set(e.target.value)}>
                {ENUMS[k].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            );
          else if (typeof v === 'boolean')
            input = <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />;
          else if (typeof v === 'number') input = <NumInput value={v} onCommit={set} step={0.1} />;
          else if (typeof v === 'string') input = <TextInput value={v} onCommit={set} multiline={v.length > 24 || k === 'expression'} />;
          else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) input = <VecInput value={v} onCommit={set} />;
          else input = <JsonInput value={v} onCommit={set} />;
          return (
            <Row key={k} label={k}>
              {input}
            </Row>
          );
        })}
    </>
  );
}
