// "Files" tab of the left column: everything the project is made from, as a tree.
//   Notes      written notes, e.g. measurements (from here, the phone or the tablet)
//   Sketches   hand drawings with written dimensions, from the tablet (Sketch mode)
//   Photos     reference photos (references.ts), added here, by drag and drop or from a phone / tablet
//   Images     pictures used by image shapes (reliefs, lithophanes, logos)
//   Meshes     imported STL / OBJ / GLB / 3MF files
//   Tracings   outlines traced on the tablet
// Pictures open in a viewer; the other entries select the object that uses them.

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../model/store';
import type { SceneNode } from '../model/schema';
import { getAsset } from '../model/assets';
import {
  addPhotoFiles,
  markReferencesSeen,
  PHOTO_MAX_PX,
  pickPhotoFiles,
  removeReference,
  updateReference,
  useReferences,
  addNote,
  updateNote,
  removeNote,
  type Note,
  type Reference,
} from '../model/references';
import { runAction } from './runAction';

interface Used {
  plateId: string;
  plateName: string;
  node: SceneNode;
}

/** Every object on every plate (nested ones too), with its plate. */
function useAllObjects(): Used[] {
  const plates = useStore((s) => s.plates);
  const active = useStore((s) => s.activePlate);
  const nodes = useStore((s) => s.nodes);
  const out: Used[] = [];
  const walk = (list: SceneNode[], plateId: string, plateName: string) => {
    for (const n of list) {
      out.push({ plateId, plateName, node: n });
      if (n.shape.kind === 'group') walk(n.shape.children, plateId, plateName);
    }
  };
  for (const p of plates) walk(p.id === active ? nodes : p.nodes, p.id, p.name);
  return out;
}

function selectObject(u: { plateId: string; node: SceneNode }) {
  const st = useStore.getState();
  if (st.activePlate !== u.plateId) st.switchPlate(u.plateId);
  useStore.getState().select(u.node.id);
}

function Group({ title, count, action, children }: { title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <details className="files-group" open>
      <summary>
        <span>{title}</span>
        <span className="muted">{count}</span>
        <span className="spacer" />
        {action}
      </summary>
      {count ? children : <p className="muted files-empty">None yet</p>}
    </details>
  );
}

function Row({ thumb, icon, name, detail, onClick }: { thumb?: string; icon?: string; name: string; detail?: string; onClick: () => void }) {
  return (
    <div className="files-row" onClick={onClick} title={detail ? `${name}\n${detail}` : name}>
      {thumb ? <img className="files-thumb" src={thumb} alt="" /> : <span className="files-icon">{icon}</span>}
      <span className="files-text">
        <span className="tree-name">{name}</span>
        {detail && <span className="files-detail">{detail}</span>}
      </span>
    </div>
  );
}

type Viewing = { kind: 'photo'; id: string } | { kind: 'image'; used: Used };

