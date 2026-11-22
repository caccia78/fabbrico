// "Library" tab (experimental): the maker's experiences on this computer
// (~/Documents/Fabbrico/Library), readable by the AI.

import { useCallback, useEffect, useState } from 'react';
import { getExperience, insertExperienceModel, loadLibrary, openLibraryFolder, searchLibrary, useLibrary, type FullExperience } from '../model/library';
import { KIND_LABEL } from '../model/experienceSchema';
import { runAction } from './runAction';

function ExperienceView({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<FullExperience | null>(null);
  const [lang, setLang] = useState<'it' | 'en'>('it');
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    getExperience(id).then(setData, (e: Error) => (alert(e.message), onClose()));
  }, [id, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (big ? setBig(null) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, big]);
  if (!data) return null;
  const e = data.experience;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal viewer exp-view" onClick={(ev) => ev.stopPropagation()}>
        {big ? (
          <div className="viewer-img" onClick={() => setBig(null)}>
            <img src={big} alt="" />
          </div>
        ) : (
          <div className="exp-body">
            <div className="proposal-head">
              <span className="tag">{KIND_LABEL[e.kind]}</span>
              <span className={`tag status-${e.status}`}>{e.status}</span>
              <span className="muted">
                {e.prints} print{e.prints === 1 ? '' : 's'} · {e.context.printer} · {e.context.material} · from “{e.source.project}”
              </span>
              <span className="spacer" />
              <button className="small ghost" onClick={() => setLang(lang === 'it' ? 'en' : 'it')}>{lang.toUpperCase()}</button>
            </div>
            <div className="exp-media">
              {e.media.map((m) =>
                data.media[m.file] ? <img key={m.file} src={data.media[m.file]} alt="" title={m.caption} onClick={() => setBig(data.media[m.file])} /> : null,
              )}
            </div>
            <pre className="exp-text">{lang === 'it' ? data.it : data.en}</pre>
          </div>
        )}
        <div className="modal-actions viewer-actions">
          <button className="small ghost" onClick={() => runAction(() => openLibraryFolder(e.id))}>Show folder</button>
          <span className="spacer" />
          {e.model && (
            <button className="small" title="Add its objects to the current plate" onClick={() => runAction(async () => (await insertExperienceModel(e.id), onClose()))}>
              Insert model
            </button>
          )}
          <button className="small primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function LibraryPanel() {
  const { available, dir } = useLibrary();
  useLibrary((s) => s.items); // re-render on changes
  const [query, setQuery] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const close = useCallback(() => setViewing(null), []);
  useEffect(() => void loadLibrary(), []);
  const items = searchLibrary(query);

  if (!available)
    return <p className="muted diary-empty">The experience library lives in a folder on this computer: it needs Fabbrico started from its own server (npm start / ./start.sh).</p>;

  return (
    <div className="diary">
      <div className="diary-bar">
        <input className="lib-search" value={query} placeholder="Search (oled, press-fit, m3…)" onChange={(e) => setQuery(e.target.value)} />
        <button className="icon" title={`Open the library folder (${dir})`} onClick={() => runAction(() => openLibraryFolder())}>📂</button>
        <button className="icon" title="Reload" onClick={() => runAction(loadLibrary)}>↻</button>
      </div>
      {items.map((e) => (
        <div key={e.id} className="files-row lib-row" onClick={() => setViewing(e.id)} title={e.summary.it}>
          {e.thumb ? <img className="files-thumb" src={e.thumb} alt="" /> : <span className="files-icon">◇</span>}
          <span className="files-text">
            <span className="tree-name">{e.title.it}</span>
            <span className="files-detail">
              {KIND_LABEL[e.kind]} · <span className={`status-${e.status}`}>{e.status}</span> · {e.context.material}
              {e.tags.length ? ` · ${e.tags.join(', ')}` : ''}
            </span>
          </span>
        </div>
      ))}
      {!items.length && (
        <p className="muted diary-empty">
          {query ? 'Nothing matches.' : 'No experiences yet. They come from the Diary tab: report how your prints went, then let the AI propose what you learnt.'}
        </p>
      )}
      {viewing && <ExperienceView id={viewing} onClose={close} />}
    </div>
  );
}
