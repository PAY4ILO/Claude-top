/*
 * Мобы и головы Minecraft для студии персонажа: модели — как в самой игре 26.3 (коробки, точки крепления, развёртка
 * текстур взяты из классов моделей client.jar), текстуры — из того же jar (McArt.entityTexture).
 *
 * Запись модели — как в коде игры: y вниз, морда к −z, земля на y = 24.
 *   часть: [имя, родитель | null, точка крепления [x, y, z], поворот [x, y, z] в радианах | 0, коробки, размер?]
 *   коробка: [u, v, x, y, z, w, h, d, раздуть = 0, зеркально = 0, номер текстуры = 0]
 * McMobs.build(def) переводит в систему студии (y вверх, лицо к +z, ноги на y = 0, углы в градусах) — так её рисует Skin3D.
 *
 *   McMobs.TYPES — [{ key, label, group }] мобы для сцены (порядок — как в палитре)
 *   McMobs.mob(key) → { label, tex: [имя текстуры], size: [w, h], parts, scale, pose, poses, bones, slim? } | null
 *   McMobs.HEADS — [{ id, label }] головы (предметы игры: держать, надеть, поставить блоком)
 *   McMobs.head(id) → { label, tex, size, parts, display } | null
 *   McMobs.SKINS — стандартные скины игры ['wide/steve', 'slim/alex', …]
 */
