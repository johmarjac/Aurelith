import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { ermittleBuildStamp } from '@aurelith/shared/build/ermitteln.node.ts';

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

/**
 * Web-App-Manifest und Symbole.
 *
 * Damit lässt sich die Seite auf den Home-Bildschirm legen und startet dann
 * **ohne Adressleiste** — das ist der einzige Weg dorthin. Eine Seite darf die
 * Browserleiste nicht selbst ausblenden, und die Vollbild-Schnittstelle gibt
 * es auf iOS für gewöhnliche Elemente nicht.
 *
 * Bewusst nicht in `publicDir`: das ist der Asset-Baum und im Betrieb das CDN.
 * Ein Manifest muss aber neben der Seite liegen, sonst passt sein
 * Geltungsbereich nicht. Deshalb legt dieser Zusatz es direkt in die Ausgabe.
 */
function webApp(): Plugin {
  const iconsDir = resolve(import.meta.dirname, 'icons');
  const icons = [
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'apple-touch-icon.png',
  ];

  // Alle Adressen relativ: dann gilt das Manifest unter `/` genauso wie unter
  // `/Aurelith/`, ohne dass der Unterpfad eingesetzt werden muss.
  const manifest = JSON.stringify(
    {
      name: 'Aurelith',
      short_name: 'Aurelith',
      description: 'Browserbasiertes 3D-MMORPG.',
      start_url: './',
      scope: './',
      display: 'fullscreen',
      display_override: ['fullscreen', 'standalone'],
      background_color: '#0b1014',
      theme_color: '#0b1014',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );

  return {
    name: 'aurelith-webapp',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === '/app.webmanifest') {
          res.setHeader('content-type', 'application/manifest+json; charset=utf-8');
          res.end(manifest);
          return;
        }
        const name = path.slice(1);
        if (!icons.includes(name)) return next();
        res.setHeader('content-type', 'image/png');
        createReadStream(resolve(iconsDir, name)).pipe(res);
      });
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'app.webmanifest', source: manifest });
      for (const name of icons) {
        this.emitFile({
          type: 'asset',
          fileName: name,
          source: readFileSync(resolve(iconsDir, name)),
        });
      }
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
    /**
     * Nummer **und** Zeit dieses Baus, für `/version`.
     *
     * Nicht dasselbe wie `__BUILD__`, obwohl beide oft gleich lauten:
     * `__BUILD__` ist der Cache-Schlüssel an jeder Asset-Adresse und muss zum
     * Manifest passen, sonst zeigt die Seite auf Dateien, die es unter dieser
     * Version nicht gibt. Der Stempel hier benennt den Quellstand und wird mit
     * derselben Funktion ermittelt wie der des Servers — sonst stünden im Chat
     * zwei Zeilen, die nach verschiedenen Regeln entstanden sind.
     */
    __BUILD_STAMP__: JSON.stringify(ermittleBuildStamp()),
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

  plugins: [serveCoreRaw(), webApp(), brotli()],
});
