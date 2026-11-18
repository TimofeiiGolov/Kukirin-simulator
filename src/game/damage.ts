// Модель травм райдера: по ударам, скольжению и перегрузке суставов рэгдолла определяет переломы,
// повреждения связок и мягких тканей. Без three.js — считается и в браузере, и в проверке физики.
import type { HelmetType } from './data';
import { tr, trf } from '../i18n';

export type SiteId =
  | 'skull'
  | 'jaw'
  | 'cervical'
  | 'clavicleL'
  | 'clavicleR'
  | 'ribsL'
  | 'ribsR'
  | 'spine'
  | 'pelvis'
  | 'humerusL'
  | 'humerusR'
  | 'forearmL'
  | 'forearmR'
  | 'wristL'
  | 'wristR'
  | 'femurL'
  | 'femurR'
  | 'kneeL'
  | 'kneeR'
  | 'tibiaL'
  | 'tibiaR'
  | 'ankleL'
  | 'ankleR';

export const SITE_IDS: SiteId[] = [
  'skull',
  'jaw',
  'cervical',
  'clavicleL',
  'clavicleR',
  'ribsL',
  'ribsR',
  'spine',
  'pelvis',
  'humerusL',
  'humerusR',
  'forearmL',
  'forearmR',
  'wristL',
  'wristR',
  'femurL',
  'femurR',
  'kneeL',
  'kneeR',
  'tibiaL',
  'tibiaR',
  'ankleL',
  'ankleR',
];

export type InjuryKind = 'fracture' | 'concussion' | 'ligament' | 'contusion' | 'abrasion';
export type ContactCause = 'ground' | 'wall' | 'car' | 'bench' | 'pole' | 'tree' | 'rock' | 'bounds' | 'handlebar';
type Region = 'head' | 'face' | 'chest' | 'limbs';

interface SiteDef {
  region: Region;
  side: '' | 'L' | 'R';
  /** Эффективная скорость удара, м/с: ушиб, трещина, перелом, перелом со смещением. */
  thr: [number, number, number, number];
  fracture: [string, string, string];
  ais: [number, number, number];
  weeks: [number, number, number];
  /** Часть тела в родительном падеже: «ушиб …», «ссадины …». */
  part: string;
  ligament?: [string, string];
  /** Доля трения, доходящая до кожи сквозь экипировку. */
  cloth: number;
}

const bone = (
  region: Region,
  thr: SiteDef['thr'],
  fracture: SiteDef['fracture'],
  ais: SiteDef['ais'],
  weeks: SiteDef['weeks'],
  part: string,
  cloth: number,
  ligament?: [string, string],
): Omit<SiteDef, 'side'> => ({ region, thr, fracture, ais, weeks, part, cloth, ligament });

