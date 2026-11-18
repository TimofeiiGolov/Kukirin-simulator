import * as THREE from 'three';
import {
  emptyInput,
  type Look,
  type MapId,
  type SimInput,
  type Settings,
  type SurfaceId,
  type Telemetry,
  type Tune,
} from './data';
import { SimAudio } from './audio';
import { DT, ScooterSim, type SimConfig } from './physics';
import { PitBikeSim } from './pitBikePhysics';
import { createSim, isPitBike } from './sim';
import { DamageSystem } from './damage';
import { P_CHEST, P_PELVIS, RagdollSim, ReplaySystem } from './ragdoll';
import { XrayView } from './xray';
import { buildScooter, type ScooterRig, type VisualState } from './scooterModel';
import { createFlatTerrain, createTerrain } from './terrain';
import { FAR_LAYER } from './cityEnv';
import { createWorld, type World } from './world';
import { FpsMeter, FrameLimiter, ResolutionGovernor, SimInterpolator } from './framePacing';

// Шагов физики за кадр хватает на весь допустимый кадр (0.05 с): ниже ~34 FPS игра не замедляется.
const MAX_STEPS = Math.ceil(0.05 / DT);

export type GameAction =
  | 'camera'
  | 'mode'
  | 'menu'
  | 'recover'
  | 'map'
  | 'replay'
  | 'replayPause'
  | 'replaySlowMo'
  | 'replayCam'
  | 'xray';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrapPi = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

const ROUGH: Record<SurfaceId, number> = {
  asphalt: 0.12,
  wet: 0.14,
  tiles: 0.3,
  cobble: 0.65,
  gravel: 0.85,
  dirt: 0.7,
  grass: 0.5,
  sand: 0.35,
  snow: 0.3,
};

