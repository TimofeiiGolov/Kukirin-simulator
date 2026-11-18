import { BRAKES, MODELS, PADS, SURFACES, TIRES, type ModelId, type SurfaceId, type TireId, type Tune } from './data';

const G = 9.81;

export function staticSag(model: ModelId, riderKg: number, t: Tune) {
  const m = MODELS[model];
  const Mt = m.mass + riderKg;
  const Ff = (Mt * G * 0.6) / 1.16;
  const Fr = (Mt * G * 0.56) / 1.16;
  const sagF = (Ff / (t.fSpring * 1000)) * 1000 - t.fPre;
  const sagR = (Fr / (t.rSpring * 1000)) * 1000 - t.rPre;
  const travel = m.travel * 1000;
  const freqF = Math.sqrt((t.fSpring * 1000) / (Mt * 0.5 * 0.55)) / (2 * Math.PI);
  const freqR = Math.sqrt((t.rSpring * 1000) / (Mt * 0.5 * 0.5)) / (2 * Math.PI);
  return { sagF: Math.max(0, sagF), sagR: Math.max(0, sagR), travel, pctF: Math.max(0, sagF) / travel, pctR: Math.max(0, sagR) / travel, freqF, freqR };
}

export function effMu(surface: SurfaceId, tire: TireId, psi: number) {
  const sf = SURFACES[surface];
  const pf = Math.min(1, Math.max(0.6, 1 - 0.0055 * Math.max(0, psi - sf.optPsi) - 0.004 * Math.max(0, sf.optPsi - psi)));
  return sf.mu * TIRES[tire].grip[surface] * pf;
}

export function stoppingDistance(
  surface: SurfaceId,
  tire: TireId,
  wheelInch: number,
  t: Tune,
  massKg: number,
  kmh = 30,
) {
  const v = kmh / 3.6;
  const mu = effMu(surface, tire, (t.fPsi + t.rPsi) / 2);
  const R = wheelInch * 0.0254 * 0.52;
  const bt = BRAKES[t.brakeType];
  const pad = PADS[t.pad];
  const wetK = surface === 'wet' || surface === 'snow' ? pad.wet : 1;
  const cap = (2 * 125 * bt.torque * (t.rotor / 160) * pad.bite * wetK) / (R * massKg);
  const ideal = 0.45 + 0.2 * mu;
  const biasErr = Math.abs(t.bias / 100 - ideal);
  const biasEff = Math.max(0.55, 1 - 1.1 * biasErr);
  const absEff = t.abs ? Math.max(0.78, 0.97 - Math.max(0, t.absThr - 16) * 0.006 - Math.max(0, 8 - t.absThr) * 0.01) : 0.82;
  const a = Math.min(mu * G * 0.93 * biasEff * absEff, cap);
  return (v * v) / (2 * a);
}
