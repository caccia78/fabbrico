import { useEffect, useState } from 'react';
import { CUSTOM, PRINTERS, bedLabel, printerById } from '../model/printers';
import { useStore } from '../model/store';
import type { PrintReport } from '../geometry/analysis';
import { geometry } from '../geometry/client';
import { newProject, openProject, saveProject } from '../model/project';
import { runAction } from './runAction';
import { TabletPanel } from './TabletPanel';
import { useTablet } from '../tablet/connection';
import { nextTheme, THEME_ICON, THEME_LABEL } from './theme';
import type { Theme } from '../model/store';
import { loadLocalActions, openExportFolder, openInSlicer, useLocalActions } from './localActions';
import { recordAttempt } from '../model/diary';

function ProjectControls() {
  const project = useStore((s) => s.project);
  const setProjectName = useStore((s) => s.setProjectName);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="project">
      <input
        className="project-name"
        title="Project name"
        value={draft ?? project.name}
        size={Math.max(8, (draft ?? project.name).length)}
        onFocus={(e) => {
          setDraft(project.name);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) setProjectName(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            setTimeout(() => (e.target as HTMLInputElement).blur());
          }
        }}
      />
      <span className={`dirty ${project.dirty ? 'on' : ''}`} title={project.dirty ? 'Unsaved changes' : 'Saved'} />
      <button className="small ghost" title="New project" onClick={() => runAction(newProject)}>New</button>
      <button className="small ghost" title="Open project (⌘O)" onClick={() => runAction(openProject)}>Open</button>
      <button className="small ghost" title="Save project (⌘S) · Save as (⇧⌘S)" onClick={() => runAction(() => saveProject())}>
        Save
      </button>
    </div>
  );
}