/** Граница между ближним и дальним срезом глубины, м. */
const DEPTH_SPLIT = 2;

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 0.05, 2500);
  terrain = createTerrain('city');
  world: World;
  sim: ScooterSim;
  rig: ScooterRig | null = null;
  audio = new SimAudio();
  ragdoll = new RagdollSim();
  replay = new ReplaySystem();

  touch: SimInput = emptyInput();
  private pressed = new Set<string>();
  private kSteer = 0;

  look!: Look;
  tune!: Tune;
  settings!: Settings;
  private lookKey = '';
  private restCache = new Map<string, { yb: number; th: number }>();
  private rest = { yb: 0.8, th: 0 };

  paused = true;
  private garagePreviewActive = false;
  layout: 'right' | 'bottom' = 'right';
  private camYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private tpvZoom = 1.0;
  private lastDrag = -10;
  private garAz = 0.7;
  private garEl = 0.18;
  private garZoom = 1.0;
  private garFocus = new THREE.Vector3(0, 0.68, 0);
  private garFocusGoal = new THREE.Vector3(0, 0.68, 0);
  private garZoomGoal = 1.0;
  private garAzGoal: number | null = null;
  private garElGoal = 0.18 as number | null;
  private garDragging = false;
  private crashVis = 0;
  private camShake = 0;

  // Таймеры живого слоумо и авто-перехода к повтору
  private crashRealTime = 0;
  private liveSlowMo = 1.0;
  private autoReplayTriggered = false;
  damage = new DamageSystem();
  private xray!: XrayView;
  private camTargetSmooth = new THREE.Vector3();
  private recordComTmp = new THREE.Vector3();

  // 3D-эффект вспышки и разлёта искр при скоростном ударе
  private impactGroup = new THREE.Group();
  private impactRing!: THREE.Mesh;
  private impactRingMat!: THREE.MeshBasicMaterial;
  private impactSparks: { mesh: THREE.Mesh; vx: number; vy: number; vz: number }[] = [];
  private impactSparkMat!: THREE.MeshBasicMaterial;
  private sparkBurstAge = -1;

  private raf = 0;
  private last = 0;
  private acc = 0;
  private limiter = new FrameLimiter();
  private fpsMeter = new FpsMeter();
  private governor = new ResolutionGovernor();
  private interp = new SimInterpolator();
  private renderedMain = false;
  private telemT = 0;
  private disposed = false;
  private ro: ResizeObserver;
  private dragId = -1;
  private dragX = 0;
  private dragY = 0;

  constructor(
    private container: HTMLElement,
    private onTelemetry: (t: Telemetry) => void,
    private onAction: (a: GameAction) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft в three r18x удалён и всё равно подменяется на PCF
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.container.appendChild(this.renderer.domElement);
    const cv = this.renderer.domElement;
    cv.style.display = 'block';
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.touchAction = 'none';

    this.world = createWorld(this.scene, this.terrain, this.renderer);
    this.initImpactBurst();
    this.ragdoll.damage = this.damage;
    this.xray = new XrayView(this.container);
    this.scene.add(this.xray.group);

    this.sim = new ScooterSim(this.terrain, {
      model: 'g2pro',
      wheel: 10,
      tire: 'off',
      tune: {
        fSpring: 26,
        rSpring: 28,
        fPre: 6,
        rPre: 6,
        fComp: 50,
        fReb: 55,
        rComp: 50,
        rReb: 55,
        fPsi: 34,
        rPsi: 36,
        steerDamper: 30,
        steerSens: 100,
        brakeType: 'hyd4',
        rotor: 160,
        pad: 'semi',
        bias: 55,
        curve: 1.3,
        regen: 35,
        abs: true,
        absThr: 14,
        tcs: false,
      },
      riderKg: 75,
      mode: 'drive',
      crash: true,
    });
    this.sim.respawn();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    cv.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    cv.addEventListener('wheel', this.onWheel, { passive: true });
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  private initImpactBurst() {
    this.impactGroup.visible = false;
    this.scene.add(this.impactGroup);

    this.impactRingMat = new THREE.MeshBasicMaterial({
      color: '#ff7b1c',
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.impactRing = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.34, 28), this.impactRingMat);
    this.impactRing.rotation.x = -Math.PI / 2;
    this.impactGroup.add(this.impactRing);

    this.impactSparkMat = new THREE.MeshBasicMaterial({
      color: '#ffbe3b',
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const sparkGeo = new THREE.BoxGeometry(0.16, 0.018, 0.018);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(sparkGeo, this.impactSparkMat);
      const az = (i / 24) * Math.PI * 2 + (i % 3) * 0.19;
      const el = 0.25 + ((i * 7) % 11) * 0.08;
      const spd = 2.4 + ((i * 13) % 9) * 0.55;
      this.impactSparks.push({
        mesh: m,
        vx: Math.cos(az) * Math.cos(el) * spd,
        vy: Math.sin(el) * spd + 1.6,
        vz: Math.sin(az) * Math.cos(el) * spd,
      });
      this.impactGroup.add(m);
    }
  }

  private updateImpactBurst(age: number, pos?: THREE.Vector3) {
    if (pos) {
      this.impactGroup.position.copy(pos);
    }
    if (age < 0 || age > 0.75) {
      this.impactGroup.visible = false;
      return;
    }
    this.impactGroup.visible = true;
    const p = clamp(age / 0.75, 0, 1);
    const ringScale = 0.6 + p * 6.5;
    this.impactRing.scale.set(ringScale, ringScale, 1);
    this.impactRing.position.y = 0.05;
    this.impactRingMat.opacity = Math.max(0, (1 - p) * 0.75);

    this.impactSparkMat.opacity = Math.max(0, 1 - p * 0.9);
    for (let i = 0; i < this.impactSparks.length; i++) {
      const s = this.impactSparks[i];
      const sx = s.vx * age;
      const sy = s.vy * age - 0.5 * 9.81 * age * age;
      const sz = s.vz * age;
      s.mesh.position.set(sx, Math.max(-0.15, sy), sz);
      s.mesh.rotation.y = Math.atan2(-s.vz, s.vx);
      s.mesh.rotation.z = Math.atan2(s.vy - 9.81 * age, Math.hypot(s.vx, s.vz));
      const sc = Math.max(0.15, 1 - p * 0.85);
      s.mesh.scale.set(sc, sc, sc);
    }
  }

  // ------------------------------------------------------------------ конфиг
  private simConfig(): SimConfig {
    return {
      model: this.look.model,
      wheel: this.look.wheel,
      tire: this.look.tire,
      tune: this.tune,
      riderKg: this.settings.riderKg,
      mode: this.settings.mode,
      crash: this.settings.crash,
    };
  }

  private computeRest(): { yb: number; th: number } {
    const t = this.tune;
    const key = `${this.look.model}|${this.look.wheel}|${t.fSpring}|${t.rSpring}|${t.fPre}|${t.rPre}|${t.fPsi}|${t.rPsi}|${this.settings.riderKg}`;
    let r = this.restCache.get(key);
    if (!r) {
      const s = createSim(createFlatTerrain(), {
        model: this.look.model,
        wheel: this.look.wheel,
        tire: this.look.tire,
        tune: { ...t },
        riderKg: this.settings.riderKg,
        mode: 'drive',
        crash: false,
      });
      s.reset(0, 0, 0);
      r = { yb: s.yb, th: s.th };
      if (this.restCache.size > 60) this.restCache.clear();
      this.restCache.set(key, r);
    }
    return r;
  }

  private switchMap(mapId: MapId) {
    if (this.terrain.mapId === mapId) return;
    this.replay.stopReplay();
    this.replay.resetLive();
    this.replay.clearClip();
    this.damage.clear();
    this.hideXray();
    this.ragdoll.reset();
    this.sparkBurstAge = -1;
    this.updateImpactBurst(-1);
    this.world.dispose();
    this.terrain = createTerrain(mapId);
    this.world = createWorld(this.scene, this.terrain, this.renderer);
    this.world.setTime(this.settings.time);
    this.applyQuality();
    this.sim.setTerrain(this.terrain);
    this.camYaw = this.sim.psi;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.crashVis = 0;
    this.camShake = 0;
  }

  setConfig(look: Look, tune: Tune, settings: Settings) {
    const prevSettings = this.settings;
    this.look = look;
    this.tune = tune;
    this.settings = settings;

    const targetMap: MapId = settings.map ?? 'city';
    if (this.terrain.mapId !== targetMap) {
      this.switchMap(targetMap);
    }

    this.rest = this.computeRest();
    const key = JSON.stringify(look) + '|' + tune.rotor + '|' + tune.brakeType;
    if (key !== this.lookKey) {
      this.lookKey = key;
      this.rebuildRig();
    }
    const cfg = this.simConfig();
    if (isPitBike(cfg) !== this.sim instanceof PitBikeSim) {
      // другая физическая модель: пересоздаём симуляцию на том же месте
      const prev = this.sim;
      this.sim = createSim(this.terrain, cfg);
      this.sim.reset(prev.px, prev.pz, prev.psi);
      this.sim.battery = prev.battery;
    } else {
      this.sim.configure(cfg);
    }

    if (prevSettings && prevSettings.lang !== settings.lang) this.world.relabel();
    if (!prevSettings || prevSettings.time !== settings.time) this.world.setTime(settings.time);
    if (!prevSettings || prevSettings.quality !== settings.quality) this.applyQuality();
    else if (prevSettings.adaptiveRes !== settings.adaptiveRes) this.applyPixelRatio();
    if (prevSettings && prevSettings.fpsCap !== settings.fpsCap) this.limiter.reset();
    // смена карты, времени суток или модели даёт разовые подвисания на компиляции — их не считаем
    this.governor.reset(performance.now());
    this.audio.enabled = settings.sound;
    this.updateFirstPersonVisibility();
  }

  private updateFirstPersonVisibility() {
    if (!this.rig) return;
    if (this.paused) {
      this.rig.setFirstPerson(false);
    } else if (this.replay.active) {
      this.rig.setFirstPerson(this.replay.camMode === 'fpv');
    } else if (this.ragdoll.active) {
      // Во время полёта рэгдолла показываем персонажа со стороны, даже если до удара была камера от 1-го лица
      this.rig.setFirstPerson(false);
    } else {
      this.rig.setFirstPerson(this.settings.camera === 'fpv');
    }
  }

  private hideXray() {
    this.xray.hide();
    this.rig?.rider.setXray(null);
  }

  /** Время от начала аварии по часам повтора, с. */
  private replayCrashAge() {
    return this.replay.cursor - this.replay.impactTime;
  }

  private rebuildRig() {
    if (this.rig) {
      this.scene.remove(this.rig.root);
      this.rig.dispose();
    }
    this.rig = buildScooter(this.look, this.tune);
    this.scene.add(this.rig.root);
    this.updateFirstPersonVisibility();
  }

  private applyQuality() {
    const q = this.settings.quality;
    this.governor.reset(performance.now(), false);
    this.applyPixelRatio();
    this.renderer.shadowMap.enabled = q !== 'low';
    this.world.sun.castShadow = q !== 'low';
    this.world.setShadowSize(q === 'high' ? 2048 : 1024);
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  /** Плотность пикселей: потолок по качеству графики, умноженный на долю адаптивного разрешения. */
  private applyPixelRatio() {
    const q = this.settings.quality;
    const dpr = window.devicePixelRatio || 1;
    const base = q === 'low' ? Math.min(dpr, 1) : q === 'med' ? Math.min(dpr, 1.5) : Math.min(dpr, 2);
    const scale = this.settings.adaptiveRes ? this.governor.scale : 1;
    this.renderer.setPixelRatio(Math.max(0.5, base * scale));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight, false);
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) {
      this.replay.stopReplay();
      this.garAz = this.sim.psi * -1 + 2.2;
      if (this.sim.crashed) this.recover();
      this.pressed.clear();
      this.kSteer = 0;
      this.dragId = -1;
      this.garDragging = false;
    }
    this.updateFirstPersonVisibility();
    this.resize();
  }

  setGaragePreviewActive(active: boolean) {
    this.garagePreviewActive = active;
  }

  setLayout(l: 'right' | 'bottom') {
    this.layout = l;
    this.resize();
  }

  respawn() {
    this.replay.stopReplay();
    this.replay.resetLive();
    this.ragdoll.reset();
    this.sparkBurstAge = -1;
    this.updateImpactBurst(-1);
    this.sim.battery = 1;
    this.sim.respawn();
    this.rig?.rider.resetPose();
    this.camYaw = this.sim.psi;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.crashVis = 0;
    this.camShake = 0;
    this.crashRealTime = 0;
    this.acc = 0;
    this.liveSlowMo = 1.0;
    this.autoReplayTriggered = false;
    this.camTargetSmooth.set(0, 0, 0);
    this.updateFirstPersonVisibility();
    this.emitTelemetryNow();
  }

  recover() {
    if (this.sim.crashed) {
      this.replay.finalizeClipFromLive();
    }
    this.replay.stopReplay();
    this.replay.resetLive();
    this.ragdoll.reset();
    this.sparkBurstAge = -1;
    this.updateImpactBurst(-1);
    this.sim.recover();
    this.rig?.rider.resetPose();
    this.crashVis = 0;
    this.crashRealTime = 0;
    this.acc = 0;
    this.liveSlowMo = 1.0;
    this.autoReplayTriggered = false;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.camTargetSmooth.set(0, 0, 0);
    this.updateFirstPersonVisibility();
    this.emitTelemetryNow();
  }

  startReplay() {
    // Если повтор уже активен, нажатие кнопки «Выход» / клавиши P закрывает повтор
    if (this.replay.active) {
      this.stopReplay();
      return;
    }
    if (this.replay.startReplay()) {
      this.orbitYaw = 0;
      this.orbitPitch = 0.08;
      this.camTargetSmooth.set(0, 0, 0);
      this.updateFirstPersonVisibility();
      this.emitTelemetryNow();
    }
  }

  stopReplay() {
    if (!this.replay.active) return;
    this.replay.stopReplay();
    if (this.sim.crashed) {
      this.recover();
      return;
    }
    this.camTargetSmooth.set(0, 0, 0);
    this.updateFirstPersonVisibility();
    this.emitTelemetryNow();
  }

  toggleReplayPause() {
    this.replay.togglePause();
    this.emitTelemetryNow();
  }

  cycleReplaySlowMo() {
    this.replay.cycleSlowMo();
    this.emitTelemetryNow();
  }

  cycleReplayCam() {
    this.replay.cycleCamMode();
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.camTargetSmooth.set(0, 0, 0);
    this.updateFirstPersonVisibility();
    this.emitTelemetryNow();
  }

  seekReplay(norm01: number) {
    if (!this.replay.active) {
      this.replay.startReplay();
    }
    this.replay.seekNormalized(norm01);
    this.camTargetSmooth.set(0, 0, 0);
    this.emitTelemetryNow();
  }

  private emitTelemetryNow() {
    this.telemT = 0;
    this.onTelemetry(this.buildTelemetry());
  }

  focusGaragePart(part: 'all' | 'front' | 'rear' | 'cockpit' | 'deck') {
    const psi = this.sim.psi;
    this.lastDrag = performance.now() / 1000;
    if (part === 'all') {
      this.garFocusGoal.set(0, 0.68, 0);
      this.garZoomGoal = 1.0;
      this.garAzGoal = -psi + 0.65;
      this.garElGoal = 0.18;
    } else if (part === 'front') {
      this.garFocusGoal.set(0.48, 0.22, 0);
      this.garZoomGoal = 0.42;
      this.garAzGoal = -psi + 0.55;
      this.garElGoal = 0.12;
    } else if (part === 'rear') {
      this.garFocusGoal.set(-0.48, 0.2, 0);
      this.garZoomGoal = 0.42;
      this.garAzGoal = -psi + 2.45;
      this.garElGoal = 0.14;
    } else if (part === 'cockpit') {
      this.garFocusGoal.set(0.28, 1.08, 0);
      this.garZoomGoal = 0.38;
      this.garAzGoal = -psi + 2.65;
      this.garElGoal = 0.28;
    } else if (part === 'deck') {
      this.garFocusGoal.set(-0.04, 0.22, 0);
      this.garZoomGoal = 0.5;
      this.garAzGoal = -psi + 1.15;
      this.garElGoal = 0.34;
    }
  }

  // ------------------------------------------------------------------ события
  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
    this.audio.start();

    if (e.code === 'Escape' || e.code === 'KeyG' || (e.code === 'Tab' && !this.paused)) {
      if (!e.repeat) {
        e.preventDefault();
        this.onAction('menu');
      }
      return;
    }

    if (this.paused || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.repeat) {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
        e.preventDefault();
      }
      return;
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
      e.preventDefault();
    }

    // Горячие клавиши повтора со слоумо
    if (e.code === 'KeyP') {
      this.onAction('replay');
      return;
    }
    if (e.code === 'KeyV') {
      if (this.replay.active) this.onAction('replayCam');
      else this.onAction('camera');
      return;
    }
    if (this.replay.active && e.code === 'Space') {
      this.onAction('replayPause');
      return;
    }
    if (this.replay.active && e.code === 'KeyX') {
      this.onAction('xray');
      return;
    }

    this.pressed.add(e.code);
    if (e.code === 'KeyC') {
      if (this.replay.active) this.onAction('replayCam');
      else this.onAction('camera');
    } else if (e.code === 'KeyM') this.onAction('mode');
    else if (e.code === 'KeyN') this.onAction('map');
    else if (e.code === 'KeyR') this.onAction('recover');
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.pressed.delete(e.code);
  };

  private onWindowBlur = () => {
    this.pressed.clear();
    this.kSteer = 0;
    this.dragId = -1;
    this.garDragging = false;
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      this.onWindowBlur();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.audio.start();
    this.dragId = e.pointerId;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.garDragging = true;
    this.garAzGoal = null;
    this.garElGoal = null;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.dragId) return;
    const dx = e.clientX - this.dragX;
    const dy = e.clientY - this.dragY;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.lastDrag = performance.now() / 1000;
    if (this.paused) {
      this.garAz -= dx * 0.008;
      this.garEl = clamp(this.garEl + dy * 0.006, -0.05, 1.2);
    } else {
      this.orbitYaw = clamp(this.orbitYaw - dx * 0.006, -Math.PI, Math.PI);
      this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, -0.35, 0.85);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.dragId) {
      this.dragId = -1;
      this.garDragging = false;
    }
  };

  private onWheel = (e: WheelEvent) => {
    const delta = Math.sign(e.deltaY) * 0.08;
    if (this.paused) {
      this.garZoom = clamp(this.garZoom + delta, 0.32, 1.55);
      this.garZoomGoal = this.garZoom;
    } else {
      this.tpvZoom = clamp(this.tpvZoom + delta, 0.55, 1.85);
    }
  };

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.governor.reset(performance.now());
    if (this.paused) {
      // центр кадра — в видимой части экрана рядом с панелью гаража (размеры как в garage.css)
      if (this.layout === 'right') {
        const short = h <= 560;
        const panel = Math.min(short ? 380 : 432, w * (short ? 0.5 : 0.46)) + (short ? 16 : 32);
        this.camera.setViewOffset(w, h, panel / 2, 0, w, h);
      } else this.camera.setViewOffset(w, h, 0, h * 0.27, w, h);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ цикл
  private mergeInput(dt: number): SimInput {
    const p = this.pressed;
    const t = this.touch;
    const up = p.has('KeyW') || p.has('ArrowUp');
    const sL = p.has('KeyA') || p.has('ArrowLeft');
    const sR = p.has('KeyD') || p.has('ArrowRight');
    const target = (sR ? 1 : 0) - (sL ? 1 : 0);
    const absSpd = Math.abs(this.sim.u);
    // При отпускании руля или перекладке в обратную сторону — быстрый и точный возврат в центр,
    // при входе в поворот с клавиатуры — плавный прогрессивный набор угла (особенно на скорости)
    const returning = target === 0 || target * this.kSteer < 0;
    const steerRate = returning
      ? 9.8
      : clamp((4.2 + 2.8 * Math.abs(this.kSteer)) / (1 + absSpd * 0.025), 2.8, 6.5);
    this.kSteer += clamp(target - this.kSteer, -steerRate * dt, steerRate * dt);
    if (target === 0 && Math.abs(this.kSteer) < 0.008) this.kSteer = 0;
    const brakeKey = p.has('Space') || p.has('KeyS') || p.has('ArrowDown');
    const leanK = (p.has('KeyE') ? 1 : 0) - (p.has('KeyQ') ? 1 : 0);
    const stuntKey = p.has('ShiftLeft') || p.has('ShiftRight') || p.has('KeyF');
    return {
      throttle: Math.max(up ? 1 : 0, t.throttle),
      steer: clamp(this.kSteer + t.steer, -1, 1),
      lean: clamp(leanK + t.lean, -1, 1),
      brake: Math.max(brakeKey ? 1 : 0, t.brake),
      brakeF: Math.max(p.has('KeyZ') ? 1 : 0, t.brakeF),
      brakeR: Math.max(p.has('KeyX') ? 1 : 0, t.brakeR),
      stunt: Math.max(stuntKey ? 1 : 0, t.stunt ?? 0),
    };
  }

  private buildTelemetry(): Telemetry {
    const tel = this.sim.telemetry();
    const isReplaying = this.replay.active;
    tel.ragdollActive = this.ragdoll.active || isReplaying;
    tel.crashImpactKmh = isReplaying ? this.replay.impactKmh : this.ragdoll.impactKmh;
    tel.crashPeakG = isReplaying ? this.replay.peakG : this.ragdoll.peakG;
    tel.ragdollFlightDist = isReplaying ? this.replay.maxFlightDist : this.ragdoll.flightDist;
    tel.ragdollMaxHeight = isReplaying ? this.replay.maxHeight : this.ragdoll.maxHeight;
    tel.liveSlowMo = this.liveSlowMo;
    tel.replayActive = isReplaying;
    tel.replayPaused = this.replay.paused;
    tel.replayTime = this.replay.cursor;
    tel.replayDuration = this.replay.duration;
    tel.replayImpactTime = this.replay.impactTime;
    tel.replaySlowMo = this.replay.slowMoFactor;
    tel.replayEffectiveSpeed = this.replay.effectiveSpeed;
    tel.replayCamMode = this.replay.camMode;
    tel.hasReplay = this.replay.hasClip;
    if (isReplaying && this.replay.crashReason) {
      tel.crashReason = this.replay.crashReason;
    }
    if (this.settings.xray && this.damage.active && (isReplaying || tel.crashed)) {
      tel.damage = this.damage.evaluate(isReplaying ? this.replayCrashAge() : Infinity).report;
    }
    tel.xrayActive = isReplaying && this.xray.visible;
    tel.fps = this.fpsMeter.fps;
    tel.renderScale = this.settings.adaptiveRes ? this.governor.scale : 1;
    return tel;
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.limiter.shouldRender(now, this.settings.fpsCap ?? 60)) return;
    const t0 = performance.now();
    const interval = now - this.last;
    this.last = now;
    this.fpsMeter.tick(now);
    try {
      this.frame(Math.min(0.05, interval / 1000 || 0.016));
    } finally {
      this.interp.restore();
    }
    if (this.renderedMain) {
      this.renderedMain = false;
      // цель — не ниже 60 FPS даже без ограничения, и 30 при ограничении 30
      const target = this.settings.fpsCap || 60;
      if (this.settings.adaptiveRes && this.governor.sample(now, interval, performance.now() - t0, target)) this.applyPixelRatio();
    }
  };

  private frame(dt: number) {
    const sim = this.sim;
    const rig = this.rig;

    // ====================================================================
    // РЕЖИМ ПОВТОРА СО СЛОУМО (INSTANT SLOW-MO REPLAY)
    // ====================================================================
    if (!this.paused && this.replay.active) {
      const sample = this.replay.stepReplay(dt, sim.cones);
      if (sample && rig) {
        rig.update(sample.vs, 0);
        const kmh = Math.abs(sample.vs.speed) * 3.6;
        rig.setDisplay(
          this.settings.mph ? kmh * 0.6214 : kmh,
          this.settings.mph ? 'mph' : 'km/h',
          sim.battery,
          this.settings.mode,
          sample.vs.stuntAngle ?? 0,
        );
        rig.headlight.intensity = this.world.headlightLevel() * 45;
        rig.setEnvIntensity(1 - 0.75 * this.world.headlightLevel());
        if (rig.glowLight) rig.glowLight.intensity = 1 + this.world.headlightLevel() * 2;

        this.updateImpactBurst(sample.sparkBurstAge, this.replay.impactPos);
        this.updateReplayCamera(dt, sample);

        // Рентген: включается за мгновение до удара и показывает травмы, полученные к этому моменту
        const age = this.replayCrashAge();
        const level = this.settings.xray && this.damage.active ? clamp((age + 0.14) / 0.14, 0, 1) : 0;
        rig.rider.setXray(level > 0.01 ? this.xray.ghost : null);
        if (level > 0.01) {
          const state = this.damage.evaluate(age);
          this.xray.update(
            {
              pose: sample.riderPose,
              sites: state.sites,
              injuries: state.report.injuries,
              age,
              level,
              hideHead: this.replay.camMode === 'fpv',
              time: performance.now() / 1000,
            },
            this.camera,
          );
        } else {
          this.xray.hide();
        }
        this.world.update(
          this.camera.position,
          new THREE.Vector3(sample.comX, sample.vs.groundRef, sample.comZ),
          sample.cones,
        );
      }

      this.renderFrame();
      this.audio.update({
        speed: sample ? sample.vs.speed : 0,
        throttle: sample ? (sample.vs.throttle ?? 0) : 0,
        rough: 0.15,
        slip: 0,
        abs: false,
        crashed: sample ? sample.crashed : true,
        timeScale: this.replay.effectiveSpeed,
      });

      this.telemT += dt;
      if (this.telemT > 0.05) {
        this.emitTelemetryNow();
      }
      return;
    }

    // ====================================================================
    // ОБЫЧНЫЙ РЕЖИМ ЕЗДЫ И ЖИВОЙ РЭГДОЛЛ С ЭФФЕКТОМ СЛОУМО ПРИ УДАРЕ
    // ====================================================================
    if (this.xray.visible) this.hideXray();
    const input = this.mergeInput(dt);

    if (!this.paused) {
      // Живое слоумо в момент аварии: резко замедляем время до 0.30x при ударе, затем плавно до 0.65x
      if (sim.crashed && this.ragdoll.active) {
        this.crashRealTime += dt;
        if (this.crashRealTime < 0.85) {
          this.liveSlowMo = 0.3;
        } else if (this.crashRealTime < 2.2) {
          const k = (this.crashRealTime - 0.85) / 1.35;
          this.liveSlowMo = 0.3 + k * 0.38;
        } else {
          this.liveSlowMo = 0.72;
        }
      } else {
        this.liveSlowMo = 1.0;
      }

      const simDt = dt * this.liveSlowMo;
      this.acc += simDt;
      let n = 0;
      while (this.acc >= DT && n < MAX_STEPS) {
        this.interp.beforeStep(sim);
        sim.step(input, DT);
        if (sim.justCrashed) {
          sim.justCrashed = false;
          this.onCrashTriggered();
        }
        this.acc -= DT;
        n++;
      }
      if (n >= MAX_STEPS) this.acc = 0;
      // дальше всё рисуется по состоянию между двумя шагами физики; после кадра loop его вернёт
      this.interp.apply(sim, this.acc / DT);

      if (this.ragdoll.active) {
        const scGround = Math.min(sim.wf.y, sim.wr.y) - sim.R;
        this.ragdoll.step(simDt, this.terrain, {
          x: sim.px,
          y: scGround,
          z: sim.pz,
          psi: sim.psi,
          lay: this.crashVis,
          side: sim.crashSide,
        });
      }

      if (this.sparkBurstAge >= 0) {
        this.sparkBurstAge += simDt;
        this.updateImpactBurst(this.sparkBurstAge);
      }
    }

    const impact = sim.impactMag;
    sim.impactMag = 0;
    if (impact > 0.2) {
      this.camShake = Math.min(1.0, this.camShake + impact * 0.14);
    }
    const ragdollHit = this.ragdoll.lastHitImpact;
    this.ragdoll.lastHitImpact = 0;
    if (ragdollHit > 1.8) {
      this.camShake = Math.min(0.75, this.camShake + ragdollHit * 0.05);
    }
    this.camShake = Math.max(0, this.camShake - dt * 3.2);

    const stepVisDt = dt * this.liveSlowMo;
    if (sim.crashed) this.crashVis = Math.min(1, this.crashVis + stepVisDt * 3.2);
    else this.crashVis = Math.max(0, this.crashVis - dt * 2.0);

    const groundRef = sim.airborne
      ? this.terrain.height(sim.px, sim.pz)
      : Math.min(sim.wf.y, sim.wr.y) - sim.R;

    if (rig) {
      const e = 1 - Math.pow(1 - this.crashVis, 3);
      const vs: VisualState = {
        x: sim.px,
        z: sim.pz,
        psi: sim.psi,
        groundRef,
        yb: sim.yb,
        th: sim.th,
        phi: sim.phi,
        delta: sim.delta,
        ybRest: this.rest.yb,
        thRest: this.rest.th,
        wf: { x: sim.a0, y: sim.wf.y, angle: sim.wf.angle, temp: sim.wf.temp, comp: sim.wf.comp },
        wr: { x: -sim.b0, y: sim.wr.y, angle: sim.wr.angle, temp: sim.wr.temp, comp: sim.wr.comp },
        az: sim.azBody,
        ax: sim.axB,
        lean: sim.lean,
        leanLat: sim.leanLat,
        crashE: e,
        crashSide: sim.crashSide,
        speed: sim.u,
        throttle: sim.thr,
        brake: Math.max(sim.wf.eff, sim.wr.eff),
        parked: this.paused,
        stuntAngle: this.paused ? 0 : sim.stuntAngle,
        tailScrape: !this.paused && sim.tailScrape,
        worldRiderPose: this.ragdoll.active ? this.ragdoll.pos : undefined,
      };
      rig.update(vs, this.paused ? 0 : stepVisDt);

      const kmh = Math.abs(sim.u) * 3.6;
      rig.setDisplay(
        this.settings.mph ? kmh * 0.6214 : kmh,
        this.settings.mph ? 'mph' : 'km/h',
        sim.battery,
        this.settings.mode,
        this.paused ? 0 : sim.stuntAngle,
      );
      rig.headlight.intensity = this.world.headlightLevel() * 45;
      rig.setEnvIntensity(1 - 0.75 * this.world.headlightLevel());
      if (rig.glowLight) rig.glowLight.intensity = 1 + this.world.headlightLevel() * 2;

      // Запись кадра в буфер мгновенного повтора
      if (!this.paused) {
        const pose = this.ragdoll.active ? this.ragdoll.pos : rig.rider.lastWorldPose;
        const com = this.ragdoll.active
          ? this.ragdoll.comPos
          : this.recordComTmp.set(
              (pose[P_PELVIS * 3] + pose[P_CHEST * 3]) * 0.5,
              (pose[P_PELVIS * 3 + 1] + pose[P_CHEST * 3 + 1]) * 0.5,
              (pose[P_PELVIS * 3 + 2] + pose[P_CHEST * 3 + 2]) * 0.5,
            );
        this.replay.recordStep(
          stepVisDt,
          vs,
          pose,
          com,
          sim.crashed,
          this.sparkBurstAge,
          sim.cones,
          this.ragdoll.flightDist,
          this.ragdoll.maxHeight,
          this.ragdoll.peakG,
        );

        // Автоматический запуск повтора со слоумо через ~2.15 с реального времени после столкновения
        // …но не раньше, чем тело уляжется: иначе в повтор и в подсчёт травм попадёт только начало падения
        if (
          sim.crashed &&
          this.ragdoll.active &&
          !this.autoReplayTriggered &&
          this.crashRealTime >= 2.15 &&
          (this.ragdoll.settled || this.ragdoll.age >= 3.3)
        ) {
          this.autoReplayTriggered = true;
          this.startReplay();
        }
      }
    }

    this.updateCamera(dt, groundRef);
    const focusWorld = this.ragdoll.active
      ? new THREE.Vector3(this.ragdoll.comPos.x, groundRef, this.ragdoll.comPos.z)
      : new THREE.Vector3(sim.px, groundRef, sim.pz);
    this.world.update(this.camera.position, focusWorld, sim.cones);
    // The standalone preview and settings fully cover the map on the model tab.
    if (!this.paused || !this.garagePreviewActive) this.renderFrame();

    const tel = this.buildTelemetry();
    this.audio.update({
      speed: tel.speed,
      throttle: this.paused ? 0 : tel.throttle,
      rough: ROUGH[tel.surface],
      slip: Math.max(tel.slipF, tel.slipR),
      abs: tel.absActive && !this.paused,
      crashed: tel.crashed || this.paused,
      impact: this.paused ? 0 : impact,
      ragdollHit: this.paused ? 0 : ragdollHit,
      timeScale: this.liveSlowMo,
    });

    this.telemT += dt;
    if (this.telemT > 0.08) {
      this.telemT = 0;
      this.onTelemetry(tel);
    }
  }

  private onCrashTriggered() {
    const sim = this.sim;
    const info = sim.lastCrashInfo;
    if (!info || !this.rig) return;

    this.rig.root.updateMatrixWorld(true);
    this.rig.rider.captureWorldPose(this.rig.frame);

    this.damage.begin({ helmet: this.look.helmet, riderKg: this.settings.riderKg }, sim.time);
    this.ragdoll.trigger(
      this.rig.rider.lastWorldPose,
      info,
      sim.psi,
      sim.r,
      sim.crashSide,
      this.terrain,
    );
    this.replay.onCrashStart(info, sim.psi);

    this.crashRealTime = 0;
    this.liveSlowMo = 0.28;
    this.autoReplayTriggered = false;
    this.camShake = 1.0;

    this.sparkBurstAge = 0;
    this.updateImpactBurst(0, new THREE.Vector3(info.impactX, info.impactY, info.impactZ));

    this.audio.playCrash(Math.max(info.preSpeed, info.impactVn));
    this.updateFirstPersonVisibility();
    this.emitTelemetryNow();
  }

  private updateReplayCamera(
    dt: number,
    sample: {
      vs: VisualState;
      comX: number;
      comY: number;
      comZ: number;
      crashed: boolean;
    },
  ) {
    const cam = this.camera;
    const mode = this.replay.camMode;

    // 1. Вид от 1-го лица (шлем райдера в полёте)
    if (mode === 'fpv' && this.rig) {
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      this.rig.root.updateMatrixWorld(true);
      this.rig.rider.eye.getWorldPosition(p);
      this.rig.rider.head.getWorldQuaternion(q);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
      cam.position.copy(p);
      cam.quaternion.copy(q);
      cam.fov = 82;
      cam.near = 0.03;
      cam.updateProjectionMatrix();
      return;
    }

    const riderTarget = new THREE.Vector3(sample.comX, sample.comY + 0.05, sample.comZ);

    // 2. Ракурс с точки удара (телевизионная камера у препятствия)
    if (mode === 'impact') {
      const imp = this.replay.impactPos;
      const dir = this.replay.impactDir;
      const sideX = -dir.z;
      const sideZ = dir.x;
      const dist = 3.2 * this.tpvZoom;
      const azOff = this.orbitYaw;
      const cx = imp.x + (sideX * Math.cos(azOff) - dir.x * 0.45) * dist;
      const cz = imp.z + (sideZ * Math.cos(azOff) - dir.z * 0.45) * dist;
      const cy = Math.max(imp.y + 0.65 + this.orbitPitch * 1.8, this.terrain.height(cx, cz) + 0.45);
      cam.position.set(cx, cy, cz);
      cam.fov = 54;
      cam.near = 0.05;
      cam.updateProjectionMatrix();
      cam.lookAt(riderTarget);
      return;
    }

    // 3. Крупный план на рэгдолле райдера ('rider') или Кино-орбита ('orbit')
    const isClose = mode === 'rider';
    const baseDist = (isClose ? 2.35 : 3.45) * this.tpvZoom;
    const az =
      sample.vs.psi -
      (isClose ? 0.55 : 0.85) -
      this.replay.orbitAngle * (isClose ? 0.55 : 1.0) +
      this.orbitYaw;
    const pitch = (isClose ? 0.24 : 0.3) + this.orbitPitch;

    const kLerp = 1 - Math.exp(-dt * 14);
    if (this.camTargetSmooth.lengthSq() < 1e-4) {
      this.camTargetSmooth.copy(riderTarget);
    } else {
      this.camTargetSmooth.lerp(riderTarget, kLerp);
    }

    const tgt = this.camTargetSmooth;
    const cx = tgt.x - Math.cos(az) * Math.cos(pitch) * baseDist;
    const cz = tgt.z + Math.sin(az) * Math.cos(pitch) * baseDist;
    const cy = Math.max(tgt.y + Math.sin(pitch) * baseDist, this.terrain.height(cx, cz) + 0.42);

    cam.position.set(cx, cy, cz);
    cam.fov = isClose ? 52 : 58;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    cam.lookAt(tgt);
  }

  /**
   * Кадр в два прохода по глубине. С ближней плоскостью 3–5 см (нужна для вида от первого лица)
   * 24-битного буфера на дальних объектах не хватает: близкие поверхности (стёкла машин, вывески,
   * карнизы) начинают мерцать. Дальний срез [DEPTH_SPLIT, far] и ближний [near, DEPTH_SPLIT]
   * рисуются отдельно, каждый со своей точностью.
   */
  renderFrame() {
    this.renderedMain = true;
    const cam = this.camera;
    const r = this.renderer;
    // вуаль рентгена рисуется в экранных координатах и в двух проходах наложилась бы дважды
    if (cam.near >= DEPTH_SPLIT || this.xray.visible) {
      cam.layers.enable(FAR_LAYER);
      r.render(this.scene, cam);
      return;
    }
    const near = cam.near;
    const far = cam.far;
    cam.near = DEPTH_SPLIT;
    cam.updateProjectionMatrix();
    cam.layers.enable(FAR_LAYER);
    r.render(this.scene, cam);

    // второй проход очищает только глубину: цветной фон сцены вызывает очистку даже при autoClear = false
    const clearColor = r.autoClearColor;
    const shadowUpdate = r.shadowMap.autoUpdate;
    r.autoClearColor = false;
    r.autoClearStencil = false; // номера слоёв земли из дальнего среза нужны ближнему (см. getSurfMat)
    r.shadowMap.autoUpdate = false; // карта теней уже построена первым проходом
    cam.layers.disable(FAR_LAYER);
    cam.near = near;
    cam.far = DEPTH_SPLIT * 1.004; // небольшой нахлёст, чтобы на стыке срезов не было щелей
    cam.updateProjectionMatrix();
    r.render(this.scene, cam);
    r.autoClearColor = clearColor;
    r.autoClearStencil = true;
    cam.layers.enable(FAR_LAYER);
    r.shadowMap.autoUpdate = shadowUpdate;
    cam.far = far;
    cam.updateProjectionMatrix();
  }

  private updateCamera(dt: number, groundRef: number) {
    const sim = this.sim;
    const cam = this.camera;
    const now = performance.now() / 1000;

    if (this.paused) {
      const kLerp = 1 - Math.exp(-dt * 8);
      this.garFocus.lerp(this.garFocusGoal, kLerp);
      this.garZoom += (this.garZoomGoal - this.garZoom) * kLerp;
      if (this.garAzGoal !== null && !this.garDragging) {
        const dAz = wrapPi(this.garAzGoal - this.garAz);
        this.garAz += dAz * kLerp;
        if (Math.abs(dAz) < 0.01) this.garAzGoal = null;
      } else if (!this.garDragging && now - this.lastDrag > 2.5) {
        this.garAz += dt * 0.22;
      }
      if (this.garElGoal !== null && !this.garDragging) {
        this.garEl += (this.garElGoal - this.garEl) * kLerp;
      }

      const cs = Math.cos(sim.psi);
      const sn = Math.sin(sim.psi);
      const wx = sim.px + this.garFocus.x * cs;
      const wz = sim.pz - this.garFocus.x * sn;
      const tgt = new THREE.Vector3(wx, groundRef + this.garFocus.y, wz);
      // райдер в шлеме целиком помещается в видимую часть кадра над/слева от панели
      const baseDist = this.layout === 'bottom' ? 9 : 4.7;
      const dist = baseDist * this.garZoom;
      const az = this.garAz;
      const el = this.garEl;
      cam.position.set(
        tgt.x + Math.cos(az) * Math.cos(el) * dist,
        tgt.y + Math.sin(el) * dist,
        tgt.z + Math.sin(az) * Math.cos(el) * dist,
      );
      cam.fov = 38;
      cam.updateProjectionMatrix();
      cam.lookAt(tgt);
      return;
    }

    if (now - this.lastDrag > 2.2 && this.dragId < 0) {
      const k = 1 - Math.exp(-dt * 2.2);
      this.orbitYaw -= this.orbitYaw * k;
      this.orbitPitch -= this.orbitPitch * k;
    }

    const shakeX = this.camShake > 0.01 ? (Math.random() - 0.5) * 0.09 * this.camShake : 0;
    const shakeY = this.camShake > 0.01 ? (Math.random() - 0.5) * 0.09 * this.camShake : 0;

    // Во время живого полёта рэгдолла камера плавно следит за телом райдера и местом аварии
    if (this.ragdoll.active) {
      const com = this.ragdoll.comPos;
      const blend = clamp(this.crashRealTime * 1.8, 0.55, 0.94);
      const tx = sim.px * (1 - blend) + com.x * blend;
      const ty = (groundRef + 0.85) * (1 - blend) + (com.y + 0.1) * blend;
      const tz = sim.pz * (1 - blend) + com.z * blend;

      const yaw = this.camYaw + this.orbitYaw - clamp(this.crashRealTime * 0.22, 0, 0.65);
      const pitch = 0.31 + this.orbitPitch;
      const dist = (3.35 + Math.min(this.ragdoll.flightDist * 0.12, 1.1)) * this.tpvZoom;
      const cx = tx - Math.cos(yaw) * Math.cos(pitch) * dist;
      const cz = tz + Math.sin(yaw) * Math.cos(pitch) * dist;
      const cy = Math.max(ty + Math.sin(pitch) * dist, this.terrain.height(cx, cz) + 0.45);
      cam.position.set(cx + shakeX, cy + shakeY, cz);
      cam.fov = 62;
      cam.near = 0.05;
      cam.updateProjectionMatrix();
      cam.lookAt(tx, ty, tz);
      return;
    }

    const speed = Math.abs(sim.u);
    if (this.settings.camera === 'fpv' && this.rig) {
      const p = new THREE.Vector3();
      this.rig.root.updateMatrixWorld(true);
      this.rig.rider.eye.getWorldPosition(p);
      // Естественная стабилизация взгляда человека: голова смотрит внутрь поворота и частично компенсирует крен горизонта
      const yaw = sim.psi + sim.delta * 0.42 - sim.leanLat * 0.14 + this.orbitYaw * 0.7;
      const roll = -sim.phi * 0.42 - this.crashVis * sim.crashSide * 0.65;
      const pitch =
        sim.th * 0.72 -
        this.orbitPitch * 0.6 -
        0.18 +
        clamp(sim.azBody * 0.0012, -0.03, 0.03) -
        clamp(sim.axB * 0.004, -0.035, 0.035);
      const e = new THREE.Euler(roll, yaw, pitch, 'YZX');
      const q = new THREE.Quaternion().setFromEuler(e);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
      cam.position.set(p.x + shakeX, p.y + shakeY, p.z);
      cam.quaternion.copy(q);
      cam.fov = 78 + Math.min(speed, 16) * 0.5;
      cam.near = 0.03;
      cam.updateProjectionMatrix();
      return;
    }

    // Третье лицо
    const dYaw = wrapPi(sim.psi - this.camYaw);
    const followRate = 4.2 + Math.min(speed * 0.22, 2.8);
    this.camYaw += dYaw * (1 - Math.exp(-dt * followRate));
    const yaw = this.camYaw + this.orbitYaw;
    const pitch = 0.27 + this.orbitPitch;
    const dist = (3.1 + Math.min(speed, 16) * 0.045) * this.tpvZoom;
    const tgt = new THREE.Vector3(sim.px, groundRef + 0.95 + (sim.yb - groundRef - 0.8) * 0.5, sim.pz);
    const cx = tgt.x - Math.cos(yaw) * Math.cos(pitch) * dist;
    const cz = tgt.z + Math.sin(yaw) * Math.cos(pitch) * dist;
    const cy = Math.max(tgt.y + Math.sin(pitch) * dist, this.terrain.height(cx, cz) + 0.42);
    cam.position.set(cx + shakeX, cy + shakeY, cz);
    cam.fov = 60 + Math.min(speed, 16) * 0.55;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    cam.lookAt(tgt.x + Math.cos(yaw) * 0.8, tgt.y - 0.05, tgt.z - Math.sin(yaw) * 0.8);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const cv = this.renderer.domElement;
    cv.removeEventListener('pointerdown', this.onPointerDown);
    cv.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.audio.dispose();
    this.rig?.dispose();
    this.impactRing.geometry.dispose();
    this.impactRingMat.dispose();
    if (this.impactSparks.length > 0) this.impactSparks[0].mesh.geometry.dispose();
    this.impactSparkMat.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.xray.dispose();
    this.renderer.domElement.remove();
  }
}
