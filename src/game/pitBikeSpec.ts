// Заводские данные Kukirin X1 (питбайк). Общие для физики и 3D-модели.
// В игре байк на 10 % крупнее заводского: геометрия ниже уже умножена на SCALE,
// исходные размеры лежат в FACTORY (3D-модель строится в них и масштабируется целиком).
const SCALE = 1.1;

export const FACTORY = {
  wheelbase: 1.095, // м
  rFront: 0.2378, // 60/100-14: (355.6 + 2·60) / 2 мм
  rRear: 0.2324, // 80/100-12: (304.8 + 2·80) / 2 мм
  seatHeight: 0.695, // м
  axleFront: 0.56, // переднее колесо впереди опорной точки рамы
  length: 1.575,
  height: 0.99,
  barWidth: 0.644,
  clearance: 0.207,
} as const;

export const PITBIKE = {
  scale: SCALE,
  wheelbase: FACTORY.wheelbase * SCALE,
  rFront: FACTORY.rFront * SCALE,
  rRear: FACTORY.rRear * SCALE,
  seatHeight: FACTORY.seatHeight * SCALE,
  a0: 0.6 * SCALE, // от центра тяжести до передней оси (развесовка ~45/55)
  mass: 52, // кг
  rake: 0.45, // наклон вилки, рад
  motorTorque: 24, // Н·м на валу мотора
  motorPeakW: 2000, // пиковая мощность, Вт
  motorRpm: 2400, // обороты холостого хода при 48 В
  voltage: 48,
  // цепная передача: 15° подъёма и 50 км/ч одновременно; с колесом растёт и звезда
  gear: 4.0 * SCALE,
  climbDeg: 15,
} as const;