/** Printer preset picker: sets the bed size (and nozzle). "Custom" opens Settings to type the sizes. */
function PrinterSelect({ onCustom, className }: { onCustom?: () => void; className?: string }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <select
      className={className}
      value={printerById(settings.printer) ? settings.printer : CUSTOM}
      title={`Printer: build volume ${bedLabel(settings.bed)}, nozzle ${settings.nozzle} mm`}
      onChange={(e) => {
        const p = printerById(e.target.value);
        if (p) setSettings({ printer: p.id, bed: [...p.bed], nozzle: p.nozzle });
        else {
          setSettings({ printer: CUSTOM });
          onCustom?.();
        }
      }}
    >
      {PRINTERS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.bed.join('×')}
        </option>
      ))}
      <option value={CUSTOM}>Custom{settings.printer === CUSTOM ? ` · ${settings.bed.join('×')}` : '…'}</option>
    </select>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [key, setKey] = useState(settings.apiKey);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label className="field">
          Anthropic API key
          <input type="password" value={key} placeholder="sk-ant-…" onChange={(e) => setKey(e.target.value)} />
          <small>
            Stored only in this browser (localStorage) and sent directly to api.anthropic.com. Don't use this on a shared
            computer.
          </small>
        </label>
        <label className="field">
          Model
          <input value={settings.model} onChange={(e) => setSettings({ model: e.target.value })} />
        </label>
        <label className="field">
          Theme
          <select value={settings.theme} onChange={(e) => setSettings({ theme: e.target.value as Theme })}>
            {(['dark', 'light', 'system'] as const).map((t) => (
              <option key={t} value={t}>
                {THEME_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Effort
          <select value={settings.effort} onChange={(e) => setSettings({ effort: e.target.value as 'medium' })}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <small>Higher effort = more careful modelling, slower and more expensive.</small>
        </label>
        <label className="field">
          Printer
          <PrinterSelect />
          <small>Sets the bed size used by the viewport, the printability check and the AI. Typing a size below makes it Custom.</small>
        </label>
        <div className="field-grid">
          {(['X', 'Y', 'Z'] as const).map((ax, i) => (
            <label key={ax} className="field">
              Bed {ax} (mm)
              <input
                type="number"
                value={settings.bed[i]}
                onChange={(e) => {
                  const bed = [...settings.bed] as [number, number, number];
                  bed[i] = Number(e.target.value);
                  setSettings({ bed, printer: CUSTOM });
                }}
              />
            </label>
          ))}
          <label className="field">
            Nozzle (mm)
            <input type="number" step={0.1} value={settings.nozzle} onChange={(e) => setSettings({ nozzle: Number(e.target.value) })} />
          </label>
          <label className="field">
            Max overhang (°)
            <input type="number" value={settings.overhangAngle} onChange={(e) => setSettings({ overhangAngle: Number(e.target.value) })} />
          </label>
        </div>
        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => {
              setSettings({ apiKey: key.trim() });
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReportPanel({ report, onClose }: { report: PrintReport; onClose: () => void }) {
  const select = useStore((s) => s.select);
  return (
    <div className="report">
      <header>
        <b>{report.ok ? '✅ Ready to print' : '⛔ Not printable yet'}</b>
        <button className="icon" onClick={onClose}>✕</button>
      </header>
      <div className="stats">
        <span>{report.size.join(' × ')} mm</span>
        <span>{report.volumeCm3} cm³</span>
        <span>~{report.massPlaG} g PLA</span>
        <span>{report.overhangPercent}% overhang</span>
        {report.minWallMm !== null && <span>min wall {report.minWallMm} mm</span>}
        <span>{report.triangles.toLocaleString()} tris</span>
      </div>
      {report.issues.length ? (
        <ul>
          {report.issues.map((i, k) => (
            <li key={k} className={i.level} onClick={() => i.objectId && select(i.objectId)}>
              {i.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No issues found.</p>
      )}
    </div>
  );
}

export function Topbar({ onReport }: { onReport: (r: PrintReport | null) => void }) {
  const [showSettings, setShowSettings] = useState(false);
  const [showTablet, setShowTablet] = useState(false);
  const inboxCount = useTablet((s) => s.inbox.length);
  const lastArrival = useTablet((s) => s.lastArrival);
  // A tracing just arrived from the tablet: show it.
  const [seenArrival, setSeenArrival] = useState(lastArrival);
  if (lastArrival !== seenArrival) {
    setSeenArrival(lastArrival);
    if (lastArrival) setShowTablet(true);
  }
  const { undo, redo, past, future, gizmo, setGizmo, overlay, toggleOverlay } = useStore();
  const nodes = useStore((s) => s.nodes);
  const settings = useStore((s) => s.settings);
  const local = useLocalActions((s) => s.info);
  useEffect(loadLocalActions, []);

  const safe = (fn: () => unknown) => () => runAction(fn);
  // Every plate that leaves Fabbrico for printing is recorded in the project diary (experimental).
  const printed = async (via: string, exportFn: () => unknown) => {
    await exportFn();
    await recordAttempt(via);
  };
  // Exports cover the active plate: name the file after the project (and plate, if there are several).
  const exportName = () => {
    const st = useStore.getState();
    const plate = st.plates.find((p) => p.id === st.activePlate);
    return st.plates.length > 1 && plate ? `${st.project.name} - ${plate.name}` : st.project.name;
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◆</span> Fabbrico
        <span className="sep" />
        <ProjectControls />
      </div>
      <div className="tools">
        <button className="icon" title="Undo (⌘Z)" disabled={!past.length} onClick={undo}>↶</button>
        <button className="icon" title="Redo (⇧⌘Z)" disabled={!future.length} onClick={redo}>↷</button>
        <span className="sep" />
        {(['translate', 'rotate', 'scale'] as const).map((m) => (
          <button key={m} className={`small ${gizmo === m ? 'active' : ''}`} onClick={() => setGizmo(m)} title={`${m} (${m[0].toUpperCase()})`}>
            {m === 'translate' ? 'Move' : m === 'rotate' ? 'Rotate' : 'Scale'}
          </button>
        ))}
        <span className="sep" />
        <button
          className={`small ${overlay === 'overhangs' ? 'active' : ''}`}
          title="Colour faces that overhang more than the limit in Settings"
          onClick={() => toggleOverlay('overhangs')}
        >
          Overhangs
        </button>
        <button
          className={`small ${overlay === 'thickness' ? 'active' : ''}`}
          title="Colour the model by wall thickness, relative to the nozzle"
          onClick={() => toggleOverlay('thickness')}
        >
          Thickness
        </button>
        <button className="small" disabled={!nodes.length} onClick={safe(async () => onReport(await geometry.analyze(nodes, { bed: settings.bed, overhangAngle: settings.overhangAngle, nozzle: settings.nozzle })))}>
          Check print
        </button>
        <span className="sep" />
        <button className="small" disabled={!nodes.length} onClick={safe(() => printed('3mf', () => geometry.download(nodes, '3mf', exportName())))}>
          Export 3MF
        </button>
        <button className="small ghost" disabled={!nodes.length} onClick={safe(() => printed('stl', () => geometry.download(nodes, 'stl', exportName())))}>
          STL
        </button>
        {local?.slicers.map((s) => (
          <button
            key={s.id}
            className="small"
            disabled={!nodes.length}
            title={`Save the current plate as 3MF in ${local.exportDir} and open it in ${s.name}`}
            onClick={safe(() => printed(`slicer:${s.id}`, () => openInSlicer(nodes, s.id, exportName())))}
          >
            {s.name}
          </button>
        ))}
        {local && (
          <button className="icon" title={`Open the export folder (${local.exportDir})`} onClick={safe(openExportFolder)}>
            📂
          </button>
        )}
        <span className="sep" />
        <PrinterSelect className="small printer-select" onCustom={() => setShowSettings(true)} />
        <button
          className="small"
          title="Connect a tablet (tracing, photos, notes, AR) or a phone (photos, notes, AR)"
          onClick={() => setShowTablet(true)}
        >
          Devices{inboxCount ? <span className="badge">{inboxCount}</span> : null}
        </button>
        <button
          className="icon"
          title={`Theme: ${THEME_LABEL[settings.theme]} (click to change)`}
          onClick={() => useStore.getState().setSettings({ theme: nextTheme(settings.theme) })}
        >
          {THEME_ICON[settings.theme]}
        </button>
        <button className="icon" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showTablet && <TabletPanel onClose={() => setShowTablet(false)} />}
    </header>
  );
}
