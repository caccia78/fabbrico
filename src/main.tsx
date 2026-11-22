import './legacy';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Dev-only handle for debugging from the browser console.
if (import.meta.env.DEV) {
  void Promise.all([import('./model/store'), import('./geometry/client'), import('./ai/agent'), import('./ai/tools')]).then(
    ([store, geometry, agent, tools]) => {
      (window as unknown as Record<string, unknown>).__fabbrico = { ...store, ...geometry, ...agent, ...tools };
    },
  );
}
