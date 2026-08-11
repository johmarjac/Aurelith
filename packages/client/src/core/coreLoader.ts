/**
 * Lädt den wasm-Kern im Browser.
 *
 * Der Glue wird bewusst **zur Laufzeit** geholt und nicht mitgebündelt: er
 * enthält Pfade für Browser, Worker und Node, und ein Bundler, der versucht,
 * das alles aufzulösen, sorgt nur für Ärger. Über den Asset-Weg geladen ist er
 * genau das, was er ist — ein Asset mit Version im Query-String.
 *
 * Es ist dieselbe Datei, die der Server lädt.
 */

import { Core, type CoreMobDef, type CoreModuleFactory } from '@aurelith/core';
import { MOBS } from '@aurelith/shared';
import { ASSET_BASE, BUILD } from '../config.ts';

export interface ClientCore {
  core: Core;
  mobIndexById: Map<string, number>;
  mobIdByIndex: string[];
}

function toCoreMob(id: string): CoreMobDef {
  const def = MOBS.get(id)!;
  return {
    maxHp: def.maxHp,
    attackDamage: def.attackDamage,
    defense: def.defense,
    moveSpeed: def.moveSpeed,
    aggroRange: def.aggroRange,
    leashRange: def.leashRange,
    attackRange: def.attackRange,
    attackArc: def.attackArc,
    attackCooldownSec: def.attackCooldownMs / 1000,
    attackStyle: 0,
    attackWindupSec: def.attackWindupMs / 1000,
    radius: def.radius * def.scale,
    height: def.height * def.scale,
    expReward: def.expReward,
    goldReward: def.goldReward,
    level: def.level,
    aggressive: def.aggressive ? 1 : 0,
  };
}

export async function loadClientCore(): Promise<ClientCore> {
  const glueUrl = `${ASSET_BASE}/core/aurelith_core.js?v=${encodeURIComponent(BUILD)}`;
  const wasmUrl = `${ASSET_BASE}/core/aurelith_core.wasm?v=${encodeURIComponent(BUILD)}`;

  const module = (await import(/* @vite-ignore */ glueUrl)) as { default: CoreModuleFactory };
  const factory = module.default;

  const core = await Core.fromModule(
    await factory({
      // Emscripten würde die .wasm neben dem Glue suchen. Wir sagen ihm die
      // Adresse, damit sie mit Version geladen und unveränderlich gecacht wird.
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    }),
  );

  const mobIndexById = new Map<string, number>();
  const mobIdByIndex: string[] = [];
  for (const id of MOBS.keys()) {
    const index = core.registerMob(toCoreMob(id));
    mobIndexById.set(id, index);
    mobIdByIndex[index] = id;
  }

  return { core, mobIndexById, mobIdByIndex };
}
