/**
 * 五子奇境 · 每个模式的场景与材质主题
 *
 * 定位：**纯数据表**（外加两个查询函数），不含任何绘制代码。
 * 载入顺序在 render/art.js 之后、render/scene.js 与 render/board.js 之前。
 *
 * 为什么要有这张表：场景（洞穴/山谷/矿洞/星空）与棋盘石板的材质原本是写死的常量，
 * 于是「雪山洞穴」的洞穴场景被四个模式共用。现在一个模式一套：
 *
 *   classic → kind 'field'  星空冰原：夜空 + 星点 + 远处雪脊，石板是中性冰面
 *   snow    → kind 'cave'   雪山洞穴：洞穴岩壁 + 冰柱 + 飘雪，石板是冰川
 *   river   → kind 'valley' 山谷溪流：崖壁 + 雾气 + 雨，石板是湿石
 *   mine    → kind 'mine'   危险雷区：暖色矿洞 + 矿脉火光 + 尘埃，石板是砂岩
 *
 * 字段约定：
 *   scene   —— 背景与岩壁的配色；weather 决定粒子（snow / dust / mist）
 *   slab    —— 石板材质（上下两色必须给出 RGB 三元组，供河流淡出等复用）
 *   ambient —— 最上层那层环境色偏
 *   stone   —— 黑棋下缘反光与顶部反光弧的颜色（让棋子跟着场景走）
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});

  /** 冰系共用的岩壁渐变停靠点（洞穴与星空冰原都用它）。 */
  var ICE_STOPS = {
    top: [
      [0, 'rgba(214, 240, 255, 0.42)'],
      [0.18, 'rgba(152, 206, 246, 0.22)'],
      [0.6, 'rgba(110, 170, 215, 0.06)'],
      [1, 'rgba(110, 170, 215, 0)']
    ],
    bottom: [
      [0, 'rgba(178, 220, 255, 0.34)'],
      [0.35, 'rgba(132, 192, 240, 0.13)'],
      [1, 'rgba(112, 172, 222, 0)']
    ],
    side: [
      [0, 'rgba(190, 228, 255, 0.2)'],
      [0.5, 'rgba(140, 195, 238, 0.08)'],
      [1, 'rgba(120, 180, 220, 0)']
    ],
    corner: [
      [0, 'rgba(206, 238, 255, 0.3)'],
      [1, 'rgba(150, 200, 240, 0)']
    ]
  };

  /** 矿洞共用的岩壁渐变停靠点。 */
  var ROCK_STOPS = {
    top: [
      [0, 'rgba(150, 104, 68, 0.4)'],
      [0.22, 'rgba(104, 70, 46, 0.24)'],
      [0.65, 'rgba(70, 46, 30, 0.07)'],
      [1, 'rgba(70, 46, 30, 0)']
    ],
    bottom: [
      [0, 'rgba(158, 112, 72, 0.32)'],
      [0.38, 'rgba(110, 76, 48, 0.14)'],
      [1, 'rgba(80, 54, 34, 0)']
    ],
    side: [
      [0, 'rgba(160, 116, 78, 0.22)'],
      [0.5, 'rgba(112, 78, 52, 0.09)'],
      [1, 'rgba(84, 58, 36, 0)']
    ],
    corner: [
      [0, 'rgba(196, 140, 90, 0.28)'],
      [1, 'rgba(120, 82, 54, 0)']
    ]
  };

  /** 山谷共用的岩壁渐变停靠点。 */
  var VALLEY_STOPS = {
    top: [
      [0, 'rgba(150, 200, 215, 0.3)'],
      [0.24, 'rgba(96, 146, 164, 0.18)'],
      [0.7, 'rgba(58, 96, 112, 0.05)'],
      [1, 'rgba(58, 96, 112, 0)']
    ],
    bottom: [
      [0, 'rgba(176, 214, 208, 0.3)'],
      [0.4, 'rgba(120, 164, 154, 0.13)'],
      [1, 'rgba(80, 120, 112, 0)']
    ],
    side: [
      [0, 'rgba(164, 206, 210, 0.2)'],
      [0.5, 'rgba(104, 148, 150, 0.08)'],
      [1, 'rgba(70, 108, 116, 0)']
    ],
    corner: [
      [0, 'rgba(186, 224, 220, 0.26)'],
      [1, 'rgba(110, 156, 152, 0)']
    ]
  };

  var THEMES = {
    // ── 经典五子棋：星空冰原 ─────────────────────────────────────────────
    classic: {
      id: 'classic',
      kind: 'field',
      label: '星空冰原',

      scene: {
        skyTop: '#0c1626',
        skyBottom: '#03060d',
        glow: 'rgba(112, 172, 226, 0.20)',
        glowFade: 'rgba(112, 172, 226, 0)',
        ridgeFar: 'rgba(126, 170, 212, 0.16)',
        ridgeNear: 'rgba(168, 206, 238, 0.22)',
        ridgeCap: 'rgba(226, 244, 255, 0.5)',
        wallTint: 'rgba(178, 216, 248, 0.2)',
        wallEdge: 'rgba(220, 240, 255, 0.4)',
        vignette: 'rgba(2, 6, 14, 0.52)',
        floor: 'rgba(196, 228, 255, 0.14)',
        floorEdge: 'rgba(226, 244, 255, 0.3)',
        star: 'rgba(228, 242, 255, 0.95)',
        starWarm: 'rgba(198, 222, 255, 0.75)',
        stars: 120,
        weather: 'snow',
        weatherDensity: 0.5,
        weatherColor: 'rgba(236, 248, 255, 0.85)',
        shaft: [160, 214, 255],
        shaftAlpha: 0.05,
        edge: 'frost',
        edgeColor: 'rgba(226, 244, 255, 0.9)',
        edgeAlpha: 0.5,
        stops: ICE_STOPS
      },

      slab: {
        top: '#f6fbfe',
        topRgb: [246, 251, 254],
        mid: '#e6f0f8',
        bottom: '#c8dcec',
        bottomRgb: [200, 220, 236],
        rimLight: 'rgba(236, 250, 255, 0.95)',
        rimMid: 'rgba(172, 214, 240, 0.85)',
        rimDark: 'rgba(108, 160, 202, 0.85)',
        bevelLight: 'rgba(255, 255, 255, 0.9)',
        bevelMid: 'rgba(202, 232, 250, 0.3)',
        bevelDark: 'rgba(100, 150, 190, 0.52)',
        shine: 'rgba(255, 255, 255, 0.5)',
        shade: 'rgba(88, 142, 184, 0.2)',
        inner: 'rgba(52, 100, 140, 0.2)',
        strata: 0.45,
        frost: 0.3,
        speckle: 0.55,
        speckLight: 'rgba(255, 255, 255, 0.5)',
        speckDark: 'rgba(120, 168, 204, 0.35)',
        grid: 'rgba(28, 64, 94, 0.34)',
        gridHi: 'rgba(255, 255, 255, 0.48)',
        gridEdge: 'rgba(24, 56, 84, 0.5)',
        point: 'rgba(30, 70, 102, 0.62)',
        pointSpark: 'rgba(255, 255, 255, 0.85)'
      },

      ambient: 'rgba(150, 210, 255, 0.03)',
      ambientUrgent: null,
      stone: {
        rim: 'rgba(122, 198, 240, 0.5)',
        whiteRim: 'rgba(146, 186, 216, 0.42)',
        arc: 'rgba(196, 232, 255, 0.5)'
      }
    },

    // ── 雪山洞穴：冰洞 ──────────────────────────────────────────────────
    snow: {
      id: 'snow',
      kind: 'cave',
      label: '雪山洞穴',

      scene: {
        skyTop: '#07101c',
        skyBottom: '#03060c',
        glow: 'rgba(96, 180, 230, 0.20)',
        glowFade: 'rgba(96, 180, 230, 0)',
        ceiling: 'rgba(190, 228, 255, 0.14)',
        floorSnow: 'rgba(226, 246, 255, 0.16)',
        iceEdge: 'rgba(226, 244, 255, 0.45)',
        drift: 'rgba(226, 246, 255, 0.5)',
        wallTint: 'rgba(150, 205, 245, 0.3)',
        vignette: 'rgba(2, 6, 12, 0.5)',
        weather: 'snow',
        weatherDensity: 0.9,
        weatherColor: 'rgba(236, 248, 255, 0.85)',
        shaft: [150, 210, 255],
        shaftAlpha: 0.055,
        edge: 'frost',
        edgeColor: 'rgba(226, 244, 255, 0.9)',
        edgeAlpha: 0.55,
        stops: ICE_STOPS
      },

      slab: {
        top: '#f1f9fe',
        topRgb: [241, 249, 254],
        mid: '#dcebf7',
        bottom: '#b7d6ec',
        bottomRgb: [183, 214, 236],
        rimLight: 'rgba(232, 248, 255, 0.95)',
        rimMid: 'rgba(168, 212, 240, 0.85)',
        rimDark: 'rgba(104, 158, 202, 0.85)',
        bevelLight: 'rgba(255, 255, 255, 0.9)',
        bevelMid: 'rgba(200, 230, 250, 0.32)',
        bevelDark: 'rgba(96, 146, 186, 0.55)',
        shine: 'rgba(255, 255, 255, 0.5)',
        shade: 'rgba(86, 140, 182, 0.22)',
        inner: 'rgba(52, 100, 140, 0.22)',
        strata: 0.6,
        frost: 0.55,
        speckle: 0.6,
        speckLight: 'rgba(255, 255, 255, 0.5)',
        speckDark: 'rgba(110, 158, 196, 0.35)',
        grid: 'rgba(30, 68, 98, 0.4)',
        gridHi: 'rgba(255, 255, 255, 0.5)',
        gridEdge: 'rgba(24, 56, 84, 0.55)',
        point: 'rgba(32, 74, 106, 0.68)',
        pointSpark: 'rgba(255, 255, 255, 0.85)'
      },

      ambient: 'rgba(120, 200, 255, 0.05)',
      ambientUrgent: null,
      stone: {
        rim: 'rgba(122, 198, 240, 0.5)',
        whiteRim: 'rgba(146, 186, 216, 0.42)',
        arc: 'rgba(196, 232, 255, 0.5)'
      }
    },

    // ── 山谷溪流：湿石河滩 ──────────────────────────────────────────────
    river: {
      id: 'river',
      kind: 'valley',
      label: '山谷溪流',

      scene: {
        skyTop: '#162a34',
        skyBottom: '#070f16',
        glow: 'rgba(92, 188, 216, 0.18)',
        glowFade: 'rgba(92, 188, 216, 0)',
        cliffFar: 'rgba(66, 100, 112, 0.55)',
        cliffMid: 'rgba(48, 78, 90, 0.68)',
        cliffNear: 'rgba(30, 54, 66, 0.82)',
        cliffEdge: 'rgba(158, 208, 220, 0.3)',
        cliffCap: 'rgba(190, 226, 226, 0.35)',
        bank: 'rgba(140, 178, 170, 0.22)',
        gravel: 'rgba(176, 200, 192, 0.3)',
        mist: 'rgba(196, 232, 238, 0.13)',
        wallTint: 'rgba(160, 205, 205, 0.26)',
        vignette: 'rgba(2, 8, 10, 0.5)',
        weather: 'mist',
        weatherDensity: 0.7,
        weatherColor: 'rgba(206, 238, 242, 0.5)',
        shaft: [180, 230, 240],
        shaftAlpha: 0.035,
        edge: 'mist',
        edgeColor: 'rgba(200, 234, 238, 0.85)',
        edgeAlpha: 0.4,
        stops: VALLEY_STOPS
      },

      slab: {
        top: '#eef4f0',
        topRgb: [238, 244, 240],
        mid: '#dde8e1',
        bottom: '#c0d2c9',
        bottomRgb: [192, 210, 201],
        rimLight: 'rgba(232, 246, 240, 0.92)',
        rimMid: 'rgba(158, 196, 186, 0.85)',
        rimDark: 'rgba(94, 138, 128, 0.85)',
        bevelLight: 'rgba(255, 255, 255, 0.85)',
        bevelMid: 'rgba(196, 224, 214, 0.3)',
        bevelDark: 'rgba(92, 132, 122, 0.5)',
        shine: 'rgba(255, 255, 255, 0.42)',
        shade: 'rgba(78, 122, 112, 0.2)',
        inner: 'rgba(48, 90, 80, 0.2)',
        strata: 0.3,
        frost: 0.12,
        speckle: 0.85,
        speckLight: 'rgba(255, 255, 255, 0.45)',
        speckDark: 'rgba(96, 132, 122, 0.4)',
        grid: 'rgba(38, 72, 64, 0.42)',
        gridHi: 'rgba(255, 255, 255, 0.45)',
        gridEdge: 'rgba(32, 62, 54, 0.58)',
        point: 'rgba(44, 82, 72, 0.6)',
        pointSpark: 'rgba(255, 255, 255, 0.8)'
      },

      ambient: 'rgba(88, 196, 226, 0.05)',
      ambientUrgent: null,
      stone: {
        rim: 'rgba(150, 214, 196, 0.42)',
        whiteRim: 'rgba(150, 196, 180, 0.38)',
        arc: 'rgba(226, 250, 244, 0.5)'
      }
    },

    // ── 危险雷区：暖色矿洞 ──────────────────────────────────────────────
    mine: {
      id: 'mine',
      kind: 'mine',
      label: '危险雷区',

      scene: {
        skyTop: '#1c1109',
        skyBottom: '#080505',
        glow: 'rgba(236, 148, 78, 0.16)',
        glowFade: 'rgba(236, 148, 78, 0)',
        rockFar: 'rgba(96, 66, 46, 0.6)',
        rockMid: 'rgba(66, 44, 32, 0.72)',
        rockNear: 'rgba(40, 26, 20, 0.85)',
        rockEdge: 'rgba(206, 148, 96, 0.3)',
        vein: 'rgba(255, 152, 76, 0.5)',
        veinHot: 'rgba(255, 206, 130, 0.85)',
        rubble: 'rgba(122, 92, 68, 0.4)',
        lamp: 'rgba(255, 186, 108, 0.85)',
        wallTint: 'rgba(200, 140, 90, 0.26)',
        vignette: 'rgba(10, 4, 2, 0.52)',
        weather: 'dust',
        weatherDensity: 0.75,
        weatherColor: 'rgba(255, 206, 150, 0.65)',
        shaft: [255, 190, 130],
        shaftAlpha: 0.04,
        edge: 'dust',
        edgeColor: 'rgba(255, 196, 138, 0.8)',
        edgeAlpha: 0.45,
        stops: ROCK_STOPS
      },

      slab: {
        top: '#f1e9da',
        topRgb: [241, 233, 218],
        mid: '#e2d6be',
        bottom: '#c3ab8c',
        bottomRgb: [195, 171, 140],
        rimLight: 'rgba(255, 242, 220, 0.9)',
        rimMid: 'rgba(206, 168, 122, 0.85)',
        rimDark: 'rgba(140, 104, 68, 0.85)',
        bevelLight: 'rgba(255, 250, 236, 0.85)',
        bevelMid: 'rgba(226, 202, 166, 0.32)',
        bevelDark: 'rgba(148, 110, 72, 0.5)',
        shine: 'rgba(255, 248, 232, 0.4)',
        shade: 'rgba(140, 106, 66, 0.22)',
        inner: 'rgba(104, 76, 44, 0.22)',
        strata: 0.5,
        frost: 0,
        speckle: 0.9,
        speckLight: 'rgba(255, 250, 236, 0.5)',
        speckDark: 'rgba(148, 112, 70, 0.4)',
        grid: 'rgba(92, 66, 42, 0.44)',
        gridHi: 'rgba(255, 250, 236, 0.5)',
        gridEdge: 'rgba(80, 56, 34, 0.6)',
        point: 'rgba(104, 78, 48, 0.62)',
        pointSpark: 'rgba(255, 250, 238, 0.85)'
      },

      ambient: 'rgba(255, 118, 84, 0.05)',
      ambientUrgent: [255, 96, 64],
      stone: {
        rim: 'rgba(255, 176, 110, 0.48)',
        whiteRim: 'rgba(206, 172, 132, 0.4)',
        arc: 'rgba(255, 226, 190, 0.5)'
      }
    }
  };

  var ORDER = ['classic', 'snow', 'river', 'mine'];

  /**
   * 取主题；未知 id 回退到经典。
   * @param {string} id
   */
  function get(id) {
    return THEMES[id] || THEMES.classic;
  }

  /**
   * 定位当前主题。
   *
   * 优先用显式传入的模式 id（main.js 会传）；老调用方不传时，退回按
   * `state.arenaState` 的形状推断——四种模式在数据上互斥，推断是可靠的。
   *
   * @param {object} [state] GameState
   * @param {string} [modeId]
   * @returns {string} 主题 id
   */
  function idOf(state, modeId) {
    if (modeId && THEMES[modeId]) return modeId;

    var arena = state && state.arenaState;
    if (!arena) return 'classic';
    if (arena.mines) return 'mine';
    if (arena.riverColumns) return 'river';
    if (arena.spikes) return 'snow';

    return 'classic';
  }

  G.Render = G.Render || {};
  G.Render.Theme = {
    ORDER: ORDER,
    ALL: THEMES,
    get: get,
    idOf: idOf
  };
})();