const PAIRED = {
  clavicle: bone('limbs', [3.0, 5.0, 6.3, 8.4], ['Трещина ключицы', 'Перелом ключицы', 'Перелом ключицы со смещением'], [1, 2, 2], [3, 6, 10], 'надплечья', 0.35),
  ribs: bone('chest', [3.2, 5.4, 6.8, 8.8], ['Трещина ребра', 'Перелом двух рёбер', 'Множественный перелом рёбер'], [1, 2, 3], [3, 6, 8], 'грудной клетки', 0.35),
  humerus: bone('limbs', [3.2, 5.8, 7.2, 9.2], ['Трещина плечевой кости', 'Перелом плечевой кости', 'Перелом плечевой кости со смещением'], [2, 2, 3], [4, 8, 14], 'плеча', 0.35, ['Растяжение связок плеча', 'Вывих плеча']),
  forearm: bone('limbs', [3.0, 5.2, 6.5, 8.5], ['Трещина лучевой кости', 'Перелом лучевой кости', 'Перелом костей предплечья со смещением'], [1, 2, 3], [3, 6, 10], 'предплечья', 0.35, ['Растяжение связок локтя', 'Вывих локтя']),
  wrist: bone('limbs', [3.0, 5.0, 6.2, 8.0], ['Трещина кости запястья', 'Перелом запястья', 'Перелом запястья со смещением'], [1, 2, 2], [3, 6, 8], 'кисти', 0.25),
  femur: bone('limbs', [3.6, 7.2, 8.8, 10.9], ['Трещина бедренной кости', 'Перелом бедренной кости', 'Перелом бедренной кости со смещением'], [2, 3, 3], [8, 16, 24], 'бедра', 0.5, ['Растяжение связок бедра', 'Вывих бедра']),
  knee: bone('limbs', [3.0, 5.2, 6.5, 8.5], ['Трещина надколенника', 'Перелом надколенника', 'Оскольчатый перелом надколенника'], [1, 2, 2], [4, 6, 10], 'колена', 0.5, ['Растяжение связок колена', 'Разрыв связок колена']),
  tibia: bone('limbs', [3.2, 5.8, 7.2, 9.2], ['Трещина большеберцовой кости', 'Перелом большеберцовой кости', 'Перелом костей голени со смещением'], [2, 2, 3], [6, 12, 20], 'голени', 0.5),
  ankle: bone('limbs', [3.0, 5.0, 6.3, 8.3], ['Трещина лодыжки', 'Перелом лодыжки', 'Перелом лодыжки со смещением'], [1, 2, 2], [4, 6, 10], 'стопы', 0.1, ['Растяжение голеностопа', 'Разрыв связок голеностопа']),
};

const SITES = {
  skull: { ...bone('head', [2.6, 5.6, 7.2, 9.4], ['Трещина костей черепа', 'Перелом костей черепа', 'Вдавленный перелом черепа'], [2, 3, 4], [4, 8, 16], 'головы', 1), side: '' },
  jaw: { ...bone('face', [2.8, 4.8, 6.2, 8.2], ['Трещина нижней челюсти', 'Перелом нижней челюсти', 'Двойной перелом челюсти'], [1, 2, 2], [3, 6, 8], 'лица', 1), side: '' },
  cervical: { ...bone('head', [3.2, 5.8, 7.4, 9.4], ['Трещина шейного позвонка', 'Перелом шейного позвонка', 'Нестабильный перелом шейных позвонков'], [2, 3, 5], [6, 12, 26], 'шеи', 0.6, ['Хлыстовая травма шеи', 'Разрыв связок шеи']), side: '' },
  spine: { ...bone('chest', [3.6, 6.6, 8.2, 10.2], ['Трещина позвонка', 'Компрессионный перелом позвонка', 'Нестабильный перелом позвоночника'], [2, 3, 4], [6, 12, 24], 'спины', 0.35), side: '' },
  pelvis: { ...bone('limbs', [3.6, 6.9, 8.6, 10.9], ['Трещина костей таза', 'Перелом костей таза', 'Нестабильный перелом таза'], [2, 3, 4], [6, 12, 20], 'таза', 0.5), side: '' },
} as Record<string, SiteDef>;
for (const [name, def] of Object.entries(PAIRED)) {
  SITES[`${name}L`] = { ...def, side: 'L' };
  SITES[`${name}R`] = { ...def, side: 'R' };
}

const CONCUSSION_THR = [3.2, 4.8, 6.8];
const CONCUSSION = ['Лёгкое сотрясение мозга', 'Сотрясение мозга', 'Тяжёлая черепно-мозговая травма'];
const CONCUSSION_AIS = [1, 2, 4];
const CONCUSSION_WEEKS = [1, 3, 12];
const LIGAMENT_THR = [5.2, 8.0]; // скорость, погашенная упором сустава, м/с
const ABRASION_THR = [0.12, 0.9]; // путь скольжения кожи с учётом экипировки, м

