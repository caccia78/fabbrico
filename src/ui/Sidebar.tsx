import { useState } from 'react';
import { addPrimitive, findNode, useStore } from '../model/store';
import { defaultModifier, type Modifier, type ModifierType, type SceneNode, type ShapeKind } from '../model/schema';
import { ParamEditor, Row, TextInput, VecInput } from './fields';
import { dropToBed, orientForPrint } from '../model/printActions';
import { runAction } from './runAction';
import { pickImage } from './imageImport';
import { SizeRow } from './SizeRow';
import { ColumnResizer } from './ColumnResizer';
import { importMeshFile, pickMeshFile } from './meshImport';
import { FilesPanel } from './FilesPanel';
import { DiaryPanel } from './DiaryPanel';
import { LibraryPanel } from './LibraryPanel';
import { useDiary } from '../model/diary';
import { useReferences } from '../model/references';

const SHAPES: { kind: Exclude<ShapeKind, 'group'>; label: string; icon: string }[] = [
  { kind: 'box', label: 'Box', icon: '▢' },
  { kind: 'cylinder', label: 'Cylinder', icon: '◯' },
  { kind: 'sphere', label: 'Sphere', icon: '●' },
  { kind: 'polygon', label: 'Triangle', icon: '△' },
  { kind: 'torus', label: 'Torus', icon: '◎' },
  { kind: 'revolve', label: 'Revolve', icon: '⚱' },
  { kind: 'sdf', label: 'Organic', icon: '✺' },
  { kind: 'text', label: 'Text', icon: 'T' },
  { kind: 'image', label: 'Image', icon: '▨' },
];

/** Image shapes start from a picture the user chooses. */
function addShape(kind: Exclude<ShapeKind, 'group'>) {
  if (kind !== 'image') return addPrimitive(kind);
  runAction(async () => {
    const image = await pickImage();
    if (!image) return;
    const id = addPrimitive('image');
    const node = findNode(useStore.getState().nodes, id);
    if (node?.shape.kind === 'image') useStore.getState().updateNode(id, { shape: { ...node.shape, image } });
  });
}

const MODIFIERS: ModifierType[] = ['round', 'chamfer', 'teardrop', 'smooth', 'displace', 'twist', 'taper', 'bend', 'warp'];

function edit(id: string, patch: Partial<SceneNode>) {
  const st = useStore.getState();
  st.checkpoint();
  st.updateNode(id, patch);
}

