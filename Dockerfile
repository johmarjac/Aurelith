# Aurelith — Spielserver als Container.
#
# Drei Stufen, aus einem Grund: der Kern wird aus C++ übersetzt, die
# Abhängigkeiten werden einmal aufgelöst, und im Laufzeitbild landet weder
# ein Compiler noch eine Toolchain.
#
# Die erste Stufe hängt bewusst an $BUILDPLATFORM. WebAssembly ist
# architekturunabhängig — dieselbe .wasm läuft auf amd64 wie auf dem
# Raspberry Pi. Sie unter Emulation ein zweites Mal zu übersetzen, wäre
# reine Wartezeit ohne Unterschied im Ergebnis.
#
#   docker build -t aurelith-server .
#   docker run --rm -p 8787:8787 aurelith-server

# --- Stufe 1: C++-Kern nach WebAssembly -------------------------------------

FROM --platform=$BUILDPLATFORM emscripten/emsdk:6.0.6 AS core

# Der Bauplan macht zuerst einen nativen Build und lässt die C++-Prüfungen
# laufen; erst danach kommt wasm. Dafür braucht es einen echten Compiler,
# nicht nur emcc.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake ninja-build \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY tools/build-core.mjs tools/
COPY packages/core packages/core
RUN node tools/build-core.mjs

# --- Stufe 2: Abhängigkeiten ------------------------------------------------

FROM node:22-alpine AS deps

WORKDIR /app

# Nur die Manifeste, damit diese Schicht nicht bei jeder Quelltextänderung
# neu aufgelöst wird. npm ci besteht auf allen Workspace-Manifesten, auch auf
# denen, deren Abhängigkeiten wir gleich weglassen.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/editor/package.json packages/editor/

# Nur der Zweig, den der Server wirklich braucht: das ergibt 1,2 MB statt 27.
# Der Unterschied ist fast vollständig three.js — im Client eine
# Laufzeitabhängigkeit, im Serverbild schlicht falsch.
#
# `--include-workspace-root` ist nötig, weil die Workspace-Verweise am Wurzel-
# manifest hängen; ohne ihn fehlen die Symlinks nach packages/.
#
# `--omit=optional` schneidet `ffmpeg-static` weg. Es stand einmal unter den
# Entwicklungsabhängigkeiten und war damit von `--omit=dev` schon erfasst;
# seit es optional ist, wäre es das nicht mehr — und achtzig Megabyte
# Tonwerkzeug haben in einem Serverbild nichts verloren.
RUN npm ci --omit=dev --omit=optional --include-workspace-root --workspace @aurelith/server \
 && npm cache clean --force

# --- Stufe 3: Laufzeit ------------------------------------------------------

FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="Aurelith-Spielserver" \
      org.opencontainers.image.description="Autoritativer Spielserver für Aurelith. Geteilte Simulation aus einem wasm-Kern." \
      org.opencontainers.image.source="https://github.com/johmarjac/Aurelith" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    AURELITH_HOST=0.0.0.0 \
    AURELITH_PORT=8787

# Der Server wird nicht vorübersetzt — er läuft im Betrieb aus denselben
# .ts-Dateien wie in der Entwicklung, und damit kann kein übersetztes Abbild
# veralten. Dafür braucht es tsx.
#
# Festgenagelt auf die Fassung aus package-lock.json. Global statt ins
# Projekt, weil ein zweiter `npm install` im Projektbaum die Auflösung von
# oben verwerfen und den ganzen Workspace nachziehen würde.
RUN npm install -g tsx@4.23.12 && npm cache clean --force

COPY --from=deps /app/node_modules ./node_modules

COPY package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/migrations packages/server/migrations

# Der übersetzte Kern. Dieselbe Binärdatei, die auch der Browser lädt.
COPY --from=core /src/packages/core/dist packages/core/dist

# Maps und Inhaltstabellen liest der Server von der Platte. Assets liefert er
# keine aus — die kommen vom CDN, das ist im Blueprint der einzige Weg.
COPY assets/maps assets/maps
COPY assets/content assets/content

COPY docker/entrypoint.sh /usr/local/bin/aurelith-entrypoint
RUN chmod +x /usr/local/bin/aurelith-entrypoint

USER node
EXPOSE 8787

# Busybox-wget statt curl: alpine bringt es mit, curl nicht.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${AURELITH_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["aurelith-entrypoint"]
CMD ["tsx", "packages/server/src/index.ts"]
