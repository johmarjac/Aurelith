#!/usr/bin/env node
/**
 * Zeichnet ein Figuren-Rig als Bild — ohne Browser, ohne GPU.
 *
 * Gedacht zum Hinsehen, nicht zum Prüfen. Wer eine Figur ändert, will das
 * Ergebnis betrachten, und ein Rauchtest mit echtem Browser ist dafür ein
 * schwerer Umweg — zumal er nicht überall startet.
 *
 * Das Verfahren ist einfach, aber nicht naiv: Rasterung mit echtem
 * Tiefenpuffer, Beleuchtung aus der Flächennormalen.
 *
 * Der erste Anlauf sortierte Dreiecke nach ihrem Schwerpunkt und malte von
 * hinten nach vorn. Das ergab Zacken quer durchs Gesicht — und die Frage, ob
 * das Modell kaputt ist oder das Bild. Ein Werkzeug, das man erst
 * interpretieren muss, taugt nicht zum Hinsehen.
 *
 *   node tools/render-rig.mjs [--rig player] [--waffe sword] [--breite 480]
 *   node tools/render-rig.mjs --prop fence_wood,lantern_post,barrel
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const rigKey = opt('rig', 'player');
const weapon = opt('waffe', undefined);
const width = Number(opt('breite', 420));
// Bei einer Figur ist das Bild hochkant, bei einer Reihe Props quer. Die
// endgueltige Hoehe steht erst fest, wenn die Ausschnitte berechnet sind —
// sonst bildet man elf Einheiten Breite auf achthundert Bildpunkte ab und
// drei Einheiten Hoehe auf elfhundert, und alles ist vierfach gestaucht.
let height = Math.round(width * 1.35);
const outFile = opt('aus', join(root, 'artefakte', `rig-${opt('prop', rigKey).split(',')[0]}.png`));

// three und der Rig-Code sind TypeScript-Module; tsx lädt sie.
const { default: sharp } = await import('sharp');
const THREE = await import('three');
const { createRig } = await import(join(root, 'packages/client/src/render/rigs.ts'));

// Entweder eine Figur oder eine Reihe Props — dieselbe Rasterung, dieselben
// Ansichten. Ein zweites Werkzeug fuer Props waere dieselbe Arbeit noch einmal.
const propListe = opt('prop', undefined);
const rig = { root: new THREE.Object3D() };

if (propListe) {
  const { PROP_BUILDERS } = await import(join(root, 'packages/client/src/render/props.ts'));
  const namen = propListe.split(',');
  // Nebeneinander aufgereiht, mit Abstand nach ihrer eigenen Breite.
  let x = 0;
  for (const name of namen) {
    const bauer = PROP_BUILDERS[name];
    if (!bauer) {
      console.error(`Unbekanntes Prop: ${name}`);
      process.exit(1);
    }
    const geo = bauer();
    geo.computeBoundingBox();
    const breite = geo.boundingBox.max.x - geo.boundingBox.min.x;
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    mesh.position.x = x + breite / 2;
    rig.root.add(mesh);
    x += breite + 0.6;
  }
} else {
  const gebaut = createRig(rigKey, new THREE.MeshBasicMaterial({ vertexColors: true }), weapon);
  // Eine Ruhepose: stehend, nicht mitten im Schritt.
  gebaut.update({ speed: 0, attackPhase: -1, dead: false, time: 0, dt: 1 / 60 });
  rig.root.add(gebaut.root);
}
rig.root.updateMatrixWorld(true);

// --- Dreiecke einsammeln ----------------------------------------------------

const tris = [];
rig.root.traverse((o) => {
  if (!o.isMesh) return;
  const geo = o.geometry;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const index = geo.index;
  const count = index ? index.count : pos.count;

  for (let i = 0; i < count; i += 3) {
    const verts = [];
    const cols = [];
    for (let k = 0; k < 3; k++) {
      const vi = index ? index.getX(i + k) : i + k;
      const v = new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      v.applyMatrix4(o.matrixWorld);
      verts.push(v);
      cols.push(col ? [col.getX(vi), col.getY(vi), col.getZ(vi)] : [0.8, 0.8, 0.8]);
    }
    tris.push({ verts, color: cols[0] });
  }
});

// --- Kameras ----------------------------------------------------------------
//
// Vier Ansichten nebeneinander: von vorn, halb schräg, von der Seite und ein
// Ausschnitt auf Kopf und Hand. Genau die Stellen, an denen man beim Ändern
// hinsehen will.

// Die Ausschnitte richten sich nach der tatsaechlichen Hoehe des Modells.
// Fest eingetragene Werte passen nur zur Spielfigur — ein Gruftwaerter ist
// groesser und faellt aus dem Bild, ein Schleim verschwindet am unteren Rand.
let modelTop = 0;
for (const t of tris) for (const v of t.verts) modelTop = Math.max(modelTop, v.y);
const H = modelTop || 1.8;

let breiteGesamt = 0;
for (const t of tris) for (const v of t.verts) breiteGesamt = Math.max(breiteGesamt, v.x);

const views = propListe
  ? [
      { name: 'vorn', yaw: 0, top: H * 1.1, bottom: -H * 0.05, spanX: breiteGesamt + 1 },
      { name: 'halb', yaw: -0.6, top: H * 1.1, bottom: -H * 0.05, spanX: breiteGesamt + 1 },
    ]
  : [
  { name: 'vorn', yaw: 0, top: H * 1.04, bottom: -H * 0.03 },
  { name: 'halb', yaw: -0.7, top: H * 1.04, bottom: -H * 0.03 },
  { name: 'seite', yaw: -Math.PI / 2, top: H * 1.04, bottom: -H * 0.03 },
  { name: 'kopf', yaw: -0.35, top: H * 1.035, bottom: H * 0.755 },
  // Die Waffenhand sitzt seitlich, nicht in der Mitte. Ohne den Versatz
  // zeigt der Ausschnitt den Rumpf und die Hand steht daneben im Nichts.
  { name: 'hand', yaw: -0.75, top: H * 0.55, bottom: H * 0.265, centerX: H * 0.19 },
];

// Massstabstreu: dieselbe Zahl Bildpunkte je Einheit in beide Richtungen.
if (propListe) {
  const v = views[0];
  height = Math.max(80, Math.round((width * (v.top - v.bottom)) / v.spanX));
}

const LIGHT = new THREE.Vector3(0.4, 0.8, 0.55).normalize();

function render(view) {
  const cos = Math.cos(view.yaw);
  const sin = Math.sin(view.yaw);
  const span = view.top - view.bottom;
  const scale = height / span;
  // `spanX` erzwingt eine Breite: eine Reihe Props ist breiter als hoch, und
  // ohne das faellt die Haelfte aus dem Bild.
  const halfW = view.spanX ? view.spanX / 2 : width / (2 * scale);

  const pixels = new Float32Array(width * height * 3);
  // Hintergrund: ein neutrales Grau, damit helle wie dunkle Teile auffallen.
  pixels.fill(0.22);

  const projected = tris.map((t) => {
    const p = t.verts.map((v) => ({
      x: v.x * cos - v.z * sin,
      y: v.y,
      z: v.x * sin + v.z * cos,
    }));
    const depth = (p[0].z + p[1].z + p[2].z) / 3;

    // Flächennormale im Kameraraum für die Schattierung.
    const ux = p[1].x - p[0].x, uy = p[1].y - p[0].y, uz = p[1].z - p[0].z;
    const vx = p[2].x - p[0].x, vy = p[2].y - p[0].y, vz = p[2].z - p[0].z;
    const n = new THREE.Vector3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (n.lengthSq() > 0) n.normalize();
    const lambert = 0.45 + 0.55 * Math.max(0, n.dot(LIGHT));

    return { p, depth, color: t.color, lambert };
  });

  const depthBuffer = new Float32Array(width * height).fill(-Infinity);

  const cx0 = view.centerX ?? (view.spanX ? view.spanX / 2 : 0);
  const sx = (x) => ((x - cx0 + halfW) / (2 * halfW)) * width;
  const sy = (y) => height - ((y - view.bottom) / span) * height;

  for (const tri of projected) {
    const xs = tri.p.map((q) => sx(q.x));
    const ys = tri.p.map((q) => sy(q.y));

    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
    if (minX > maxX || minY > maxY) continue;

    const [x0, x1, x2] = xs;
    const [y0, y1, y2] = ys;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const w0 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) / area;
        const w1 = ((cx - x0) * (y2 - y0) - (x2 - x0) * (cy - y0)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        // Tiefe an dieser Stelle aus den baryzentrischen Gewichten. Ohne
        // Perspektive ist die Interpolation linear und damit exakt.
        //
        // Auf die Zuordnung achten: `w0` gehoert zur *dritten* Ecke, `w1` zur
        // zweiten. Vertauscht ergibt das eine Tiefe, die quer durch das
        // Dreieck kippt — das Bild franst dann an jeder Kante aus.
        const z = w2 * tri.p[0].z + w1 * tri.p[1].z + w0 * tri.p[2].z;
        const d = py * width + px;
        if (z <= depthBuffer[d]) continue;
        depthBuffer[d] = z;

        const o = d * 3;
        pixels[o] = tri.color[0] * tri.lambert;
        pixels[o + 1] = tri.color[1] * tri.lambert;
        pixels[o + 2] = tri.color[2] * tri.lambert;
      }
    }
  }

  const bytes = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(Math.sqrt(pixels[i]) * 255)));
  }
  return bytes;
}

// --- Ansichten nebeneinander ------------------------------------------------

const tiles = [];
for (const view of views) {
  tiles.push({
    input: await sharp(render(view), { raw: { width, height, channels: 3 } }).png().toBuffer(),
    left: tiles.length * (width + 8),
    top: 0,
  });
}

const sheet = await sharp({
  create: {
    width: views.length * (width + 8) - 8,
    height,
    channels: 3,
    background: { r: 12, g: 16, b: 20 },
  },
})
  .composite(tiles)
  .png()
  .toBuffer();

await writeFile(outFile, sheet);
console.log(
  `${views.map((v) => v.name).join(' · ')}\n${tris.length} Dreiecke → ${outFile}`,
);
