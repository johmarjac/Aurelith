import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const repoRoot = resolve(import.meta.dirname, '..', '..');

export default defineConfig({
  /*
   * Unterpfad der Seite.
   *
   * Bei GitHub Pages liegt die Schau neben dem Editor unter
   * `/<repo>/model_viewer/`; im Entwicklungsbetrieb schlicht unter `/`. Ohne
   * die Angabe zeigten alle Verweise auf die Wurzel der Domain, und auf einer
   * Projektseite ist das die falsche.
   */
  base: process.env.AURELITH_VIEWER_BASE ?? '/',

  /*
   * **Kein** öffentlicher Ordner.
   *
   * Der Editor reicht `assets/` durch, weil er Karten, Texturen und den
   * wasm-Kern lädt. Die Schau lädt nichts davon: sie baut ihre Modelle selbst
   * aus denselben Bauern wie der Client. Mit `assets/` als publicDir lagen
   * dreieinhalb Megabyte Karten und Texturen in der Ausgabe, die niemand
   * abruft — das Zeichen der Marke kommt über den Verweis im HTML und wird
   * beim Bauen von Vite selbst mitgenommen.
   */
  publicDir: false,
  server: { port: 5175 },
  build: { target: 'es2022' },
});