const CAUSE_TEXT: Record<ContactCause | 'joint' | 'slide', string> = {
  ground: 'удар о покрытие',
  wall: 'удар о стену',
  car: 'удар об автомобиль',
  bench: 'удар о скамью',
  pole: 'удар о столб',
  tree: 'удар о дерево',
  rock: 'удар о камень',
  bounds: 'удар об ограждение',
  handlebar: 'удар о руль',
  joint: 'сустав вывернут за предел',
  slide: 'скольжение по покрытию',
};

// Доля удара по своду черепа и по лицу, доходящая до головы
const HELMET_CROWN: Record<HelmetType, number> = { none: 1, open: 0.52, full: 0.42 };
const HELMET_FACE: Record<HelmetType, number> = { none: 1, open: 0.95, full: 0.5 };
const HELMET_SCRAPE: Record<HelmetType, number> = { none: 1, open: 0.45, full: 0.04 };

export interface Injury {
  id: string;
  site: SiteId;
  kind: InjuryKind;
  grade: number; // 1..3
  label: string;
  cause: string;
  ais: number; // 1..5, сокращённая шкала повреждений
  weeks: number;
  t: number; // секунды после начала аварии
}

export interface SiteState {
  fracture: number; // 0..3
  ligament: number; // 0..2
  soft: number; // 0..2, ушибы и ссадины
  t: number; // момент последнего ухудшения, с
}

export interface DamageReport {
  injuries: Injury[];
  iss: number; // Injury Severity Score, 0..75
  severity: number; // 0..5
  severityLabel: string;
  fractures: number;
  ligaments: number;
  soft: number;
  weeks: number;
  helmetNote: string;
  /** Меняется при каждом изменении состава травм. */
  version: number;
}

export interface DamageConfig {
  helmet: HelmetType;
  riderKg: number;
}

interface LoadEvent {
  t: number;
  site: SiteId;
  load: number;
  raw: number; // тот же удар без шлема
  cause: ContactCause;
  brain: boolean;
}
interface JointEvent {
  t: number;
  site: SiteId;
  speed: number;
}

const SEVERITY = ['Без травм', 'Лёгкие травмы', 'Травмы средней тяжести', 'Серьёзные травмы', 'Тяжёлые травмы', 'Критическое состояние'];

const sideText = (s: SiteDef['side']) => (s === 'L' ? ', слева' : s === 'R' ? ', справа' : '');

// Индексы узлов рэгдолла (см. ragdoll.ts); 100+ — середины костей
const PELVIS = 0;
const CHEST = 1;
const HEAD = 2;
const MID = 100;

export class DamageSystem {
  cfg: DamageConfig = { helmet: 'full', riderKg: 75 };
  active = false;
  private loads: LoadEvent[] = [];
  private joints: JointEvent[] = [];
  private slide = new Map<SiteId, number>();
  private abrasionT = new Map<SiteId, number[]>();
  private strength = new Map<SiteId, number>();
  private massK = 1;
  private version = 0;
  private cacheKey = '';
  private cache: { report: DamageReport; sites: Record<SiteId, SiteState> } | null = null;

  begin(cfg: DamageConfig, seed = 1) {
    this.cfg = cfg;
    this.active = true;
    this.loads = [];
    this.joints = [];
    this.slide.clear();
    this.abrasionT.clear();
    this.cache = null;
    this.cacheKey = '';
    this.massK = Math.pow(Math.max(40, cfg.riderKg) / 75, 0.4);
    // Прочность костей индивидуальна: ±10 %, одинаково для записи и повтора
    let s = (Math.floor(seed * 9973) % 2147483647) + 1;
    for (const id of SITE_IDS) {
      s = (s * 48271) % 2147483647;
      this.strength.set(id, 0.9 + 0.2 * (s / 2147483647));
    }
  }

  clear() {
    this.active = false;
    this.loads = [];
    this.joints = [];
    this.slide.clear();
    this.abrasionT.clear();
    this.cache = null;
    this.cacheKey = '';
    this.version++;
  }