(function () {
  'use strict';

  const PI2 = Math.PI / 2;

  /* ------------------------------------------------------------ части, общие для нескольких моделей */

  const head8 = (hat) => [
    ['head', null, [0, 0, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8]]],
    hat && ['hat', 'head', [0, 0, 0], 0, [[32, 0, -4, -8, -4, 8, 8, 8, hat]]],
  ];

  /** HumanoidModel.createMesh: левые рука и нога — зеркальные правые (старая развёртка 64×32). */
  const humanoid = () => [
    ...head8(0.5),
    ['body', null, [0, 0, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4]]],
    ['right_arm', null, [-5, 2, 0], 0, [[40, 16, -3, -2, -2, 4, 12, 4]]],
    ['left_arm', null, [5, 2, 0], 0, [[40, 16, -1, -2, -2, 4, 12, 4, 0, 1]]],
    ['right_leg', null, [-1.9, 12, 0], 0, [[0, 16, -2, 0, -2, 4, 12, 4]]],
    ['left_leg', null, [1.9, 12, 0], 0, [[0, 16, -2, 0, -2, 4, 12, 4, 0, 1]]],
  ];

  /** PlayerModel.createMesh: свои левые рука и нога, второй слой (рукава, штанины, куртка). */
  const player = (slim) => {
    const aw = slim ? 3 : 4;
    return [
      ...head8(0.5),
      ['body', null, [0, 0, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4], [16, 32, -4, 0, -2, 8, 12, 4, 0.25]]],
      ['right_arm', null, [-5, 2, 0], 0, [[40, 16, -aw + 1, -2, -2, aw, 12, 4], [40, 32, -aw + 1, -2, -2, aw, 12, 4, 0.25]]],
      ['left_arm', null, [5, 2, 0], 0, [[32, 48, -1, -2, -2, aw, 12, 4], [48, 48, -1, -2, -2, aw, 12, 4, 0.25]]],
      ['right_leg', null, [-1.9, 12, 0], 0, [[0, 16, -2, 0, -2, 4, 12, 4], [0, 32, -2, 0, -2, 4, 12, 4, 0.25]]],
      ['left_leg', null, [1.9, 12, 0], 0, [[16, 48, -2, 0, -2, 4, 12, 4], [0, 48, -2, 0, -2, 4, 12, 4, 0.25]]],
    ];
  };

  /** SkeletonModel: тонкие руки и ноги 2×12×2. */
  const skeleton = () => [
    ...head8(0.5),
    ['body', null, [0, 0, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4]]],
    ['right_arm', null, [-5, 2, 0], 0, [[40, 16, -1, -2, -1, 2, 12, 2]]],
    ['left_arm', null, [5, 2, 0], 0, [[40, 16, -1, -2, -1, 2, 12, 2, 0, 1]]],
    ['right_leg', null, [-2, 12, 0], 0, [[0, 16, -1, 0, -1, 2, 12, 2]]],
    ['left_leg', null, [2, 12, 0], 0, [[0, 16, -1, 0, -1, 2, 12, 2, 0, 1]]],
  ];

  /** Голова пиглина: 10×8×8, пятачок, клыки, уши под 30°. */
  const piglinHead = () => [
    ['head', null, [0, 0, 0], 0, [[0, 0, -5, -8, -4, 10, 8, 8], [31, 1, -2, -4, -5, 4, 4, 1], [2, 4, 2, -2, -5, 1, 2, 1], [2, 0, -3, -2, -5, 1, 2, 1]]],
    ['left_ear', 'head', [4.5, -6, 0], [0, 0, -Math.PI / 6], [[51, 6, 0, 0, -2, 1, 5, 4]]],
    ['right_ear', 'head', [-4.5, -6, 0], [0, 0, Math.PI / 6], [[39, 6, -1, 0, -2, 1, 5, 4]]],
  ];

  /** QuadrupedModel: ноги высотой legH; mirrorLeft/mirrorRight — зеркальные ли левые/правые ноги. */
  const legs4 = (legH, uv, box, mirrorLeft, mirrorRight, front = -5, back = 7, side = 3, y = 24 - legH) => [
    ['right_hind_leg', null, [-side, y, back], 0, [[...uv, ...box, 0, mirrorRight ? 1 : 0]]],
    ['left_hind_leg', null, [side, y, back], 0, [[...uv, ...box, 0, mirrorLeft ? 1 : 0]]],
    ['right_front_leg', null, [-side, y, front], 0, [[...uv, ...box, 0, mirrorRight ? 1 : 0]]],
    ['left_front_leg', null, [side, y, front], 0, [[...uv, ...box, 0, mirrorLeft ? 1 : 0]]],
  ];

  /** Житель (VillagerModel.createBodyModel), без полей шляпы. */
  const villager = (withHat = true) => [
    ['head', null, [0, 0, 0], 0, [[0, 0, -4, -10, -4, 8, 10, 8]]],
    withHat && ['hat', 'head', [0, 0, 0], 0, [[32, 0, -4, -10, -4, 8, 10, 8, 0.51]]],
    ['nose', 'head', [0, -2, 0], 0, [[24, 0, -1, -1, -6, 2, 4, 2]]],
    ['body', null, [0, 0, 0], 0, [[16, 20, -4, 0, -3, 8, 12, 6]]],
    ['jacket', 'body', [0, 0, 0], 0, [[0, 38, -4, 0, -3, 8, 20, 6, 0.5]]],
    ['arms', null, [0, 3, -1], [-0.75, 0, 0], [[44, 22, -8, -2, -2, 4, 8, 4], [44, 22, 4, -2, -2, 4, 8, 4, 0, 1], [40, 38, -4, 2, -2, 8, 4, 4]]],
    ['right_leg', null, [-2, 12, 0], 0, [[0, 22, -2, 0, -2, 4, 12, 4]]],
    ['left_leg', null, [2, 12, 0], 0, [[0, 22, -2, 0, -2, 4, 12, 4, 0, 1]]],
  ];

  /* ------------------------------------------------------------ позы */

  // Позы человекоподобных — те же, что у персонажа (Skin3D: углы частей в градусах), плюс «Руки вперёд» (зомби).
  const HUMAN_POSES = ['stand', 'walk', 'wave', 'cheer', 'point', 'sit', 'zombie'];
  const HUMAN_BONES = { head: 'head', body: 'body', rightArm: 'right_arm', leftArm: 'left_arm', rightLeg: 'right_leg', leftLeg: 'left_leg' };
  // Четвероногие: «Идёт» — ноги вперёд-назад (градусы, как у персонажа: x < 0 — вперёд).
  const QUAD_POSES = {
    stand: {},
    walk: { right_hind_leg: [28, 0, 0], left_hind_leg: [-28, 0, 0], right_front_leg: [-28, 0, 0], left_front_leg: [28, 0, 0] },
  };
  const POSE_LABELS = { stand: 'Стоит', walk: 'Идёт', wave: 'Машет', cheer: 'Ура!', point: 'Указывает', sit: 'Сидит', zombie: 'Руки вперёд' };

  /* ------------------------------------------------------------ мобы */

  const HUMAN = { poses: HUMAN_POSES, bones: HUMAN_BONES };
  const QUAD = { poses: Object.keys(QUAD_POSES), quad: QUAD_POSES };
  const STILL = { poses: ['stand'] };

  const MOBS = {
    player: { label: 'Игрок', group: 'players', tex: [], size: [64, 64], parts: player(false), skin: true, ...HUMAN },
    zombie: { label: 'Зомби', group: 'hostile', tex: ['zombie/zombie'], size: [64, 64], parts: humanoid(), pose: 'zombie', ...HUMAN },
    husk: { label: 'Кадавр', group: 'hostile', tex: ['zombie/husk'], size: [64, 64], parts: humanoid(), scale: 1.0625, pose: 'zombie', ...HUMAN },
    drowned: {
      label: 'Утопленник',
      group: 'hostile',
      tex: ['zombie/drowned', 'zombie/drowned_outer_layer'],
      size: [64, 64],
      parts: humanoid().map((p) => (p[0] === 'left_arm' ? ['left_arm', null, [5, 2, 0], 0, [[32, 48, -1, -2, -2, 4, 12, 4]]] : p[0] === 'left_leg' ? ['left_leg', null, [1.9, 12, 0], 0, [[16, 48, -2, 0, -2, 4, 12, 4]]] : p)),
      layers: [{ tex: 1, grow: 0.25 }],
      pose: 'zombie',
      ...HUMAN,
    },
    skeleton: { label: 'Скелет', group: 'hostile', tex: ['skeleton/skeleton'], size: [64, 32], parts: skeleton(), ...HUMAN },
    stray: { label: 'Зимогор', group: 'hostile', tex: ['skeleton/stray', 'skeleton/stray_overlay'], size: [64, 32], parts: skeleton(), layers: [{ tex: 1, grow: 0.25 }], ...HUMAN },
    wither_skeleton: { label: 'Визер-скелет', group: 'hostile', tex: ['skeleton/wither_skeleton'], size: [64, 32], parts: skeleton(), scale: 1.2, ...HUMAN },
    creeper: {
      label: 'Крипер',
      group: 'hostile',
      tex: ['creeper/creeper'],
      size: [64, 32],
      parts: [
        ['head', null, [0, 6, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8]]],
        ['body', null, [0, 6, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4]]],
        ...legs4(6, [0, 16], [-2, 0, -2, 4, 6, 4], false, false, -4, 4, 2),
      ],
      ...QUAD,
    },
    enderman: {
      label: 'Эндермен',
      group: 'hostile',
      tex: ['enderman/enderman'],
      size: [64, 32],
      parts: [
        ['head', null, [0, -13, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8]]],
        ['hat', 'head', [0, 0, 0], 0, [[0, 16, -4, -8, -4, 8, 8, 8, -0.5]]],
        ['body', null, [0, -14, 0], 0, [[32, 16, -4, 0, -2, 8, 12, 4]]],
        ['right_arm', null, [-5, -12, 0], 0, [[56, 0, -1, -2, -1, 2, 30, 2]]],
        ['left_arm', null, [5, -12, 0], 0, [[56, 0, -1, -2, -1, 2, 30, 2, 0, 1]]],
        ['right_leg', null, [-2, -5, 0], 0, [[56, 0, -1, 0, -1, 2, 30, 2]]],
        ['left_leg', null, [2, -5, 0], 0, [[56, 0, -1, 0, -1, 2, 30, 2, 0, 1]]],
      ],
      ...HUMAN,
    },
    spider: {
      label: 'Паук',
      group: 'hostile',
      tex: ['spider/spider'],
      size: [64, 32],
      parts: [
        ['head', null, [0, 15, -3], 0, [[32, 4, -4, -4, -8, 8, 8, 8]]],
        ['body0', null, [0, 15, 0], 0, [[0, 0, -3, -3, -3, 6, 6, 6]]],
        ['body1', null, [0, 15, 9], 0, [[0, 12, -5, -4, -6, 10, 8, 12]]],
        ...[[2, 0.7854, 0.7854], [1, 0.3927, 0.5812], [0, -0.3927, 0.5812], [-1, -0.7854, 0.7854]].flatMap(([z, ry, rz], i) => {
          const name = ['hind', 'middle_hind', 'middle_front', 'front'][i];
          return [
            [`right_${name}_leg`, null, [-4, 15, z], [0, ry, -rz], [[18, 0, -15, -1, -1, 16, 2, 2]]],
            [`left_${name}_leg`, null, [4, 15, z], [0, -ry, rz], [[18, 0, -1, -1, -1, 16, 2, 2, 0, 1]]],
          ];
        }),
      ],
      ...STILL,
    },
    cave_spider: null, // ниже: паук поменьше
    slime: {
      label: 'Слизень',
      group: 'hostile',
      tex: ['slime/slime'],
      size: [64, 32],
      parts: [
        ['cube', null, [0, 0, 0], 0, [[0, 16, -3, 17, -3, 6, 6, 6], [32, 0, -3.25, 18, -3.5, 2, 2, 2], [32, 4, 1.25, 18, -3.5, 2, 2, 2], [32, 8, 0, 21, -3.5, 1, 1, 1]]],
        ['outer', null, [0, 0, 0], 0, [[0, 0, -4, 16, -4, 8, 8, 8]]],
      ],
      scale: 2,
      ...STILL,
    },
    piglin: {
      label: 'Пиглин',
      group: 'hostile',
      tex: ['piglin/piglin'],
      size: [64, 64],
      parts: [...piglinHead(), ...player(false).filter((p) => !['head', 'hat', 'body'].includes(p[0])), ['body', null, [0, 0, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4]]]],
      ...HUMAN,
    },
    zombified_piglin: {
      label: 'Зомбифицированный пиглин',
      group: 'hostile',
      tex: ['piglin/zombified_piglin'],
      size: [64, 64],
      parts: [...piglinHead(), ...player(false).filter((p) => !['head', 'hat', 'body'].includes(p[0])), ['body', null, [0, 0, 0], 0, [[16, 16, -4, 0, -2, 8, 12, 4]]]],
      pose: 'zombie',
      ...HUMAN,
    },
    witch: {
      label: 'Ведьма',
      group: 'hostile',
      tex: ['witch/witch'],
      size: [64, 128],
      parts: [
        ...villager(false).filter((p) => p && p[0] !== 'head' && p[0] !== 'nose'),
        ['head', null, [0, 0, 0], 0, [[0, 0, -4, -10, -4, 8, 10, 8]]],
        ['nose', 'head', [0, -2, 0], 0, [[24, 0, -1, -1, -6, 2, 4, 2]]],
        ['mole', 'nose', [0, -2, 0], 0, [[0, 0, 0, 3, -6.75, 1, 1, 1, -0.25]]],
        ['hat1', 'head', [-5, -10.03125, -5], 0, [[0, 64, 0, 0, 0, 10, 2, 10]]],
        ['hat2', 'hat1', [1.75, -4, 2], [-0.05236, 0, 0.02618], [[0, 76, 0, 0, 0, 7, 4, 7]]],
        ['hat3', 'hat2', [1.75, -4, 2], [-0.10472, 0, 0.05236], [[0, 87, 0, 0, 0, 4, 4, 4]]],
        ['hat4', 'hat3', [1.75, -2, 2], [-0.20944, 0, 0.10472], [[0, 95, 0, 0, 0, 1, 2, 1, 0.25]]],
      ],
      ...STILL,
      poses: ['stand', 'walk'],
      quad: { stand: {}, walk: { right_leg: [-28, 0, 0], left_leg: [28, 0, 0] } },
    },
    villager: {
      label: 'Житель',
      group: 'friendly',
      tex: ['villager/villager', 'villager/type/plains'],
      size: [64, 64],
      parts: villager(),
      layers: [{ tex: 1, grow: 0.01 }],
      poses: ['stand', 'walk'],
      quad: { stand: {}, walk: { right_leg: [-28, 0, 0], left_leg: [28, 0, 0] } },
    },
    iron_golem: {
      label: 'Железный голем',
      group: 'friendly',
      tex: ['iron_golem/iron_golem'],
      size: [128, 128],
      parts: [
        ['head', null, [0, -7, -2], 0, [[0, 0, -4, -12, -5.5, 8, 10, 8], [24, 0, -1, -5, -7.5, 2, 4, 2]]],
        ['body', null, [0, -7, 0], 0, [[0, 40, -9, -2, -6, 18, 12, 11], [0, 70, -4.5, 10, -3, 9, 5, 6, 0.5]]],
        ['right_arm', null, [0, -7, 0], 0, [[60, 21, -13, -2.5, -3, 4, 30, 6]]],
        ['left_arm', null, [0, -7, 0], 0, [[60, 58, 9, -2.5, -3, 4, 30, 6]]],
        ['right_leg', null, [-4, 11, 0], 0, [[37, 0, -3.5, -3, -3, 6, 16, 5]]],
        ['left_leg', null, [5, 11, 0], 0, [[60, 0, -3.5, -3, -3, 6, 16, 5, 0, 1]]],
      ],
      poses: ['stand', 'walk'],
      quad: { stand: {}, walk: { right_leg: [-24, 0, 0], left_leg: [24, 0, 0], right_arm: [24, 0, 0], left_arm: [-24, 0, 0] } },
    },
    snow_golem: {
      label: 'Снежный голем',
      group: 'friendly',
      tex: ['snow_golem/snow_golem'],
      size: [64, 64],
      parts: [
        ['head', null, [0, 4, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8, -0.5]]],
        ['left_arm', null, [5, 6, 1], [0, 0, 1], [[32, 0, -1, 0, -1, 12, 2, 2, -0.5]]],
        ['right_arm', null, [-5, 6, -1], [0, Math.PI, -1], [[32, 0, -1, 0, -1, 12, 2, 2, -0.5]]],
        ['upper_body', null, [0, 13, 0], 0, [[0, 16, -5, -10, -5, 10, 10, 10, -0.5]]],
        ['lower_body', null, [0, 24, 0], 0, [[0, 36, -6, -12, -6, 12, 12, 12, -0.5]]],
      ],
      // Тыква на голове — блок игры (вырезанная тыква), как у SnowGolemHeadLayer: 10 точек, низ чуть ниже шеи.
      blocks: [{ bone: 'head', id: 'carved_pumpkin', at: [0, -5.5, 0], size: 0.625 }],
      ...STILL,
    },
    pig: {
      label: 'Свинья',
      group: 'friendly',
      tex: ['pig/pig_temperate'],
      size: [64, 64],
      parts: [
        ['head', null, [0, 12, -6], 0, [[0, 0, -4, -4, -8, 8, 8, 8], [16, 16, -2, 0, -9, 4, 3, 1]]],
        ['body', null, [0, 11, 2], [PI2, 0, 0], [[28, 8, -5, -10, -7, 10, 16, 8]]],
        ...legs4(6, [0, 16], [-2, 0, -2, 4, 6, 4], true, false),
      ],
      ...QUAD,
    },
    cow: {
      label: 'Корова',
      group: 'friendly',
      tex: ['cow/cow_temperate'],
      size: [64, 64],
      parts: [
        ['head', null, [0, 4, -8], 0, [[0, 0, -4, -4, -6, 8, 8, 6], [1, 33, -3, 1, -7, 6, 3, 1], [22, 0, -5, -5, -5, 1, 3, 1], [22, 0, 4, -5, -5, 1, 3, 1]]],
        ['body', null, [0, 5, 2], [PI2, 0, 0], [[18, 4, -6, -10, -7, 12, 18, 10], [52, 0, -2, 2, -8, 4, 6, 1]]],
        ...legs4(12, [0, 16], [-2, 0, -2, 4, 12, 4], true, false, -5, 7, 4),
      ],
      ...QUAD,
    },
    sheep: {
      label: 'Овца',
      group: 'friendly',
      tex: ['sheep/sheep', 'sheep/sheep_wool'],
      size: [64, 32],
      parts: [
        ['head', null, [0, 6, -8], 0, [[0, 0, -3, -4, -6, 6, 6, 8], [0, 0, -3, -4, -4, 6, 6, 6, 0.6, 0, 1]]],
        ['body', null, [0, 5, 2], [PI2, 0, 0], [[28, 8, -4, -10, -7, 8, 16, 6], [28, 8, -4, -10, -7, 8, 16, 6, 1.75, 0, 1]]],
        ...legs4(12, [0, 16], [-2, 0, -2, 4, 12, 4], false, true).map((p) => [...p.slice(0, 4), [...p[4], [0, 16, -2, 0, -2, 4, 6, 4, 0.5, 0, 1]]]),
      ],
      ...QUAD,
    },
    chicken: {
      label: 'Курица',
      group: 'friendly',
      tex: ['chicken/chicken_temperate'],
      size: [64, 32],
      parts: [
        ['head', null, [0, 15, -4], 0, [[0, 0, -2, -6, -2, 4, 6, 3]]],
        ['beak', 'head', [0, 0, 0], 0, [[14, 0, -2, -4, -4, 4, 2, 2]]],
        ['red_thing', 'head', [0, 0, 0], 0, [[14, 4, -1, -2, -3, 2, 2, 2]]],
        ['body', null, [0, 16, 0], [PI2, 0, 0], [[0, 9, -3, -4, -3, 6, 8, 6]]],
        ['right_leg', null, [-2, 19, 1], 0, [[26, 0, -1, 0, -3, 3, 5, 3]]],
        ['left_leg', null, [1, 19, 1], 0, [[26, 0, -1, 0, -3, 3, 5, 3]]],
        ['right_wing', null, [-4, 13, 0], 0, [[24, 13, 0, 0, -3, 1, 4, 6]]],
        ['left_wing', null, [4, 13, 0], 0, [[24, 13, -1, 0, -3, 1, 4, 6]]],
      ],
      poses: ['stand', 'walk'],
      quad: { stand: {}, walk: { right_leg: [-30, 0, 0], left_leg: [30, 0, 0] } },
    },
    wolf: {
      label: 'Волк',
      group: 'friendly',
      tex: ['wolf/wolf'],
      size: [64, 32],
      parts: [
        ['head', null, [-1, 13.5, -7], 0, []],
        ['real_head', 'head', [0, 0, 0], 0, [[0, 0, -2, -3, -2, 6, 6, 4], [16, 14, -2, -5, 0, 2, 2, 1], [16, 14, 2, -5, 0, 2, 2, 1], [0, 10, -0.5, -0.001, -5, 3, 3, 4]]],
        ['body', null, [0, 14, 2], [PI2, 0, 0], [[18, 14, -3, -2, -3, 6, 9, 6]]],
        ['upper_body', null, [-1, 14, -3], [PI2, 0, 0], [[21, 0, -3, -3, -3, 8, 6, 7]]],
        ['right_hind_leg', null, [-2.5, 16, 7], 0, [[0, 18, 0, 0, -1, 2, 8, 2, 0, 1]]],
        ['left_hind_leg', null, [0.5, 16, 7], 0, [[0, 18, 0, 0, -1, 2, 8, 2]]],
        ['right_front_leg', null, [-2.5, 16, -4], 0, [[0, 18, 0, 0, -1, 2, 8, 2, 0, 1]]],
        ['left_front_leg', null, [0.5, 16, -4], 0, [[0, 18, 0, 0, -1, 2, 8, 2]]],
        ['tail', null, [-1, 12, 8], [0.6283, 0, 0], []],
        ['real_tail', 'tail', [0, 0, 0], 0, [[9, 18, 0, 0, -1, 2, 8, 2]]],
      ],
      ...QUAD,
    },
  };
  MOBS.cave_spider = { ...MOBS.spider, label: 'Пещерный паук', tex: ['spider/cave_spider'], scale: 0.7 };

  const GROUPS = { players: 'Игроки', hostile: 'Враждебные', friendly: 'Мирные' };
  const TYPES = Object.entries(MOBS).map(([key, m]) => ({ key, label: m.label, group: m.group || 'friendly' }));

  /* ------------------------------------------------------------ головы */

  const SKULL = () => [['head', null, [0, 0, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8]]]];
  const SKULL_HAT = () => [['head', null, [0, 0, 0], 0, [[0, 0, -4, -8, -4, 8, 8, 8], [32, 0, -4, -8, -4, 8, 8, 8, 0.25]]]];
  // DragonHeadModel: голова уменьшена до 0,75, челюсть — дочерняя часть.
  const DRAGON = () => [
    ['head', null, [0, -7.9867, 0], 0, [[176, 44, -6, -1, -24, 12, 5, 16], [112, 30, -8, -8, -10, 16, 16, 16], [0, 0, -5, -12, -4, 2, 4, 6, 0, 1], [112, 0, -5, -3, -22, 2, 2, 4, 0, 1], [0, 0, 3, -12, -4, 2, 4, 6], [112, 0, 3, -3, -22, 2, 2, 4]], 0.75],
    ['jaw', 'head', [0, 4, -8], 0, [[176, 65, -6, 0, -16, 12, 4, 16]]],
  ];
  const HEADS = {
    skeleton_skull: { label: 'Череп скелета', tex: ['skeleton/skeleton'], size: [64, 32], parts: SKULL() },
    wither_skeleton_skull: { label: 'Череп визер-скелета', tex: ['skeleton/wither_skeleton'], size: [64, 32], parts: SKULL() },
    zombie_head: { label: 'Голова зомби', tex: ['zombie/zombie'], size: [64, 64], parts: SKULL_HAT() },
    creeper_head: { label: 'Голова крипера', tex: ['creeper/creeper'], size: [64, 32], parts: SKULL() },
    piglin_head: { label: 'Голова пиглина', tex: ['piglin/piglin'], size: [64, 64], parts: piglinHead() },
    dragon_head: { label: 'Голова дракона', tex: ['enderdragon/dragon'], size: [256, 256], parts: DRAGON(), display: 'item/dragon_head' },
    player_head: { label: 'Голова игрока', tex: [], size: [64, 64], parts: SKULL_HAT(), skin: true },
  };

  const SKINS = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'].flatMap((n) => [`wide/${n}`, `slim/${n}`]);
  const SKIN_LABELS = { steve: 'Стив', alex: 'Алекс', ari: 'Ари', efe: 'Эфе', kai: 'Кай', makena: 'Макена', noor: 'Нур', sunny: 'Санни', zuri: 'Зури' };

  /* ------------------------------------------------------------ перевод в систему студии */

  /**
   * Части модели игры → части студии: { name, parent, pivot, rot (градусы, порядок x → y → z), scale, boxes }.
   * Корни — от ног (y = 0 на земле), дочерние — от точки родителя. Коробка: { from, to, uv, size: [w, h, d], mirror, tex }.
   * y и z в игре смотрят в другую сторону, поэтому y → −y, z → −z, а повороты вокруг y и z меняют знак.
   * groundY — где у модели земля (24 у мобов; у голов 0: голова стоит на полу блока).
   */
  function build(parts, groundY = 24) {
    const DEG = 180 / Math.PI;
    return parts.filter(Boolean).map(([name, parent, [px, py, pz], rot, boxes, scale]) => {
      const r = rot || [0, 0, 0];
      return {
        name,
        parent,
        pivot: parent ? [px, -py, -pz] : [px, groundY - py, -pz],
        rot: [r[0] * DEG, -r[1] * DEG, -r[2] * DEG],
        scale: scale || 1,
        boxes: boxes.map(([u, v, x, y, z, w, h, d, g = 0, mirror = 0, tex = 0]) => ({
          from: [x - g, -(y + h + g), -(z + d + g)],
          to: [x + w + g, -(y - g), -(z - g)],
          uv: [u, v],
          size: [w, h, d],
          mirror: !!mirror,
          tex,
        })),
      };
    });
  }

  const built = new Map();
  function mob(key, slim) {
    const m = MOBS[key];
    if (!m) return null;
    const k = key + (slim ? ':slim' : '');
    if (!built.has(k)) {
      const parts = key === 'player' ? player(!!slim) : m.parts;
      built.set(k, { ...m, key, slim: !!slim, scale: m.scale || 1, parts: build(parts), layers: m.layers || [], blocks: m.blocks || [], quad: m.quad || null, bones: m.bones || null });
    }
    return built.get(k);
  }

  const heads = new Map();
  function head(id) {
    const h = HEADS[id];
    if (!h) return null;
    if (!heads.has(id)) heads.set(id, { ...h, id, parts: build(h.parts, 0), display: h.display || 'item/template_skull' });
    return heads.get(id);
  }

  window.McMobs = {
    TYPES,
    GROUPS,
    POSE_LABELS,
    HEADS: Object.entries(HEADS).map(([id, h]) => ({ id, label: h.label })),
    SKINS,
    skinLabel: (s) => {
      const [kind, name] = String(s).split('/');
      return `${SKIN_LABELS[name] || name}${kind === 'slim' ? ' (тонкие руки)' : ''}`;
    },
    isHead: (id) => Object.hasOwn(HEADS, id),
    mob,
    head,
    build,
  };
})();