function Tree({ nodes, depth = 0 }: { nodes: SceneNode[]; depth?: number }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  return (
    <>
      {nodes.map((n) => (
        <div key={n.id}>
          <div
            className={`tree-item ${n.id === selectedId ? 'sel' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => select(n.id)}
          >
            <span className="swatch" style={{ background: n.hole ? 'transparent' : n.color, borderColor: n.hole ? '#ff4d4d' : n.color }} />
            <span className="tree-name">{n.name}</span>
            <span className="tree-kind">{n.hole ? 'hole' : n.shape.kind === 'group' ? n.shape.op : n.shape.kind}</span>
          </div>
          {n.shape.kind === 'group' && <Tree nodes={n.shape.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function Inspector({ node }: { node: SceneNode }) {
  const isRoot = useStore((s) => s.nodes.some((n) => n.id === node.id));
  const [addMod, setAddMod] = useState<ModifierType>('round');
  const t = node.transform;
  const setMods = (modifiers: Modifier[]) => edit(node.id, { modifiers });

  return (
    <div className="inspector">
      <Row label="name">
        <TextInput value={node.name} onCommit={(name) => edit(node.id, { name })} />
      </Row>
      <Row label="color">
        <input type="color" value={node.color} onChange={(e) => edit(node.id, { color: e.target.value })} />
      </Row>
      <Row label="hole">
        <input type="checkbox" checked={node.hole} onChange={(e) => edit(node.id, { hole: e.target.checked })} />
      </Row>

      <h4>Transform</h4>
      <SizeRow node={node} />
      <Row label="position">
        <VecInput value={t.position} onCommit={(v) => edit(node.id, { transform: { ...t, position: v as SceneNode['transform']['position'] } })} />
      </Row>
      <Row label="rotation°">
        <VecInput value={t.rotation} step={5} onCommit={(v) => edit(node.id, { transform: { ...t, rotation: v as SceneNode['transform']['rotation'] } })} />
      </Row>
      <Row label="scale">
        <VecInput value={t.scale} step={0.1} onCommit={(v) => edit(node.id, { transform: { ...t, scale: v as SceneNode['transform']['scale'] } })} />
      </Row>
      {isRoot && (
        <div className="btn-row">
          <button
            className="small"
            title="Move the object down (or up) so it rests on the bed"
            onClick={() =>
              runAction(async () => {
                useStore.getState().checkpoint();
                await dropToBed(node.id);
              })
            }
          >
            ⤓ Drop to bed
          </button>
          <button
            className="small"
            title="Rotate to the orientation that needs the least support, then drop to bed"
            onClick={() =>
              runAction(async () => {
                useStore.getState().checkpoint();
                await orientForPrint(node.id);
              })
            }
          >
            ⟲ Orient for print
          </button>
        </div>
      )}

      <h4>Shape · {node.shape.kind}</h4>
      {node.shape.kind === 'group' ? (
        <>
          <Row label="op">
            <select
              value={node.shape.op}
              onChange={(e) => node.shape.kind === 'group' && edit(node.id, { shape: { ...node.shape, op: e.target.value as 'union' } })}
            >
              <option>union</option>
              <option>intersection</option>
            </select>
          </Row>
          {isRoot && (
            <button
              className="small"
              onClick={() => {
                const st = useStore.getState();
                st.checkpoint();
                st.ungroup(node.id);
              }}
            >
              Ungroup
            </button>
          )}
        </>
      ) : (
        <>
          {node.shape.kind === 'image' && (
            <div className="image-row">
              {node.shape.image ? <img src={node.shape.image} alt="" /> : <span className="muted">No image</span>}
              <button
                className="small"
                onClick={() =>
                  runAction(async () => {
                    const image = await pickImage();
                    if (image && node.shape.kind === 'image') edit(node.id, { shape: { ...node.shape, image } });
                  })
                }
              >
                Replace image…
              </button>
            </div>
          )}
          {node.shape.kind === 'mesh' && (
            <Row label="mesh">
              <span className="muted">imported · {node.shape.triangles.toLocaleString()} triangles</span>
            </Row>
          )}
          <ParamEditor
            value={node.shape}
            skip={['kind', 'image', 'asset', 'triangles', 'contours', 'strokeRadius']}
            onChange={(shape) => edit(node.id, { shape })}
          />
        </>
      )}

      <h4>Modifiers</h4>
      {node.modifiers.map((m, i) => (
        <div className="modifier" key={i}>
          <div className="modifier-head">
            <b>{m.type}</b>
            <span>
              <button className="icon" disabled={i === 0} title="Move up" onClick={() => {
                const next = [...node.modifiers];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                setMods(next);
              }}>↑</button>
              <button className="icon" title="Remove" onClick={() => setMods(node.modifiers.filter((_, j) => j !== i))}>✕</button>
            </span>
          </div>
          <ParamEditor
            value={m}
            skip={['type', 'region', ...(m.type === 'displace' && m.pattern !== 'expression' ? ['expression'] : [])]}
            onChange={(nm) => setMods(node.modifiers.map((x, j) => (j === i ? nm : x)))}
          />
          {m.type === 'displace' && m.faces === 'picked' && (
            <Row label="face">
              <span className="pick-row">
                <span className={m.region ? '' : 'muted'}>{m.region ? 'picked ✓' : 'none yet'}</span>
                <button className="small" onClick={() => useStore.getState().setPicking({ nodeId: node.id, modIndex: i })}>
                  {m.region ? 'Re-pick' : 'Pick face'}
                </button>
              </span>
            </Row>
          )}
        </div>
      ))}
      <div className="add-mod">
        <select value={addMod} onChange={(e) => setAddMod(e.target.value as ModifierType)}>
          {MODIFIERS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button className="small" onClick={() => setMods([...node.modifiers, defaultModifier(addMod)])}>
          + Add
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const nodes = useStore((s) => s.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const selected = selectedId ? findNode(nodes, selectedId) : null;
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [tab, setTab] = useState<'model' | 'files' | 'diary' | 'library'>('model');
  const pendingOutcomes = useDiary((s) => s.attempts.filter((a) => !a.outcome).length);
  const proposals = useDiary((s) => s.proposals.length);
  const unseen = useReferences((s) => s.unseen);
  const photoCount = useReferences((s) => s.list.length);

  return (
    <aside className="sidebar">
      <ColumnResizer side="left" />
      <div className="side-tabs">
        <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>
          Model
        </button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')} title="Photos, images, meshes and tracings of the project">
          Files
          {unseen ? <span className="badge">+{unseen}</span> : photoCount ? <span className="muted"> {photoCount}</span> : null}
        </button>
        <button className={tab === 'diary' ? 'on' : ''} onClick={() => setTab('diary')} title="Print attempts and their outcomes (experimental)">
          Diary
          {proposals ? <span className="badge">{proposals}</span> : pendingOutcomes ? <span className="muted"> {pendingOutcomes}?</span> : null}
        </button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')} title="Your experience library (experimental)">
          Library
        </button>
      </div>
      {tab === 'files' ? (
        <FilesPanel />
      ) : tab === 'diary' ? (
        <DiaryPanel />
      ) : tab === 'library' ? (
        <LibraryPanel />
      ) : (
        <ModelTab nodes={nodes} selected={selected} groupIds={groupIds} setGroupIds={setGroupIds} />
      )}
    </aside>
  );
}

function ModelTab({
  nodes,
  selected,
  groupIds,
  setGroupIds,
}: {
  nodes: SceneNode[];
  selected: SceneNode | null;
  groupIds: string[];
  setGroupIds: (ids: string[]) => void;
}) {
  return (
    <>
      <section>
        <h3>Add</h3>
        <div className="palette">
          {SHAPES.map((s) => (
            <button key={s.kind} onClick={() => addShape(s.kind)} title={s.label}>
              <span className="pi">{s.icon}</span>
              {s.label}
            </button>
          ))}
          <button
            title="Import a mesh: STL, OBJ, GLB/glTF or 3MF (or drop the file on the window)"
            onClick={() =>
              runAction(async () => {
                const f = await pickMeshFile();
                if (!f) return;
                const note = await importMeshFile(f);
                if (note) alert(note);
              })
            }
          >
            <span className="pi">⇪</span>
            Import…
          </button>
        </div>
      </section>

      <section>
        <h3>
          Scene <span className="muted">{nodes.length}</span>
        </h3>
        <div className="tree">
          {nodes.length ? <Tree nodes={nodes} /> : <p className="muted pad">Add a shape, then ask the AI to shape it.</p>}
        </div>
        {nodes.length > 1 && (
          <details className="group-box">
            <summary>Group / cut…</summary>
            {nodes.map((n) => (
              <label key={n.id} className="check">
                <input
                  type="checkbox"
                  checked={groupIds.includes(n.id)}
                  onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, n.id] : groupIds.filter((x) => x !== n.id))}
                />
                {n.name} {n.hole && <em>(hole)</em>}
              </label>
            ))}
            <button
              className="small"
              disabled={groupIds.length < 2}
              onClick={() => {
                const st = useStore.getState();
                st.checkpoint();
                st.groupNodes(groupIds, 'union');
                setGroupIds([]);
              }}
            >
              Group selected
            </button>
          </details>
        )}
      </section>

      {selected && (
        <section className="grow">
          <h3>
            Properties
            <button
              className="icon danger"
              title="Delete"
              onClick={() => {
                const st = useStore.getState();
                st.checkpoint();
                st.removeNodes([selected.id]);
              }}
            >
              🗑
            </button>
          </h3>
          <Inspector node={selected} />
        </section>
      )}
    </>
  );
}