  private push(t: number, site: SiteId, load: number, raw: number, cause: ContactCause, brain = false) {
    if (load < SITES[site].thr[0] * 0.5 && raw < SITES[site].thr[0] * 0.5) return;
    this.loads.push({ t, site, load, raw, cause, brain });
  }

  /**
   * Удар узла тела о поверхность. n — нормаль от поверхности к телу, fr — оси корпуса из рэгдолла
   * (позвоночник, таз вправо, таз вперёд, плечи вправо, плечи вперёд), pos — координаты узлов.
   */
  contact(part: number, vn: number, vt: number, nx: number, ny: number, nz: number, cause: ContactCause, hard: number, t: number, fr: ArrayLike<number>, pos: ArrayLike<number>) {
    if (!this.active || vn < 0.6) return;
    const L = (vn + 0.12 * vt) * hard * this.massK;
    const side = (i: number): 'L' | 'R' => (i % 2 === 1 ? 'L' : 'R');
    const torso = (k: number) => {
      const back = nx * fr[12] + ny * fr[13] + nz * fr[14];
      const lat = nx * fr[9] + ny * fr[10] + nz * fr[11];
      if (back > 0.5) {
        this.push(t, 'spine', L * 0.85 * k, L * 0.85 * k, cause);
        this.push(t, lat > 0 ? 'ribsL' : 'ribsR', L * 0.6 * k, L * 0.6 * k, cause);
      } else {
        // Нормаль смотрит вправо — значит, поверхность слева
        this.push(t, lat > 0 ? 'ribsL' : 'ribsR', L * (Math.abs(lat) > 0.5 ? 1 : 0.9) * k, L * k, cause);
      }
    };
    if (part === PELVIS) {
      const back = nx * fr[6] + ny * fr[7] + nz * fr[8];
      this.push(t, 'pelvis', L * (back > 0.5 ? 0.7 : 1), L, cause);
      if (back > 0.5) this.push(t, 'spine', L * 0.8, L * 0.8, cause);
    } else if (part === CHEST || part === MID + 8) {
      torso(part === CHEST ? 1 : 0.9);
    } else if (part === HEAD) {
      const face = -(nx * fr[12] + ny * fr[13] + nz * fr[14]);
      const h = this.cfg.helmet;
      if (face > 0.45) {
        this.push(t, 'jaw', L * HELMET_FACE[h], L, cause);
        this.push(t, 'skull', L * 0.75 * HELMET_FACE[h], L * 0.75, cause, true);
      } else {
        this.push(t, 'skull', L * HELMET_CROWN[h], L, cause, true);
      }
      // Осевая нагрузка на шею: тело «входит» в голову. Шлем здесь почти не помогает.
      let ux = pos[HEAD * 3] - pos[CHEST * 3];
      let uy = pos[HEAD * 3 + 1] - pos[CHEST * 3 + 1];
      let uz = pos[HEAD * 3 + 2] - pos[CHEST * 3 + 2];
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const axial = Math.max(0, -(nx * ux + ny * uy + nz * uz));
      if (axial > 0.35) this.push(t, 'cervical', L * axial * (h === 'none' ? 1 : 0.92), L * axial, cause);
    } else if (part === 3 || part === 4) {
      this.push(t, 'pelvis', L * 0.85, L * 0.85, cause);
      this.push(t, `femur${side(part)}`, L * 0.6, L * 0.6, cause);
    } else if (part === 5 || part === 6) {
      this.push(t, `clavicle${side(part)}`, L, L, cause);
      this.push(t, `humerus${side(part)}`, L * 0.5, L * 0.5, cause);
    } else if (part === 7 || part === 8) {
      this.push(t, `knee${side(part)}`, L, L, cause);
    } else if (part >= 9 && part <= 12) {
      // Стопа рассчитана на удары о землю, а вот о стену или столб ломается легко
      const k = (cause === 'ground' ? 0.6 : 1) * (part > 10 ? 0.7 : 1);
      this.push(t, `ankle${side(part)}`, L * k, L * k, cause);
    } else if (part === 13 || part === 14) {
      this.push(t, `forearm${side(part)}`, L * 0.8, L * 0.8, cause);
      this.push(t, `humerus${side(part)}`, L * 0.6, L * 0.6, cause);
    } else if (part === 15 || part === 16) {
      // Падение на выставленную руку: запястье и дистальный отдел лучевой кости
      this.push(t, `wrist${side(part)}`, L, L, cause);
      this.push(t, `forearm${side(part)}`, L * 0.55, L * 0.55, cause);
    } else if (part >= MID) {
      const m = part - MID;
      const s = m % 2 === 0 ? 'L' : 'R';
      const name = m < 2 ? 'femur' : m < 4 ? 'tibia' : m < 6 ? 'humerus' : 'forearm';
      this.push(t, `${name}${s}` as SiteId, L, L, cause);
    }
  }

