import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Brotli gehört laut Blueprint in den Build und nicht in die
 * Serverkonfiguration — sonst gilt die Kompression beim statischen Hosting
 * nicht. Also legen wir neben jedes lohnende Ausgabeartefakt ein `.br`.
 */
function brotli(): Plugin {
  return {
    name: 'aurelith-brotli',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!/\.(js|css|html|json|svg|wasm)$/.test(fileName)) continue;
        const source =
          chunk.type === 'asset'
            ? Buffer.from(
                typeof chunk.source === 'string' ? chunk.source : new Uint8Array(chunk.source),
              )
            : Buffer.from(chunk.code, 'utf8');
        // Unter einem Kilobyte lohnt der zusätzliche Request nicht.
        if (source.length < 1024) continue;
        this.emitFile({
          type: 'asset',
          fileName: `${fileName}.br`,
          source: brotliCompressSync(source, {
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: 11,
              [zlib.BROTLI_PARAM_SIZE_HINT]: source.length,
            },
          }),
        });
      }
    },
  };
}

/**
 * Liefert `/core/*` unverändert aus.
 *
 * Der Emscripten-Glue ist ein fertiges Modul mit Pfaden für Browser, Worker
 * und Node. Vites Transformationskette versucht, seine Node-Importe
 * aufzulösen, und scheitert daran — zu Recht, sie sind für uns tot.
 *
 * Diese Middleware hängt sich vor Vites eigene und gibt die Datei so heraus,
 * wie sie gebaut wurde. Im Produktionsbau übernimmt das ohnehin `publicDir`.
 */
function serveCoreRaw(): Plugin {
  return {
    name: 'aurelith-core-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.startsWith('/core/')) return next();

        const file = resolve(repoRoot, 'assets', path.slice(1));
        // Kein Ausbruch aus dem Asset-Baum über `..`.
        if (!file.startsWith(resolve(repoRoot, 'assets'))) return next();
        if (!existsSync(file)) return next();

        res.setHeader(
          'content-type',
          file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        res.setHeader('cache-control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  /**
   * Unterpfad, unter dem die Seite liegt.
   *
   * Bei GitHub Pages ohne eigene Domain ist das `/<repo>/`, im
   * Entwicklungsbetrieb schlicht `/`. Der Client liest den Wert zur Laufzeit
   * über `import.meta.env.BASE_URL` und hängt ihn vor jede Asset-Adresse —
   * damit gibt es genau eine Stelle, an der der Pfad steht.
   */
  base: process.env.AURELITH_BASE ?? '/',

  // `assets/` ist im Betrieb das CDN. Im Entwicklungsbetrieb serviert Vite
  // denselben Baum unter denselben Pfaden, damit der Streamer nichts von der
  // Umgebung wissen muss.
  publicDir: resolve(repoRoot, 'assets'),

  define: {
    __BUILD__: JSON.stringify(process.env.AURELITH_BUILD ?? 'dev'),
  },

  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: process.env.AURELITH_SERVER ?? 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  build: {
    target: 'es2022',
    // Quellkarten sind größer als alles andere zusammen (2,8 MB allein für
    // Three.js). Beim Veröffentlichen bleiben sie draußen, beim Fehlersuchen
    // holt man sie mit AURELITH_SOURCEMAP=1 zurück.
    sourcemap: process.env.AURELITH_SOURCEMAP === '1',
    rollupOptions: {
      output: {
        // Three.js separat halten: es ändert sich selten, unser Code oft.
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },

  plugins: [serveCoreRaw(), brotli()],
});
