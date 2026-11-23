/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        void: '#05080f',
        obsidian: '#0b1120',
        slateHud: '#0f172a',
        cyanGlow: '#22d3ee',
        emeraldTelemetry: '#10b981',
        amberAlert: '#f59e0b',
        crimsonAlert: '#ef4444',
      },
      boxShadow: {
        hud: '0 12px 36px -8px rgba(2, 6, 23, 0.85), 0 0 0 1px rgba(51, 65, 85, 0.45)',
        glowCyan: '0 0 20px rgba(34, 211, 238, 0.25)',
      },
    },
  },
  plugins: [],
};
