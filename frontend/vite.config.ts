import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// Ports 3000-3062 belong to the user's other apps; the Factory pair is 3070 (web) / 3071 (API).
const FRONT_PORT = Number(process.env.FACTORY_FRONT_PORT ?? 3070);
// 127.0.0.1, not localhost: Node may resolve localhost to ::1 first while uvicorn listens on
// IPv4 loopback only, and the proxy then answers "connection refused".
const BACKEND_URL = process.env.FACTORY_BACKEND_URL ?? 'http://127.0.0.1:3071';

/**
 * Tailwind only scans the source files it saw when index.css was last processed, and Vite does not
 * re-run PostCSS when a *new* file appears — so classes used only in a freshly created component
 * were missing until a restart. Re-processing index.css on file creation closes that gap.
 */
function tailwindSeesNewFiles(): Plugin {
  const css = fileURLToPath(new URL('./src/index.css', import.meta.url));
  return {
    name: 'factory:tailwind-new-files',
    apply: 'serve',
    configureServer(server) {
      server.watcher.on('add', (file) => {
        if (!/\.(tsx?|html)$/.test(file)) return;
        server.moduleGraph.getModulesByFile(css)?.forEach((mod) => void server.reloadModule(mod));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindSeesNewFiles()],
  server: {
    port: FRONT_PORT,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // ws:true carries the live event stream (/api/ws) through the same proxy entry.
      '/api': { target: BACKEND_URL, changeOrigin: false, ws: true },
      // The Factory's own MCP endpoint, so agents can be pointed at the dev origin too.
      '/mcp': { target: BACKEND_URL, changeOrigin: false },
    },
  },
  preview: { port: FRONT_PORT, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