  /** Скольжение узла по покрытию: dist — путь, умноженный на коэффициент трения. */
  scrape(part: number, dist: number, t: number) {
    if (!this.active) return;
    const site = SCRAPE_SITE[part];
    if (!site) return;
    const k = site === 'skull' ? HELMET_SCRAPE[this.cfg.helmet] : SITES[site].cloth;
    const before = this.slide.get(site) ?? 0;
    const after = before + dist * k;
    this.slide.set(site, after);
    for (const thr of ABRASION_THR) {
      if (before < thr && after >= thr) {
        const list = this.abrasionT.get(site) ?? [];
        list.push(t);
        this.abrasionT.set(site, list);
      }
    }
  }

  /** Упор сустава joint (кость joint→tip) погасил скорость speed, м/с. */
  joint(joint: number, tip: number, speed: number, t: number) {
    if (!this.active || speed < LIGAMENT_THR[0] * 0.8) return;
    const s = joint % 2 === 1 ? 'L' : 'R';
    let site: SiteId | null = null;
    // Запас прочности сустава: бедро и голеностоп взмахом собственной конечности почти не повредить
    let tough = 1;
    if (joint === CHEST && tip === HEAD) {
      site = 'cervical';
      tough = 1.1;
    } else if (joint === 3 || joint === 4) {
      site = `femur${s}`;
      tough = 1.7;
    } else if (joint === 5 || joint === 6) site = `humerus${s}`;
    else if (joint === 7 || joint === 8) site = `knee${s}`;
    else if (joint === 9 || joint === 10) {
      site = `ankle${s}`;
      tough = 1.5;
    } else if (joint === 13 || joint === 14) {
      site = `forearm${s}`;
      tough = 1.3;
    }
    if (site) this.joints.push({ t, site, speed: speed / tough });
  }

