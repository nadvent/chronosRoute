import { useEffect } from 'react';
import { ExplorerSidebar } from './components/explorer/ExplorerSidebar';
import { EntityInspectorDrawer } from './components/map/EntityInspectorDrawer';
import { FleetMapCanvas } from './components/map/FleetMapCanvas';
import { TelemetryHudBar } from './components/telemetry/TelemetryHudBar';
import { useChronosStore } from './store/useChronosStore';

export function App() {
  const initialize = useChronosStore((s) => s.initialize);

  useEffect(() => {
    const cleanup = initialize();
    return cleanup;
  }, [initialize]);

  // Global keyboard shortcuts: Esc clears selection, Space pauses sandbox, F toggles follow
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (isInput) return;

      const store = useChronosStore.getState();
      if (e.key === 'Escape') {
        if (store.selectedEntity !== null) {
          store.selectEntity(null);
        }
      } else if (e.code === 'Space') {
        e.preventDefault();
        store.togglePaused();
      } else if ((e.key === 'f' || e.key === 'F') && store.selectedEntity) {
        store.setFollowSelectedCourier(!store.followSelectedCourier);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#05080f] text-slate-100">
      <FleetMapCanvas />
      <TelemetryHudBar />
      <ExplorerSidebar />
      <EntityInspectorDrawer />
    </main>
  );
}

export default App;
