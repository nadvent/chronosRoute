import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const JAVA_ORCHESTRATOR_TARGET = 'http://localhost:8080';
const PYTHON_INGESTION_TARGET = 'http://localhost:8001';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'zustand', 'lucide-react'],
          'vendor-maplibre': ['maplibre-gl'],
          'vendor-deckgl': [
            '@deck.gl/core',
            '@deck.gl/layers',
            '@deck.gl/geo-layers',
            '@deck.gl/aggregation-layers',
            '@deck.gl/maplibre',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api/v1/snapshot': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/api/v1/orders': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/api/v1/dispatch': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/api/v1/orchestrator': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/api/v1/health': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/actuator': {
        target: JAVA_ORCHESTRATOR_TARGET,
        changeOrigin: true,
      },
      '/api/v1/telemetry': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/weather': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/route': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/graph': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/eta': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/simulation': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/api/v1/system': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
      },
      '/ws': {
        target: PYTHON_INGESTION_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
