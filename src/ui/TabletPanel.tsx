import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { newPairingToken, padUrl, removeTracing, removeTracings, setTracingLabel, useTablet, type Tracing } from '../tablet/connection';
import { combineTracings, extrudeTracing, strokeBounds } from '../tablet/build';
import { VIEWS, VIEW_HINTS, type View } from '../tablet/views';
import { runAction } from './runAction';
import { useDraggableWindow } from './useDraggableWindow';

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Preview({ strokes }: { strokes: number[][] }) {
  const b = strokeBounds(strokes);
  const pad = Math.max(b.w, b.h) * 0.08 + 1;
  return (
    <svg viewBox={`${b.x0 - pad} ${-b.y1 - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`} className="tracing-preview">
      {strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.reduce<string[]>((acc, v, k) => (k % 2 ? acc : [...acc, `${v},${-s[k + 1]}`]), []).join(' ')}
          fill="none"
          stroke="#4f8cff"
          strokeWidth={Math.max(b.w, b.h) / 120}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function TracingCard({ t, selected, onToggle }: { t: Tracing; selected: boolean; onToggle: () => void }) {
  const [height, setHeight] = useState(10);
  const b = strokeBounds(t.strokes);
  return (
    <div className={`tracing ${selected ? 'sel' : ''}`}>
      <label className="tracing-check" title="Select to combine with other views">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </label>
      <Preview strokes={t.strokes} />
      <div className="tracing-info">
        <select value={t.label} onChange={(e) => setTracingLabel(t.id, e.target.value as View)} title={VIEW_HINTS[t.label]}>
          {VIEWS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <small className="muted">
          {Math.round(b.w)} × {Math.round(b.h)} mm · {new Date(t.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </small>
        <div className="tracing-actions">
          <label className="unit-field" title="Extrusion height">
            <span className="muted">height</span>
            <input type="number" min={0.4} step={0.5} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
            <span className="muted">mm</span>
          </label>
          <button className="small" onClick={() => runAction(() => extrudeTracing(t, height))} title="Extrude this outline straight up by the height">
            Extrude
          </button>
          <button className="icon" title="Delete" onClick={() => removeTracing(t.id)}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

/** What each kind of device can do: the same QR code opens a different page on each. */
function DeviceKinds({ devices }: { devices: string[] }) {
  const n = (k: string) => devices.filter((d) => d === k).length;
  return (
    <div className="device-kinds">
      <div className={`device-kind ${n('tablet') ? 'on' : ''}`}>
        <b>📲 Tablet</b> <span className="muted">iPad + Apple Pencil{n('tablet') ? ` · ${n('tablet')} connected` : ''}</span>
        <ul>
          <li>Trace objects with the pencil</li>
          <li>Sketch a part with its dimensions: the AI models it</li>
          <li>Photos · measurement notes · AR preview</li>
        </ul>
      </div>
      <div className={`device-kind ${n('phone') ? 'on' : ''}`}>
        <b>📱 Phone</b> <span className="muted">iPhone or any phone{n('phone') ? ` · ${n('phone')} connected` : ''}</span>
        <ul>
          <li>Photos · measurement notes · AR preview</li>
          <li className="muted">No tracing: the screen is too small</li>
        </ul>
      </div>
    </div>
  );
}

/** Pair a tablet or phone (QR code) and turn received tracings into objects. */
export function TabletPanel({ onClose }: { onClose: () => void }) {
  const { online, pads, devices, inbox } = useTablet();
  const [url, setUrl] = useState<{ url: string; addresses: string[] } | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, setRefresh] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [combineNote, setCombineNote] = useState('');
  const { ref: winRef, style: winStyle, handle: winHandle } = useDraggableWindow('fabbrico.tablet.window');

  useEffect(() => {
    let live = true;
    void padUrl().then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, []);

  const chosen = inbox.filter((t) => selected.has(t.id));
  const distinct = new Set(chosen.map((t) => t.label)).size === chosen.length;

  return (
    <div className="modal tablet-modal floating" ref={winRef} style={winStyle}>
        <header className="tablet-head" {...winHandle} title="Drag to move">
          <h3>⠿ Devices</h3>
          <span>
            <button className="icon" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? '▾' : '▴'}
            </button>
            <button className="icon" title="Close" onClick={onClose}>
              ✕
            </button>
          </span>
        </header>
        <div className="tablet-body" hidden={collapsed}>
          <section className="pairing">
            {url === undefined ? (
              <p className="muted">Looking for this computer's network address…</p>
            ) : url === null ? (
              <p className="muted">
                The tablet link needs Fabbrico's own server: start Fabbrico with <code>./start.sh</code> (or <code>npm run dev</code>).
              </p>
            ) : !url.url ? (
              <p className="muted">This computer doesn't seem to be on a network.</p>
            ) : (
              <>
                <Qr text={url.url} />
                <p className="muted small">
                  Scan with the camera of a tablet or a phone (same Wi-Fi): each gets its own page. To keep it as an app: in
                  Safari tap Share → “Add to Home Screen”.
                </p>
                <code className="url">{url.url.replace(/\?t=.*/, '?t=…')}</code>
                {url.addresses.length > 1 && (
                  <details>
                    <summary className="muted small">Other addresses</summary>
                    {url.addresses.slice(1).map((a) => (
                      <code key={a} className="url">
                        {a.replace(/\?t=.*/, '?t=…')}
                      </code>
                    ))}
                  </details>
                )}
              </>
            )}
            <p className="small">
              <span className={`status-dot ${online ? 'on' : ''}`} /> {online ? 'Ready' : 'Not connected'} ·{' '}
              {pads ? `${pads} device${pads > 1 ? 's' : ''} connected` : 'no device connected'}
            </p>
            <button
              className="small ghost"
              title="Make a new code: tablets paired with the old one are disconnected"
              onClick={() => {
                if (!confirm('Make a new pairing code? Tablets and phones will need to scan the new QR code.')) return;
                newPairingToken();
                void padUrl().then(setUrl);
                setRefresh((n) => n + 1);
              }}
            >
              New pairing code
            </button>
            <DeviceKinds devices={devices} />
            <p className="muted small">Photos and notes from any device go to the Files tab.</p>
          </section>

          <section className="inbox">
            <div className="inbox-head">
              <h4>Received tracings</h4>
              {inbox.length > 0 && (
                <span className="inbox-actions">
                <button
                  className="small ghost"
                  title={chosen.length === inbox.length ? 'Deselect all tracings' : 'Select all tracings'}
                  onClick={() => setSelected(chosen.length === inbox.length ? new Set() : new Set(inbox.map((t) => t.id)))}
                >
                  {chosen.length === inbox.length ? 'Select none' : 'Select all'}
                </button>
                <button
                  className="small ghost danger"
                  title={chosen.length ? 'Delete the selected tracings' : 'Delete all received tracings'}
                  onClick={() => {
                    const n = chosen.length || inbox.length;
                    if (!confirm(`Delete ${chosen.length ? `the ${n} selected` : `all ${n}`} tracing${n > 1 ? 's' : ''}? Objects already made from them stay.`)) return;
                    removeTracings(chosen.length ? new Set(chosen.map((t) => t.id)) : undefined);
                    setSelected(new Set());
                  }}
                >
                  {chosen.length ? `Delete selected (${chosen.length})` : 'Delete all'}
                </button>
                </span>
              )}
            </div>
            {!inbox.length && (
              <p className="muted small">
                Put an object on the iPad, trace around it with the pencil and tap “Send to Fabbrico”. Set the view to the
                side facing up; flip the object and trace again to capture it from several sides.
              </p>
            )}
            <div className="tracing-list">
              {inbox.map((t) => (
                <TracingCard
                  key={t.id}
                  t={t}
                  selected={selected.has(t.id)}
                  onToggle={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    })
                  }
                />
              ))}
            </div>
            {inbox.length > 1 && (
              <div className="combine">
                <button
                  className="primary small"
                  disabled={chosen.length < 2 || !distinct}
                  title={!distinct ? 'Each selected tracing needs a different view' : 'Intersect the selected views into one object'}
                  onClick={() =>
                    runAction(async () => {
                      const { turned } = await combineTracings(chosen);
                      setSelected(new Set());
                      setCombineNote(
                        turned.length
                          ? `Turned to match the other views: ${turned.join(', ')} (the object was placed rotated on the tablet).`
                          : '',
                      );
                    })
                  }
                >
                  Combine {chosen.length >= 2 ? chosen.length : ''} views into one object
                </button>
                {!distinct && <small className="warn-text">Each selected tracing needs a different view.</small>}
                {distinct && combineNote && <small className="muted">{combineNote}</small>}
              </div>
            )}
          </section>
        </div>
    </div>
  );
}
