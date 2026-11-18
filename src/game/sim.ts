import { MODELS } from './data';
import { ScooterSim, type SimConfig } from './physics';
import { PitBikeSim } from './pitBikePhysics';
import type { Terrain } from './terrain';

export const isPitBike = (cfg: Pick<SimConfig, 'model'>) => MODELS[cfg.model]?.kind === 'pitbike';

/** Самокаты и питбайк считаются разными физическими моделями. */
export function createSim(terrain: Terrain, cfg: SimConfig): ScooterSim {
  return isPitBike(cfg) ? new PitBikeSim(terrain, cfg) : new ScooterSim(terrain, cfg);
}
