// Процедурный звук: мотор, шум шин по покрытию, визг/ABS и звуки ударов/приземлений

export interface AudioParams {
  speed: number;
  throttle: number;
  rough: number;
  slip: number;
  abs: boolean;
  crashed: boolean;
  impact?: number;
  ragdollHit?: number;
  timeScale?: number;
}

export class SimAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private noiseGain!: GainNode;
  private noiseFilter!: BiquadFilterNode;
  private skidGain!: GainNode;
  private absOsc!: OscillatorNode;
  private absGain!: GainNode;
  enabled = true;

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    this.master = master;

    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    this.osc1.connect(this.engFilter);
    this.osc2.connect(g2);
    g2.connect(this.engFilter);
    this.engFilter.connect(this.engGain);
    this.engGain.connect(master);
    this.osc1.start();
    this.osc2.start();

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const mkNoise = () => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 500;
    this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    mkNoise().connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(master);

    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 2400;
    skidFilter.Q.value = 3;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    mkNoise().connect(skidFilter);
    skidFilter.connect(this.skidGain);
    this.skidGain.connect(master);

    this.absOsc = ctx.createOscillator();
    this.absOsc.type = 'square';
    this.absOsc.frequency.value = 28;
    this.absGain = ctx.createGain();
    this.absGain.gain.value = 0;
    this.absOsc.connect(this.absGain);
    this.absGain.connect(master);
    this.absOsc.start();
  }

  playImpact(mag: number, timeScale = 1) {
    if (!this.ctx || !this.enabled || mag <= 0.1) return;
    const t = this.ctx.currentTime;
    const ts = Math.max(0.25, Math.min(1, timeScale));
    const dur = 0.16 / ts;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    const f0 = Math.min(220, (75 + mag * 18) * (0.65 + 0.35 * ts));
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(24, t + dur * 0.9);
    const vol = Math.min(0.45, 0.06 + mag * 0.055);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  playCrash(impactSpeed: number) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 1. Низкочастотный удар + эффект замедления времени (slow-mo drop)
    const sub = this.ctx.createOscillator();
    const subG = this.ctx.createGain();
    sub.type = 'sawtooth';
    const fStart = Math.min(210, 95 + impactSpeed * 6);
    sub.frequency.setValueAtTime(fStart, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 0.42);
    subG.gain.setValueAtTime(Math.min(0.55, 0.22 + impactSpeed * 0.02), t);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 0.46);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, t);
    lp.frequency.exponentialRampToValueAtTime(85, t + 0.42);
    sub.connect(lp);
    lp.connect(subG);
    subG.connect(this.master);
    sub.start(t);
    sub.stop(t + 0.48);

    // 2. Металлический кранч удара
    const crunch = this.ctx.createOscillator();
    const crunchG = this.ctx.createGain();
    crunch.type = 'square';
    crunch.frequency.setValueAtTime(340, t);
    crunch.frequency.exponentialRampToValueAtTime(58, t + 0.22);
    crunchG.gain.setValueAtTime(Math.min(0.28, 0.1 + impactSpeed * 0.012), t);
    crunchG.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    crunch.connect(crunchG);
    crunchG.connect(this.master);
    crunch.start(t);
    crunch.stop(t + 0.25);
  }

  playRagdollHit(mag: number, timeScale = 1) {
    if (!this.ctx || !this.enabled || mag <= 1.2) return;
    const t = this.ctx.currentTime;
    const ts = Math.max(0.25, Math.min(1, timeScale));
    const dur = 0.14 / ts;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    const f0 = Math.min(145, (55 + mag * 9) * (0.7 + 0.3 * ts));
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(25, t + dur * 0.9);
    const vol = Math.min(0.32, 0.05 + mag * 0.025);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  update(p: AudioParams) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.enabled ? 1 : 0;
    const ts = Math.max(0.2, Math.min(1, p.timeScale ?? 1));
    if (!Number.isFinite(p.speed) || !Number.isFinite(p.throttle) || !Number.isFinite(p.slip)) return;
    const sp = Math.abs(p.speed);
    const f = (55 + sp * 9 + p.throttle * 30) * (0.55 + 0.45 * ts);
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 2.01, t, 0.05);
    this.engFilter.frequency.setTargetAtTime((500 + sp * 60 + p.throttle * 700) * ts, t, 0.08);
    const eg = p.crashed ? 0 : on * (0.015 + Math.min(1, sp / 12) * 0.05 + p.throttle * 0.05);
    this.engGain.gain.setTargetAtTime(eg, t, 0.05);
    this.noiseFilter.frequency.setTargetAtTime((250 + sp * 55) * ts, t, 0.1);
    this.noiseGain.gain.setTargetAtTime(on * Math.min(1, sp / 14) * (0.03 + p.rough * 0.22) * ts, t, 0.06);
    this.skidGain.gain.setTargetAtTime(
      on * Math.min(1, Math.max(0, p.slip - 0.9) * 1.2) * Math.min(1, sp / 4) * 0.12 * ts,
      t,
      0.03,
    );
    this.absGain.gain.setTargetAtTime(on * (p.abs ? 0.04 : 0), t, 0.02);
    if (p.impact && p.impact > 0.2) {
      this.playImpact(p.impact, ts);
    }
    if (p.ragdollHit && p.ragdollHit > 1.3) {
      this.playRagdollHit(p.ragdollHit, ts);
    }
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
