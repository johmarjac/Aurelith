/**
 * Lädt den wasm-Kern für den Server.
 *
 * Es ist dieselbe Datei, die der Browser lädt. Das ist der Punkt: Bewegung,
 * Kollision und Kampf werden auf beiden Seiten von derselben Binärdatei
 * gerechnet, also können sie nicht auseinanderlaufen.
 */

import createAurelithCore from '@aurelith/core/wasm';
import { Core, type CoreMobDef, type CoreModuleFactory } from '@aurelith/core';
import { MOBS } from '@aurelith/shared';

export interface CoreBundle {
  core: Core;
  /** Von der Content-Kennung auf den Index im Kern. */
  mobIndexById: Map<string, number>;
  /** Rückweg: der Kern kennt nur Indizes, das Protokoll braucht Namen. */
  mobIdByIndex: string[];
}

/** Übersetzt eine Content-Definition in die Form, die der Kern erwartet. */
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
    // Der Kern rechnet in Sekunden, die Content-Tabelle notiert Millisekunden.
    attackCooldownSec: def.attackCooldownMs / 1000,
    attackWindupSec: def.attackWindupMs / 1000,
    radius: def.radius * def.scale,
    height: def.height * def.scale,
    expReward: def.expReward,
    goldReward: def.goldReward,
    level: def.level,
    aggressive: def.aggressive ? 1 : 0,
  };
}

export async function loadServerCore(): Promise<CoreBundle> {
  const core = await Core.fromModule(await (createAurelithCore as CoreModuleFactory)());

  const mobIndexById = new Map<string, number>();
  const mobIdByIndex: string[] = [];

  for (const id of MOBS.keys()) {
    const index = core.registerMob(toCoreMob(id));
    mobIndexById.set(id, index);
    mobIdByIndex[index] = id;
  }

  console.log(
    `[core] wasm-Kern ${core.version} geladen, ${core.mobCount} Monsterarten, Tickrate ${core.tickRate}`,
  );
  return { core, mobIndexById, mobIdByIndex };
}
