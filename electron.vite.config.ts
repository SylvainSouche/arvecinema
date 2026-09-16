import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

// electron-vite defaults:
//   main   -> src/main/index.ts     -> out/main/index.js
//   preload -> src/preload/index.ts  -> out/preload/index.js
//   renderer root -> src/renderer
// We only override the renderer root + add the React plugin.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: path.resolve(process.cwd(), 'src/renderer'),
    plugins: [
      react(),
      {
        name: 'inject-version',
        config() {
          return {
            define: {
              __APP_VERSION__: JSON.stringify(pkg.version),
            },
          };
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(process.cwd(), 'src/renderer/index.html')
        }
      }
    }
  }
});
