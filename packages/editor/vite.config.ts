import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..', '..');

/** Siehe Client: der Emscripten-Glue darf nicht durch Vites Pipeline. */
function serveCoreRaw(): Plugin {
  return {
    name: 'aurelith-core-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.startsWith('/core/')) return next();
        const file = resolve(repoRoot, 'assets', path.slice(1));
        if (!file.startsWith(resolve(repoRoot, 'assets')) || !existsSync(file)) return next();
        res.setHeader(
          'content-type',
          file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Unterpfad der Seite. Bei GitHub Pages liegt der Editor neben dem Client
  // unter `/<repo>/editor/`; im Entwicklungsbetrieb schlicht unter `/`.
  base: process.env.AURELITH_EDITOR_BASE ?? '/',

  publicDir: resolve(repoRoot, 'assets'),
  server: { port: 5174 },
  build: { target: 'es2022' },
  plugins: [serveCoreRaw()],
});
