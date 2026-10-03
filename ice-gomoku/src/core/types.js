/**
 * 五子奇境 · 核心常量与数据约定
 *
 * 本文件是全局唯一的常量来源。其余模块只能通过 window.Gomoku.Types 读取，
 * 不得各自复制一份字面量。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});

  // ── 棋子取值 ────────────────────────────────────────────────────────────
  // 棋盘数据是纯粹的：只允许这三个值，任何场地状态都不得写入棋盘。
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;

  // ── 棋盘规格 ────────────────────────────────────────────────────────────
  var DEFAULT_SIZE = 15;   // 15×15 交叉点
  var WIN_COUNT = 5;       // 连成五子即胜
  var STAR_SPACING = 4;    // 天元/星位间隔：15 路盘即 3、7、11

  // ── 渲染取值（与 Canvas 绘制相关）────────────────────────────────────────
  var STONE_RADIUS_RATIO = 0.44;   // 棋子半径 = 格距 × 该比例
  var WIN_LINE_WIDTH_RATIO = 0.11; // 胜利连线粗细 = 格距 × 该比例

  // ── 胜负 ────────────────────────────────────────────────────────────────
  var WINNER_NONE = 0;     // 尚未分出胜负（与 EMPTY 同为 0，但语义不同，单独命名）

  var Types = {
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,

    DEFAULT_SIZE: DEFAULT_SIZE,
    WIN_COUNT: WIN_COUNT,
    STAR_SPACING: STAR_SPACING,

    STONE_RADIUS_RATIO: STONE_RADIUS_RATIO,
    WIN_LINE_WIDTH_RATIO: WIN_LINE_WIDTH_RATIO,

    WINNER_NONE: WINNER_NONE,

    /**
     * 是否是在规则上有意义的棋子值（0 | 1 | 2）。
     * @param {*} value
     * @returns {boolean}
     */
    isCell: function (value) {
      return value === EMPTY || value === BLACK || value === WHITE;
    },

    /**
     * 取另一方。只对 BLACK / WHITE 有意义。
     * @param {number} player
     * @returns {number}
     */
    opponentOf: function (player) {
      return player === BLACK ? WHITE : BLACK;
    },

    /**
     * 棋子的中文名，用于界面提示。
     * @param {number} player
     * @returns {string}
     */
    nameOf: function (player) {
      if (player === BLACK) return '黑棋';
      if (player === WHITE) return '白棋';
      return '空';
    },

    /**
     * 「雪山洞穴」场地常量。
     *
     * 场地状态一律存放在 GameState.arenaState 里，绝不混入棋盘 cells：
     *   arenaState = {
     *     spikes:    { "x,y": true },  // 冰锥预警：位置可见，落下时间不可知
     *     iceBlocks: { "x,y": 2 },     // 冰块：值为「还能再结算几次回合后融化」
     *     rng:       function           // 随机数源（便于测试时注入）
     *   }
     */
    ARENA: {
      ID: 'snow-cave',
      NAME: '雪山洞穴',

      MAX_SPIKES: 5,        // 同时存在的预警数量上限（也是补充目标）
      SPIKE_DROP_CHANCE: 0.3, // 每个预警每回合独立判定的落下概率
      ICE_TURNS: 2          // 冰块存在多少个回合结算
    },

    /**
     * 场地格子的键，例如 (3, 7) → "3,7"。
     * @param {number} x
     * @param {number} y
     * @returns {string}
     */
    cellKey: function (x, y) {
      return x + ',' + y;
    },

    /**
     * 创建一个新对局的初始状态。
     *
     * 约定：
     *  - cells   ：纯棋盘数据，只含 0 | 1 | 2
     *  - arenaState：场地状态单独存放，与棋盘完全分离
     *  - winner  ：WINNER_NONE(0) 表示未结束
     *  - winningLine：胜出时的五连坐标，未结束时为 null
     *
     * @param {number} [size]
     * @returns {object} GameState
     */
    createGameState: function (size) {
      var n = size || DEFAULT_SIZE;

      return {
        size: n,

        // 棋盘：纯数据，长度 n*n，取值 0 | 1 | 2
        cells: new Uint8Array(n * n),

        currentPlayer: BLACK,
        moveCount: 0,     // 已完成推进的回合数（由 advanceTurn 维护，见 main.js）

        winner: WINNER_NONE,
        winningLine: null,

        lastMove: null,   // { x, y, player }
        history: [],      // 落子历史，重开时清空

        // 场地状态：由 core/arena.js 创建与结算，本文件只声明结构
        arenaState: null
      };
    }
  };

  G.Types = Types;
})();