function Viewer({ viewing, objects, onClose }: { viewing: Viewing; objects: Used[]; onClose: () => void }) {
  const photo = useReferences((s) => (viewing.kind === 'photo' ? s.list.find((r) => r.id === viewing.id) : undefined));
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (viewing.kind === 'photo' && !photo) return null; // deleted
  const src = viewing.kind === 'photo' ? photo!.image : viewing.used.node.shape.kind === 'image' ? viewing.used.node.shape.image : '';
  const linked = photo?.objectId ? objects.find((o) => o.node.id === photo.objectId) : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal viewer" onClick={(e) => e.stopPropagation()}>
        <div className={`viewer-img ${zoom ? 'zoom' : ''}`} onClick={() => setZoom(!zoom)} title={zoom ? 'Fit' : 'Actual size'}>
          <img src={src} alt="" />
        </div>
        {photo ? (
          <PhotoFields photo={photo} objects={objects} linked={linked} onClose={onClose} />
        ) : (
          viewing.kind === 'image' && (
            <div className="viewer-fields">
              <p>
                Picture of the image object <b>{viewing.used.node.name}</b> <span className="muted">({viewing.used.plateName})</span>
              </p>
              <div className="modal-actions">
                <button className="small" onClick={() => (selectObject(viewing.used), onClose())}>Select object</button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function PhotoFields({ photo, objects, linked, onClose }: { photo: Reference; objects: Used[]; linked?: Used; onClose: () => void }) {
  const [name, setName] = useState(photo.name);
  const [caption, setCaption] = useState(photo.caption);
  const commit = () => {
    if (name.trim() && name !== photo.name) updateReference(photo.id, { name: name.trim() });
    if (caption !== photo.caption) updateReference(photo.id, { caption });
  };
  return (
    <div className="viewer-fields">
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} />
      </label>
      <label className="field">
        Caption <small className="muted">what it shows, for you and the AI (e.g. "geode, side view, flat base")</small>
        <textarea rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={commit} />
      </label>
      <label className="field">
        Object
        <select value={photo.objectId} onChange={(e) => updateReference(photo.id, { objectId: e.target.value })}>
          <option value="">— whole project —</option>
          {photo.objectId && !linked && <option value={photo.objectId}>(deleted object)</option>}
          {objects.map((o) => (
            <option key={o.node.id} value={o.node.id}>
              {o.plateName} › {o.node.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted viewer-meta">
        {photo.kind === 'sketch' ? 'sketch · the AI reads the written dimensions · ' : ''}
        {photo.width} × {photo.height} px · {photo.source === 'file' ? 'added from a file' : `from the ${photo.source}`} ·{' '}
        {new Date(photo.addedAt).toLocaleString()}
      </p>
      <div className="modal-actions viewer-actions">
        <button
          className="small danger"
          onClick={() => {
            if (confirm(`Delete the ${photo.kind === 'sketch' ? 'sketch' : 'photo'} "${photo.name}"?`)) {
              removeReference(photo.id);
              onClose();
            }
          }}
        >
          Delete
        </button>
        <span className="spacer" />
        {linked && <button className="small" onClick={() => (selectObject(linked), onClose())}>Select object</button>}
        <button className="small primary" onClick={() => (commit(), onClose())}>Done</button>
      </div>
    </div>
  );
}

function NoteEditor({ note, objects, onClose }: { note: Note; objects: Used[]; onClose: () => void }) {
  const [text, setText] = useState(note.text);
  const commit = () => {
    if (!text.trim()) removeNote(note.id);
    else if (text !== note.text) updateNote(note.id, { text });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={() => (commit(), onClose())}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Note</h3>
        <label className="field">
          Text <small className="muted">measurements and facts about the real object: the AI takes them as reliable</small>
          <textarea rows={5} autoFocus value={text} placeholder="e.g. geode base 58 × 74 mm, height 85 mm" onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="field">
          Object
          <select value={note.objectId} onChange={(e) => updateNote(note.id, { objectId: e.target.value })}>
            <option value="">— whole project —</option>
            {objects.map((o) => (
              <option key={o.node.id} value={o.node.id}>
                {o.plateName} › {o.node.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted viewer-meta">
          {note.source === 'fabbrico' ? 'written in Fabbrico' : `from the ${note.source}`} · {new Date(note.addedAt).toLocaleString()}
        </p>
        <div className="modal-actions viewer-actions">
          <button className="small danger" onClick={() => (removeNote(note.id), onClose())}>Delete</button>
          <span className="spacer" />
          <button className="small primary" onClick={() => (commit(), onClose())}>Done</button>
        </div>
      </div>
    </div>
  );
}

export function FilesPanel() {
  const refs = useReferences((s) => s.list);
  const photos = refs.filter((r) => r.kind !== 'sketch');
  const sketches = refs.filter((r) => r.kind === 'sketch');
  const notes = useReferences((s) => s.notes);
  const objects = useAllObjects();
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editingNote = notes.find((n) => n.id === editing);
  useEffect(markReferencesSeen, [refs, notes]);

  const images = objects.filter((o) => o.node.shape.kind === 'image' && o.node.shape.image);
  const tracings = objects.filter((o) => o.node.shape.kind === 'sketch');
  const meshes = new Map<string, Used[]>();
  for (const o of objects) if (o.node.shape.kind === 'mesh') meshes.set(o.node.shape.asset, [...(meshes.get(o.node.shape.asset) ?? []), o]);
  const nameOf = (id: string) => objects.find((o) => o.node.id === id)?.node.name;

  return (
    <div className="files">
      <Group
        title="Notes"
        count={notes.length}
        action={
          <button
            className="small"
            title="Write a note, e.g. measurements of the real object (or send one from the phone / tablet)"
            onClick={(e) => {
              e.preventDefault();
              setEditing(addNote('', { objectId: useStore.getState().selectedId ?? '' }));
            }}
          >
            + Add
          </button>
        }
      >
        {notes.map((n) => (
          <Row
            key={n.id}
            icon="📝"
            name={n.text.split('\n')[0] || '(empty)'}
            detail={[n.objectId ? `→ ${objects.find((o) => o.node.id === n.objectId)?.node.name ?? 'deleted object'}` : '', n.source !== 'fabbrico' ? `from the ${n.source}` : ''].filter(Boolean).join(' · ')}
            onClick={() => setEditing(n.id)}
          />
        ))}
      </Group>
      {sketches.length > 0 && (
        <Group title="Sketches" count={sketches.length}>
          {sketches.map((p) => (
            <Row
              key={p.id}
              thumb={p.image}
              name={p.name}
              detail={[p.objectId ? `→ ${nameOf(p.objectId) ?? 'deleted object'}` : '', p.caption].filter(Boolean).join(' · ')}
              onClick={() => setViewing({ kind: 'photo', id: p.id })}
            />
          ))}
        </Group>
      )}
      <Group
        title="Photos"
        count={photos.length}
        action={
          <button
            className="small"
            title="Add reference photos (or drop them on the window, or send them from the tablet)"
            onClick={(e) => {
              e.preventDefault();
              runAction(async () => {
                const errors = await addPhotoFiles(await pickPhotoFiles());
                if (errors.length) alert(errors.join('\n'));
              });
            }}
          >
            + Add
          </button>
        }
      >
        {photos.map((p) => (
          <Row
            key={p.id}
            thumb={p.image}
            name={p.name}
            detail={[p.objectId ? `→ ${nameOf(p.objectId) ?? 'deleted object'}` : '', p.caption].filter(Boolean).join(' · ')}
            onClick={() => setViewing({ kind: 'photo', id: p.id })}
          />
        ))}
      </Group>
      <Group title="Images" count={images.length}>
        {images.map((u) => (
          <Row
            key={u.node.id}
            thumb={u.node.shape.kind === 'image' ? u.node.shape.image : undefined}
            name={u.node.name}
            detail={u.plateName}
            onClick={() => setViewing({ kind: 'image', used: u })}
          />
        ))}
      </Group>
      <Group title="Meshes" count={meshes.size}>
        {[...meshes].map(([asset, users]) => {
          const tris = getAsset(asset)?.indices.length;
          return (
            <Row
              key={asset}
              icon="⬢"
              name={users[0].node.name}
              detail={[tris ? `${(tris / 3).toLocaleString()} triangles` : 'not loaded', users.length > 1 ? `used ${users.length}×` : users[0].plateName].join(' · ')}
              onClick={() => selectObject(users[0])}
            />
          );
        })}
      </Group>
      <Group title="Tracings" count={tracings.length}>
        {tracings.map((u) => (
          <Row
            key={u.node.id}
            icon="✎"
            name={u.node.name}
            detail={`${u.plateName}${u.node.hole ? ' · hole' : ''}`}
            onClick={() => selectObject(u)}
          />
        ))}
      </Group>
      <p className="muted files-note">Photos are saved in the project file, reduced to {PHOTO_MAX_PX} px. The AI can look at them.</p>
      {viewing && <Viewer viewing={viewing} objects={objects} onClose={() => setViewing(null)} />}
      {editingNote && <NoteEditor key={editingNote.id} note={editingNote} objects={objects} onClose={() => setEditing(null)} />}
    </div>
  );
}
