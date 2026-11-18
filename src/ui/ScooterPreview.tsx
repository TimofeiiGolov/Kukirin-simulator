import { tr, trf } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MODELS, type Look, type Tune } from '../game/data';
import { PITBIKE } from '../game/pitBikeSpec';
import { buildScooter, type ScooterRig } from '../game/scooterModel';
import type { GarageFocusPart } from './Garage';
import { Icon } from './Icon';

interface PreviewController {
  model: (look: Look, tune: Tune) => void;
  focus: (part: GarageFocusPart) => void;
  reset: () => void;
}

export function ScooterPreview({ look, tune, part, onReset }: { look: Look; tune: Tune; part: GarageFocusPart; onReset: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controller = useRef<PreviewController | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', tr('3D-просмотр самоката. Стрелки — вращение, плюс и минус — масштаб, Home — общий вид.'));
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#292c28');
    scene.add(new THREE.HemisphereLight('#ffffff', '#8c9487', 2.8));
    const light = (color: string, intensity: number, position: number[]) => {
      const source = new THREE.DirectionalLight(color, intensity);
      source.position.set(position[0], position[1], position[2]);
      scene.add(source);
    };
    light('#fff3e2', 3.4, [3, 5, 4]);
    light('#e2ebff', 2.4, [-3, 2, -4]);
    light('#ffffff', 1.6, [-3, 3, 4]);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.4, 80), new THREE.MeshBasicMaterial({ color: '#343832' }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -.012;
    scene.add(floor);
    const stage = new THREE.Group();
    scene.add(stage);
    const camera = new THREE.PerspectiveCamera(38, 1, .01, 50);
    const target = new THREE.Vector3(0, .65, 0);
    let rig: ScooterRig | null = null;
    let centerX = 0;
    let height = 1.4;
    let fitDistance = 3;
    let azimuth = .8;
    let elevation = .22;
    let zoom = 1;
    let currentPart: GarageFocusPart = 'all';
    let frame = 0;
    let disposed = false;
    let pointer: { id: number; x: number; y: number } | null = null;

    const render = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const distance = fitDistance * zoom;
        camera.position.set(target.x + Math.sin(azimuth) * Math.cos(elevation) * distance, target.y + Math.sin(elevation) * distance, target.z + Math.cos(azimuth) * Math.cos(elevation) * distance);
        camera.lookAt(target);
        renderer.render(scene, camera);
      });
    };
    const measure = () => {
      const width = host.clientWidth || 1;
      const viewHeight = host.clientHeight || 1;
      renderer.setSize(width, viewHeight, false);
      camera.aspect = width / viewHeight;
      camera.updateProjectionMatrix();
      // Keep room for the model name and gesture hint above and below the object.
      fitDistance = Math.max(height * 1.3, 1.65 / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.2;
      render();
    };
    const focus = (value: GarageFocusPart) => {
      currentPart = value;
      if (value === 'all') {
        target.set(0, height * .52, 0);
        azimuth = .8; elevation = .22; zoom = 1;
      } else {
        const views = {
          front: { x: .56, y: .24, azimuth: .8, elevation: .13, zoom: .45 },
          rear: { x: -.6, y: .23, azimuth: -.8, elevation: .16, zoom: .45 },
          cockpit: { x: .32, y: height - .12, azimuth: 2.4, elevation: .42, zoom: .35 },
          deck: { x: -.03, y: .2, azimuth: .7, elevation: .62, zoom: .5 },
        };
        const view = views[value];
        target.set(view.x - centerX, view.y, 0);
        azimuth = view.azimuth; elevation = view.elevation; zoom = view.zoom;
      }
      render();
    };
    const disposeRig = () => {
      if (!rig) return;
      // The production rig owns many unique materials, including accessory meshes.
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      rig.root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      stage.remove(rig.root);
      rig.dispose();
      materials.forEach(material => material.dispose());
      textures.forEach(texture => texture.dispose());
      rig = null;
    };
    controller.current = {
      model: (appearance, tuning) => {
        disposeRig();
        rig = buildScooter(appearance, tuning);
        const radius = appearance.wheel * .0254 * .52;
        const pit = MODELS[appearance.model]?.kind === 'pitbike';
        rig.update({ x: 0, z: 0, psi: 0, groundRef: 0, yb: .8, th: 0, phi: 0, delta: 0, ybRest: .8, thRest: 0,
          wf: { x: pit ? PITBIKE.a0 : .56, y: pit ? PITBIKE.rFront : radius, angle: 0, temp: 25 },
          wr: { x: pit ? PITBIKE.a0 - PITBIKE.wheelbase : -.6, y: pit ? PITBIKE.rRear : radius, angle: 0, temp: 25 },
          az: 0, ax: 0, lean: 0, crashE: 0, crashSide: 1, speed: 0, parked: true }, 0);
        // Show only the selected scooter, without the rider obscuring the frame.
        rig.frame.remove(rig.rider.group);
        rig.headlight.intensity = 0;
        const bounds = new THREE.Box3().setFromObject(rig.root);
        centerX = (bounds.min.x + bounds.max.x) / 2;
        height = bounds.max.y - bounds.min.y;
        stage.position.set(-centerX, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
        stage.add(rig.root);
        canvas.dataset.model = appearance.model;
        measure();
        focus(currentPart);
      },
      focus,
      reset: () => focus('all'),
    };
    const down = (event: PointerEvent) => {
      if (pointer || (event.pointerType === 'mouse' && event.button !== 0)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      azimuth -= (event.clientX - pointer.x) * .009;
      elevation = THREE.MathUtils.clamp(elevation + (event.clientY - pointer.y) * .006, -.08, 1.15);
      pointer.x = event.clientX; pointer.y = event.clientY;
      render();
    };
    const end = (event: PointerEvent) => { if (pointer?.id === event.pointerId) pointer = null; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom = THREE.MathUtils.clamp(zoom * Math.exp(event.deltaY * .001), .22, 1.7);
      render();
    };
    const key = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') { focus('all'); return; }
      if (event.key === 'ArrowLeft') azimuth -= .15;
      if (event.key === 'ArrowRight') azimuth += .15;
      if (event.key === 'ArrowUp') elevation = Math.min(1.15, elevation + .1);
      if (event.key === 'ArrowDown') elevation = Math.max(-.08, elevation - .1);
      if (event.key === '+' || event.key === '=') zoom = Math.max(.22, zoom * .9);
      if (event.key === '-') zoom = Math.min(1.7, zoom / .9);
      render();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('keydown', key);
    measure();
    return () => {
      disposed = true;
      controller.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      canvas.removeEventListener('lostpointercapture', end);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('keydown', key);
      disposeRig();
      floor.geometry.dispose();
      floor.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  useEffect(() => { controller.current?.model(look, tune); }, [look, tune]);
  useEffect(() => { controller.current?.focus(part); }, [part, look.model]);

  return <section className="scooter-preview" aria-label={trf('Предпросмотр {model}', { model: MODELS[look.model].name })}>
    <div ref={hostRef} className="scooter-preview-canvas"/>
    {unavailable && <p className="preview-unavailable">{tr('Не удалось открыть 3D-просмотр')}</p>}
    <button className="preview-reset" onClick={() => { controller.current?.reset(); onReset(); }} title={tr('Общий вид')} aria-label={tr('Сбросить ракурс')}><Icon name="reset" size={19}/></button>
  </section>;
}