  /** Травмы, полученные к моменту age секунд после начала аварии. */
  evaluate(age = Infinity): { report: DamageReport; sites: Record<SiteId, SiteState> } {
    let nl = 0;
    while (nl < this.loads.length && this.loads[nl].t <= age) nl++;
    let nj = 0;
    while (nj < this.joints.length && this.joints[nj].t <= age) nj++;
    let na = 0;
    for (const list of this.abrasionT.values()) for (const t of list) if (t <= age) na++;
    const key = `${nl}|${nj}|${na}`;
    if (this.cache && key === this.cacheKey) return this.cache;
    this.cacheKey = key;
    this.version++;

    const sites = {} as Record<SiteId, SiteState>;
    for (const id of SITE_IDS) sites[id] = { fracture: 0, ligament: 0, soft: 0, t: 0 };
    const injuries: Injury[] = [];
    const add = (site: SiteId, kind: InjuryKind, grade: number, label: string, cause: string, ais: number, weeks: number, t: number) => {
      injuries.push({ id: `${site}-${kind}`, site, kind, grade, label: tr(label) + tr(sideText(SITES[site].side)), cause: tr(cause), ais, weeks, t });
      if (t > sites[site].t) sites[site].t = t;
    };

    // Нагрузку на каждую кость накапливаем по времени: повторные удары добавляют до 15 % к пиковому
    const grade = (def: SiteDef, k: number, v: number) => (v >= def.thr[3] * k ? 3 : v >= def.thr[2] * k ? 2 : v >= def.thr[1] * k ? 1 : 0);
    let brainPeak = 0;
    let brainRaw = 0;
    let brainT = 0;
    let brainCause: ContactCause = 'ground';
    let skullRawEff = 0;
    for (const id of SITE_IDS) {
      const def = SITES[id];
      const k = this.strength.get(id) ?? 1;
      let peak = 0;
      let sum = 0;
      let rawPeak = 0;
      let rawSum = 0;
      let g = 0;
      let bruise = 0;
      let tG = 0;
      let tB = 0;
      let cause: ContactCause = 'ground';
      let causeB: ContactCause = 'ground';
      for (let i = 0; i < nl; i++) {
        const e = this.loads[i];
        if (e.site !== id) continue;
        if (e.load > peak) peak = e.load;
        sum += e.load;
        if (e.raw > rawPeak) rawPeak = e.raw;
        rawSum += e.raw;
        const eff = peak + Math.min(0.15 * peak, 0.1 * (sum - peak));
        const ng = grade(def, k, eff);
        if (ng > g) {
          g = ng;
          tG = e.t;
          cause = e.cause;
        }
        const nb = eff >= (def.thr[0] + def.thr[1]) * 0.5 * k ? 2 : eff >= def.thr[0] * k ? 1 : 0;
        if (nb > bruise) {
          bruise = nb;
          tB = e.t;
          causeB = e.cause;
        }
        if (e.brain) {
          if (e.load > brainPeak) {
            if (concussionGrade(e.load) > concussionGrade(brainPeak)) {
              brainT = e.t;
              brainCause = e.cause;
            }
            brainPeak = e.load;
          }
          if (e.raw > brainRaw) brainRaw = e.raw;
        }
      }
      if (id === 'skull') skullRawEff = rawPeak + Math.min(0.15 * rawPeak, 0.1 * (rawSum - rawPeak));
      sites[id].fracture = g;
      if (g > 0) add(id, 'fracture', g, def.fracture[g - 1], CAUSE_TEXT[cause], def.ais[g - 1], def.weeks[g - 1], tG);
      else if (bruise > 0) {
        sites[id].soft = bruise;
        add(id, 'contusion', bruise, trf(bruise > 1 ? 'Сильный ушиб, гематома {part}' : 'Ушиб {part}', { part: tr(def.part) }), CAUSE_TEXT[causeB], 1, bruise, tB);
      }

      // Связки
      let lg = 0;
      let tL = 0;
      for (let i = 0; i < nj; i++) {
        const e = this.joints[i];
        if (e.site !== id) continue;
        const ng = e.speed >= LIGAMENT_THR[1] * k ? 2 : e.speed >= LIGAMENT_THR[0] * k ? 1 : 0;
        if (ng > lg) {
          lg = ng;
          tL = e.t;
        }
      }
      if (lg > 0 && def.ligament) {
        sites[id].ligament = lg;
        add(id, 'ligament', lg, def.ligament[lg - 1], CAUSE_TEXT.joint, lg, lg > 1 ? 8 : 2, tL);
      }

      // Ссадины
      const list = this.abrasionT.get(id);
      if (list) {
        let ag = 0;
        let tA = 0;
        for (const t of list) {
          if (t <= age) {
            ag++;
            tA = t;
          }
        }
        if (ag > 0) {
          sites[id].soft = Math.max(sites[id].soft, ag);
          add(id, 'abrasion', ag, trf(ag > 1 ? 'Глубокие ссадины {part}' : 'Ссадины {part}', { part: tr(def.part) }), CAUSE_TEXT.slide, 1, ag > 1 ? 3 : 1, tA);
        }
      }
    }

    const cg = concussionGrade(brainPeak);
    if (cg > 0) add('skull', 'concussion', cg, CONCUSSION[cg - 1], CAUSE_TEXT[brainCause], CONCUSSION_AIS[cg - 1], CONCUSSION_WEEKS[cg - 1], brainT);

    injuries.sort((a, b) => b.ais - a.ais || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.t - b.t);

    // ISS: сумма квадратов максимальных AIS трёх наиболее пострадавших областей тела
    const regionMax: Record<string, number> = {};
    for (const inj of injuries) {
      const region = inj.kind === 'abrasion' || inj.kind === 'contusion' ? 'external' : SITES[inj.site].region;
      regionMax[region] = Math.max(regionMax[region] ?? 0, inj.ais);
    }
    const top = Object.values(regionMax).sort((a, b) => b - a).slice(0, 3);
    const iss = top.reduce((s, a) => s + a * a, 0);
    const severity = iss === 0 ? 0 : iss <= 3 ? 1 : iss <= 8 ? 2 : iss <= 15 ? 3 : iss <= 24 ? 4 : 5;
    const weeksSorted = injuries.map((i) => i.weeks).sort((a, b) => b - a);
    const weeks = weeksSorted.length ? Math.round(weeksSorted[0] + 0.12 * weeksSorted.slice(1).reduce((s, w) => s + w, 0)) : 0;

    // Что изменил шлем
    let helmetNote = '';
    const h = this.cfg.helmet;
    if (brainRaw > 1.5) {
      const kS = this.strength.get('skull') ?? 1;
      if (h === 'none') {
        helmetNote = cg > 0 || sites.skull.fracture > 0 ? tr('Без шлема: голова приняла удар целиком') : '';
      } else {
        const bareFracture = grade(SITES.skull, kS, skullRawEff);
        const bareBrain = concussionGrade(brainRaw);
        const saved = bareFracture > sites.skull.fracture ? SITES.skull.fracture[bareFracture - 1] : bareBrain > cg ? CONCUSSION[bareBrain - 1] : '';
        const absorbed = Math.round((1 - brainPeak / brainRaw) * 100);
        helmetNote = saved ? trf('Шлем спас: без него — {injury}', { injury: tr(saved).toLowerCase() }) : trf('Шлем поглотил {n}% удара по голове', { n: absorbed });
      }
    }

    const report: DamageReport = {
      injuries,
      iss,
      severity,
      severityLabel: SEVERITY[severity],
      fractures: injuries.filter((i) => i.kind === 'fracture').length,
      ligaments: injuries.filter((i) => i.kind === 'ligament').length,
      soft: injuries.filter((i) => i.kind === 'contusion' || i.kind === 'abrasion' || i.kind === 'concussion').length,
      weeks,
      helmetNote,
      version: this.version,
    };
    this.cache = { report, sites };
    return this.cache;
  }
}

const KIND_ORDER: Record<InjuryKind, number> = { fracture: 0, concussion: 1, ligament: 2, contusion: 3, abrasion: 4 };

function concussionGrade(load: number) {
  return load >= CONCUSSION_THR[2] ? 3 : load >= CONCUSSION_THR[1] ? 2 : load >= CONCUSSION_THR[0] ? 1 : 0;
}

// Какая область кожи стирается при скольжении узла
const SCRAPE_SITE: (SiteId | null)[] = [
  'pelvis',
  'ribsR',
  'skull',
  'pelvis',
  'pelvis',
  'clavicleL',
  'clavicleR',
  'kneeL',
  'kneeR',
  'ankleL',
  'ankleR',
  null,
  null,
  'forearmL',
  'forearmR',
  'wristL',
  'wristR',
];
