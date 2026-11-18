# Kukirin Sim — новый интерфейс

Интерфейс переработан по приложенному референсу: крупная тонкая скорость, одна строка телеметрии, контурные иконки, прозрачный джойстик и круглые педали с оранжевым газом. Гараж, настройки, стант, падение и повтор оформлены в одном сдержанном стиле. Шрифт встроен в сборку и работает без интернета.

В разделе «Самокат» есть отдельный 3D-предпросмотр без райдера. Он обновляется при выборе модели и изменении цвета, колёс или обвеса. Потяните по модели для вращения; колесо мыши приближает и отдаляет. Кнопки «Вилка», «Маятник», «Руль» и «Дека» показывают детали, круглая кнопка сбрасывает ракурс. Когда просмотр в фокусе, доступны стрелки, +/− и Home. На телефоне модель находится над настройками, в альбомной ориентации — слева от них.

Во вкладки, заголовки групп, характеристики и основные переключатели добавлены контурные иконки с текстовыми подписями.

## Запуск

Готовая игра — `dist/index.html`. Откройте этот файл в современном браузере с WebGL 2. Можно перенести один этот HTML-файл: код, стили и шрифты уже внутри.

Для разработки:

```sh
npm ci
npm run dev
```

Проверка и сборка:

```sh
npm run check
npm run check:physics
npm run build
```

## Управление

- Телефон: слева руль и перенос веса, справа газ и тормоз. Держите газ и потяните джойстик вниз для станта. При отпускании или отмене касания ввод сбрасывается.
- Клавиатура: W / стрелка вверх — газ; S / пробел — тормоз; A / D — руль; Q / E — вес назад / вперёд; Shift / F — стант; Z / X — отдельные передний / задний тормоза.
- C — камера; M — режим; N — карта; G / Esc — гараж; R — поднять самокат; P — повтор; V — ракурс повтора.
- Под скоростью можно переключить режим или раскрыть «Данные». Расширенная телеметрия включает подвеску, температуру тормозов, ABS/TCS, перегрузки и рекорды.
- Кнопка повтора становится доступной после первого падения. В повторе работают пауза, перемотка, замедление, ракурс и возвращение к езде.

При первом запуске включены камера от первого лица и экранные педали. Всё это меняется в разделе «Игра». Настройки сохраняются в браузере. Чтобы применить новые штатные размеры колёс к старому сохранению G2 Pro или G4 Max, заново выберите эту модель в гараже.

Скорости всех моделей и передач исправлены, для G3 Pro включён полный привод. Источники, особенности ревизий и результаты проверки — в `SPECS_RU.md`.

## Физика самоката, рэгдолл и исправления

- **Реалистичная физика управления самокатом:** добавлена динамика крена 2-го порядка с инерцией и гироскопическим моментом вращающихся колёс, инерция рулевой колонки с эффектом контрруления и возвращающим моментом кастора, длина релаксации шин и боковая сила от наклона колеса (camber thrust), управляемый задний занос при контррулении, прогрессивные гидравлические отбойники подвески и 3D-перенос веса райдера в вираже.
- **Реалистичный рэгдолл человека:** задано антропометрическое распределение масс сегментов тела (тяжёлый таз, грудная клетка и бёдра относительно кистей и стоп), убран нереалистичный вертикальный подброс при столкновениях в пользу сохранения импульса и момента инерции при перевороте через руль, добавлено вязкоупругое демпфирование суставов и рефлекторный мышечный тонус, анатомические шарниры коленей, локтей и шеи, самоколлизии конечностей с корпусом, коллизия с рамой самоката и неупругий перекат по покрытию с трением скольжения.
- **Исправленные баги:** исправлен выход из режима повтора по кнопке «Выход» и клавише `P`, сброс зажатых клавиш при потере фокуса окна, сохранение записи аварии при быстром восстановлении (`R`), инициализация `hPrev` в `recover()`, коллизия обоих колёс с бортами и торцами трамплинов, а также сохранение скоростей Верле после разрешения контакта рэгдолла с землёй.

### Model and handling update

- Scooter models are rebuilt from lathed and extruded parts (real tyre profile, hub motors, drilled brake discs, cast swingarms, coil-over shocks, rounded deck and gooseneck) with studio reflections; static parts are merged per material to keep draw calls low.
- Handling is lean-first: above walking pace the rider commands a lean angle limited by perceived grip and the steering angle follows the actual lean. Wheel inertia, centre-of-gravity height (per model and rider weight), tyre load sensitivity and rider bracing under braking are modelled; ground slope no longer acts on an airborne scooter.

### Rider and ragdoll update

- The rider is rebuilt from lofted surfaces: shaped torso with jacket hem, collar and zip, tapered limbs, sculpted head, gloves and sneakers. The full-face helmet has a real shell with chin bar, tinted visor, vents and neck roll; the open helmet has vents, a brim and straps.
- Ragdoll joints now have anatomical limits (hinged knees and elbows, hip and shoulder cones, ankle, neck and spine twist) applied as torque-free corrections, so limits stop a limb without spinning or pushing the body.
- Limb segments collide with each other, with obstacles between joints, and with the scooter deck and stem. `npm run check:physics` asserts the joint limits in five crash types.

### Damage system and X-ray replay

- `src/game/damage.ts` turns ragdoll events into injuries: impacts (speed, surface hardness, rider weight, helmet), skin sliding on the surface, and joints forced past their limits. It tracks 23 body sites with four fracture thresholds each, ligament injuries, contusions, abrasions and concussion, and scores the result with AIS per injury and ISS overall, plus an estimated recovery time and what the helmet changed.
- `src/game/xray.ts` renders the crash replay as an X-ray from the moment of impact: a translucent body, a full skeleton, cracked bones in amber, broken bones in red with displaced fragments, glowing markers and callout labels. Injuries appear at the moment they happen and follow the replay scrubber.
- The HUD shows a damage panel during the replay. Toggle the feature in Settings → Gameplay → "Рентген повреждений", with the replay button, or with X during a replay.
- The automatic replay now waits until the body has come to rest (at most 3.3 s of crash time).
