/**
 * 五子奇境 · 山谷溪流场地规则
 *
 * 职责：河流状态的创建与结算。**只管数据，不碰 DOM、不做绘制。**
 * 绘制在 render/arena.js，两者通过 state.arenaState 传递数据。
 *
 * 场地状态与棋盘数据严格分离：
 *   arenaState.waterLevel   0..80 的整数（%）
 *   arenaState.riverColumns 当前河流列，如 [6, 7]
 *   arenaState.rng          随机数源（可注入，便于测试）
 *
 * 回合结算顺序（由 main.js 的 advanceTurn 调用 settleRiver）：
 *   1. 计算水位
 *   2. 判断河流是否扩展（跨过 30 / 60 阈值时立即扩展，永久不缩回）
 *   3. 冲走判定（遍历当前河流所有列上的棋子，各自独立判定）
 *
 * 注意：扩展在冲走判定**之前**完成，所以新扩进来的列当回合就有风险。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  // ── 创建 ────────────────────────────────────────────────────────────────

  /**
   * 创建河流状态：开局无雨、水位 0、河宽 2 列。
   * @param {function} [rng] 随机数源，默认 Math.random
   * @returns {object} arenaState
   */
  function create(rng) {
    return {
      waterLevel: 0,
      riverColumns: T.RIVER_BASE_COLUMNS.slice(),
      rng: rng || Math.random
    };
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 当前河流列（升序副本）。 */
  function getColumns(arenaState) {
    if (!arenaState || !arenaState.riverColumns) return [];
    return arenaState.riverColumns.slice().sort(function (a, b) { return a - b; });
  }

  /** 按当前水位应扩到的列（永久扩展：水位涨上去就不会再退回来）。 */
  function columnsForLevel(waterLevel) {
    var columns = T.RIVER_BASE_COLUMNS.slice();
    var expansions = T.RIVER_EXPANSIONS;

    for (var i = 0; i < expansions.length; i++) {
      if (waterLevel >= expansions[i].level) {
        columns = columns.concat(expansions[i].columns);
      }
    }

    return columns.sort(function (a, b) { return a - b; });
  }

  /** 该列是否在河中。 */
  function isRiverColumn(arenaState, column) {
    if (!arenaState || !arenaState.riverColumns) return false;
    for (var i = 0; i < arenaState.riverColumns.length; i++) {
      if (arenaState.riverColumns[i] === column) return true;
    }
    return false;
  }

  /**
   * 某格棋子本回合被冲走的概率。
   * 概率 = 水位 × 位置系数 / 100（水位 0..80 → 0..0.8）
   *
   * @param {object} arenaState
   * @param {number} column
   * @returns {number} 0..0.8
   */
  function washChance(arenaState, column) {
    if (!isRiverColumn(arenaState, column)) return 0;

    var factor = T.riverFactorOf(column);
    return (arenaState.waterLevel * factor) / 100;
  }

  // ── 结算步骤 1~2：水位与河流扩展 ────────────────────────────────────────

  /**
   * 依 moveCount 计算水位，并在跨过阈值时永久扩展河流。
   *
   * @param {object} arenaState
   * @param {number} moveCount 已推进后的回合数
   * @returns {{level:number, expanded:boolean, columns:Array<number>}}
   */
  function updateWater(arenaState, moveCount) {
    var before = getColumns(arenaState).join(',');

    arenaState.waterLevel = T.waterLevelAt(moveCount);

    // 扩展是永久的：这里只并入、不裁剪
    var target = columnsForLevel(arenaState.waterLevel);
    var current = arenaState.riverColumns || [];

    for (var i = 0; i < target.length; i++) {
      if (current.indexOf(target[i]) === -1) current.push(target[i]);
    }

    arenaState.riverColumns = current.sort(function (a, b) { return a - b; });

    return {
      level: arenaState.waterLevel,
      expanded: before !== getColumns(arenaState).join(','),
      columns: getColumns(arenaState)
    };
  }

  // ── 结算步骤 3：冲走判定 ────────────────────────────────────────────────

  /**
   * 遍历河流所有列上的棋子，各自独立判定是否被冲走。
   *
   * 被冲走的棋子直接消失、格子恢复为空、不留痕迹、可重新落子。
   * 河心（6、7）系数 1.0，次外圈（5、8）0.7，最外圈（4、9）0.4。
   *
   * @param {object} board
   * @param {object} arenaState
   * @returns {Array<{x:number,y:number,column:number,player:number}>} 被冲走的棋子
   */
  function washAway(board, arenaState) {
    var washed = [];
    var rng = arenaState.rng || Math.random;
    var columns = getColumns(arenaState);

    if (arenaState.waterLevel <= 0) return washed;   // 没下雨就没什么可冲的

    for (var c = 0; c < columns.length; c++) {
      var column = columns[c];
      var chance = washChance(arenaState, column);

      if (chance <= 0) continue;

      for (var y = 0; y < board.size; y++) {
        var player = B.getCell(board, column, y);
        if (player === T.EMPTY) continue;

        if (rng() < chance) {
          B.removeStone(board, column, y);
          washed.push({ x: column, y: y, column: column, player: player });
        }
      }
    }

    return washed;
  }

  // ── 一次完整的回合结算 ──────────────────────────────────────────────────

  /**
   * 按场地规则结算一个回合：更新水位 → 扩展河流 → 冲走判定。
   *
   * 注意本函数**不**负责 moveCount++ 与切换玩家：moveCount 已由 main.js 在
   * 调用前推进（水位公式依赖推进后的 moveCount），切换玩家在调用之后。
   *
   * @param {object} board
   * @param {object} arenaState
   * @param {number} moveCount 已推进后的回合数
   * @returns {{level:number, expanded:boolean, columns:Array<number>, washed:Array, chance:Object}}
   */
  function settleRiver(board, arenaState, moveCount) {
    // 1~2. 水位与河流扩展（扩展先于冲走，新列当回合即生效）
    var water = updateWater(arenaState, moveCount);

    // 3. 冲走判定
    var washed = washAway(board, arenaState);

    // 各列当前概率，供 HUD 展示
    var chance = {};
    for (var i = 0; i < water.columns.length; i++) {
      chance[water.columns[i]] = washChance(arenaState, water.columns[i]);
    }

    return {
      level: water.level,
      expanded: water.expanded,
      columns: water.columns,
      washed: washed,
      chance: chance
    };
  }

  G.River = {
    create: create,
    settleRiver: settleRiver,
    updateWater: updateWater,
    washAway: washAway,
    washChance: washChance,
    getColumns: getColumns,
    columnsForLevel: columnsForLevel,
    isRiverColumn: isRiverColumn
  };
})();
