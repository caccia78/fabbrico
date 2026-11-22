import { useEffect, useState } from 'react';
import { geometry } from './geometry/client';
import { GeometryStatus } from './ui/GeometryStatus';
import { ThicknessLegend } from './ui/ThicknessLegend';
import { PlateTabs } from './ui/PlateTabs';
import { PickHint } from './ui/PickHint';
import { startBridge } from './ai/bridge';
import { findNode, useStore } from './model/store';
import { Viewport } from './ui/Viewport';
import { Sidebar } from './ui/Sidebar';
import { ChatPanel } from './ui/ChatPanel';
import { ReportPanel, Topbar } from './ui/Topbar';
import type { PrintReport } from './geometry/analysis';
import { openProject, openProjectFile, PROJECT_EXT, saveProject } from './model/project';
import { runAction } from './ui/runAction';
import { importMeshFile, isMeshFile, MESH_EXTENSIONS } from './ui/meshImport';
import { loadAssets, pruneAssets } from './model/assets';
import { meshAssetsOf, type SceneNode } from './model/schema';
import { startTablet } from './tablet/connection';
import { useApplyTheme } from './ui/theme';
import { addPhotoFiles, isImageFile, loadReferencesFromBrowser } from './model/references';
import { loadDiaryFromBrowser } from './model/diary';
import { loadLibrary } from './model/library';

/** Objects copied with ⌘C, pasted with ⌘V on any plate (same position). */
let clipboard: SceneNode[] = [];

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Project shortcuts work everywhere, even while typing in a field.
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.(); // commit a field being edited
        runAction(() => saveProject({ saveAs: e.shiftKey }));
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        runAction(openProject);
        return;
      }
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select')) return;
      const st = useStore.getState();
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'd' && st.selectedId) {
        e.preventDefault();
        st.checkpoint();
        st.duplicateNodes([st.selectedId], { offset: [10, 10, 0] });
      } else if (mod && e.key.toLowerCase() === 'c' && st.selectedId) {
        const node = findNode(st.nodes, st.selectedId);
        if (node) clipboard = [structuredClone(node)];
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard.length) {
        e.preventDefault();
        st.checkpoint();
        st.pasteNodes(clipboard);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedId) {
        st.checkpoint();
        st.removeNodes([st.selectedId]);
      } else if (!mod && e.key === 't') st.setGizmo('translate');
      else if (!mod && e.key === 'r') st.setGizmo('rotate');
      else if (!mod && e.key === 's') st.setGizmo('scale');
      else if (e.key === 'Escape') {
        if (st.picking) st.setPicking(null);
        else st.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Drop a .fabbrico file anywhere on the window to open it. */
function useFileDrop() {
  useEffect(() => {
    const isFile = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => {
      if (isFile(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!isFile(e)) return;
      e.preventDefault();
      const files = [...e.dataTransfer!.files];
      const f = files[0];
      if (!f) return;
      if (files.every(isImageFile)) {
        // Pictures become reference photos of the project (Files tab).
        runAction(async () => {
          const errors = await addPhotoFiles(files);
          if (errors.length) alert(errors.join('\n'));
        });
        return;
      }
      if (isMeshFile(f.name)) {
        runAction(async () => {
          const note = await importMeshFile(f);
          if (note) alert(note);
        });
        return;
      }
      if (!/\.(fabbrico|forma|json)$/i.test(f.name)) {
        alert(`Drop a Fabbrico project (${PROJECT_EXT}), a mesh (${MESH_EXTENSIONS.join(', ')}) or photos.`);
        return;
      }
      runAction(() => openProjectFile(f));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

function useTitle() {
  const project = useStore((s) => s.project);
  useEffect(() => {
    document.title = `${project.dirty ? '• ' : ''}${project.name} · Fabbrico`;
  }, [project]);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PrintReport | null>(null);
  useShortcuts();
  useApplyTheme();
  useFileDrop();
  useTitle();

  useEffect(() => {
    // Imported meshes live in IndexedDB: load the ones the plates use (and drop the rest) first.
    const used = new Set<string>();
    for (const p of useStore.getState().allPlates()) meshAssetsOf(p.nodes, used);
    void loadAssets(used)
      .then(() => pruneAssets(used))
      .then(loadReferencesFromBrowser)
      .then(loadDiaryFromBrowser)
      .then(() => geometry.init())
      .then(
      () => {
        setReady(true);
        startBridge();
        startTablet();
        loadLibrary();
      },
      (e) => setError(String(e)),
    );
  }, []);

  if (error) return <div className="splash">Failed to load the geometry engine: {error}</div>;
  if (!ready) return <div className="splash">Loading geometry engine…</div>;

  return (
    <div className="app">
      <Topbar onReport={setReport} />
      <Sidebar />
      <main className="viewport">
        <Viewport />
        <PlateTabs />
        <GeometryStatus />
        <PickHint />
        <ThicknessLegend />
        {report && <ReportPanel report={report} onClose={() => setReport(null)} />}
      </main>
      <ChatPanel />
    </div>
  );
}
