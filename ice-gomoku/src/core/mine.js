/**
 * 五子奇境 · 危险雷区场地规则
 *
 * 职责：雷区状态的创建与结算。**只管数据，不碰 DOM、不做绘制。**
 * 绘制在 render/arena.js，两者通过 state.arenaState 传递数据。
 *
 * 场地状态与棋盘数据严格分离：
 *   arenaState.mines  "x,y" -> 剩余回合数
 *   arenaState.rng    随机数源（可注入，便于测试）
 *
 * 回合结算顺序（由 main.js 的 advanceTurn 调用 settleMines）：
 *   1. 所有雷区倒计时 -1
 *   2. 归零的雷区引爆（含连锁）
 *   3. 每 MINE_SPAWN_INTERVAL 回合新增 1 个雷区
 *
 * 主动引爆不由本文件发起：它是落子流程的一部分（见 main.js 的 playMove），
 * 落在雷区格上后立即调用本文件的 detonate()。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  // ── 随机数 ──────────────────────────────────────────────────────────────

  /** 闭区间随机整数 [min, max]。 */
  function randomInt(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  // ── 创建 ────────────────────────────────────────────────────────────────

  /**
   * 创建雷区状态：开局随机埋 5～8 个雷，各带 5～15 回合倒计时。
   * @param {object} board
   * @param {function} [rng]
   * @returns {object} arenaState
   */
  function create(board, rng) {
    var arenaState = {
      mines: {},
      rng: rng || Math.random
    };

    var count = randomInt(arenaState.rng, T.MINE_INITIAL_MIN, T.MINE_INITIAL_MAX);
    var placed = 0;
    var guard = 0;

    // 逐个埋雷；棋盘被填满时提前收手
    while (placed < count && guard < board.size * board.size * 4) {
      guard++;
      if (spawnMine(board, arenaState)) placed++;
      else if (!hasFreeCell(board, arenaState)) break;
    }

    return arenaState;
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 当前雷区数量。 */
  function countMines(arenaState) {
    if (!arenaState || !arenaState.mines) return 0;
    return Object.keys(arenaState.mines).length;
  }

  /** 该格是否有雷区。 */
  function hasMine(arenaState, x, y) {
    if (!arenaState || !arenaState.mines) return false;
    return Object.prototype.hasOwnProperty.call(arenaState.mines, T.cellKey(x, y));
  }

  /** 该格雷区的剩余回合数；无雷返回 null。 */
  function mineCountdown(arenaState, x, y) {
    if (!hasMine(arenaState, x, y)) return null;
    return arenaState.mines[T.cellKey(x, y)];
  }

  /** 取所有雷区坐标与剩余回合数，形如 [{ x, y, turns }]。 */
  function mineList(arenaState) {
    var out = [];

    if (!arenaState || !arenaState.mines) return out;

    for (var key in arenaState.mines) {
      if (!Object.prototype.hasOwnProperty.call(arenaState.mines, key)) continue;

      var parts = key.split(',');
      out.push({
        x: parseInt(parts[0], 10),
        y: parseInt(parts[1], 10),
        turns: arenaState.mines[key]
      });
    }

    return out;
  }

  // ── 埋雷 ────────────────────────────────────────────────────────────────

  /** 是否还存在可埋雷的空格（无棋子、无雷区）。 */
  function hasFreeCell(board, arenaState) {
    for (var y = 0; y < board.size; y++) {
      for (var x = 0; x < board.size; x++) {
        if (B.getCell(board, x, y) !== T.EMPTY) continue;
        if (hasMine(arenaState, x, y)) continue;
        return true;
      }
    }
    return false;
  }

  /**
   * 随机在**空格**（无棋子、无其他雷区）埋一个雷。
   * 采用蓄水池抽样，一趟遍历均匀取一格，无需构造候选数组。
   *
   * @returns {{x:number,y:number,turns:number}|null} 埋下的雷；无合法空格返回 null
   */
  function spawnMine(board, arenaState) {
    var rng = arenaState.rng || Math.random;
    var chosen = null;
    var seen = 0;

    for (var y = 0; y < board.size; y++) {
      for (var x = 0; x < board.size; x++) {
        if (B.getCell(board, x, y) !== T.EMPTY) continue;   // 有棋子
        if (hasMine(arenaState, x, y)) continue;            // 已有雷区

        seen++;
        if (rng() * seen < 1) chosen = { x: x, y: y };
      }
    }

    if (!chosen) return null;

    var turns = randomInt(rng, T.MINE_COUNTDOWN_MIN, T.MINE_COUNTDOWN_MAX);
    chosen.turns = turns;
    arenaState.mines[T.cellKey(chosen.x, chosen.y)] = turns;

    return chosen;
  }

  // ── 爆炸 ────────────────────────────────────────────────────────────────

  /**
   * 引爆一个雷区并处理连锁。
   *
   * 实现要点（与规格一致）：
   *   - 引爆时**立即从 mines 中删除**，因此不需要「已引爆」标记，也不会循环；
   *   - 遍历 3×3 范围，仍在 mines 中的雷区加入待引爆队列；
   *   - 队列逐个处理直到没有新雷区被引爆。
   *
   * 棋盘边缘超出部分直接忽略（不平移、不折叠）。
   *
   * @param {object} board
   * @param {object} arenaState
   * @param {number} x 起始雷区
   * @param {number} y
   * @returns {{cells:Array<{x:number,y:number}>, mines:Array<{x:number,y:number}>, stones:number}}
   *          cells 为被爆炸覆盖的格子（去重）；mines 为被引爆的雷区；stones 为炸毁的棋子数
   */
  function detonate(board, arenaState, x, y) {
    var startKey = T.cellKey(x, y);
    var result = { cells: [], mines: [], stones: 0 };

    if (!arenaState || !arenaState.mines) return result;
    if (arenaState.mines[startKey] === undefined) return result;   // 该格没有雷

    var seenCells = {};
    var queue = [{ x: x, y: y }];
    var radius = T.MINE_BLAST_RADIUS;

    while (queue.length > 0) {
      var cell = queue.shift();
      var key = T.cellKey(cell.x, cell.y);

      // 引爆即删除：这一步同时保证了「每个雷区只引爆一次」
      if (arenaState.mines[key] === undefined) continue;
      delete arenaState.mines[key];
      result.mines.push({ x: cell.x, y: cell.y });

      // 3×3 范围；越界部分直接忽略
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          var nx = cell.x + dx;
          var ny = cell.y + dy;

          if (!B.isInside(board, nx, ny)) continue;

          var nkey = T.cellKey(nx, ny);

          // 记录被覆盖的格子（去重）
          if (seenCells[nkey] === undefined) {
            seenCells[nkey] = true;
            result.cells.push({ x: nx, y: ny });
          }

          // 范围内的其他雷区 → 加入待引爆队列（连锁）
          if (arenaState.mines[nkey] !== undefined) {
            queue.push({ x: nx, y: ny });
          }
        }
      }
    }

    // 摧毁范围内所有棋子（不分敌我）
    for (var i = 0; i < result.cells.length; i++) {
      if (B.removeStone(board, result.cells[i].x, result.cells[i].y)) result.stones++;
    }

    return result;
  }

  // ── 结算步骤 1~2：倒计时与引爆 ──────────────────────────────────────────

  /**
   * 所有雷区倒计时 -1，归零的立即引爆（含连锁）。
   *
   * 关键点：同一回合可能有多个雷区同时归零。它们必须放进**同一个待引爆队列**
   * 一起处理，否则相邻的两个归零雷区会被各自引爆一遍，同一片格子被炸两次、
   * 连锁关系也会丢失。
   *
   * 每个雷区只引爆一次，靠「引爆即从 mines 删除」保证，无需额外标记。
   *
   * @returns {{blasts:Array, cells:Array<{x:number,y:number}>, stones:number}}
   */
  function resolveCountdown(board, arenaState) {
    var radius = T.MINE_BLAST_RADIUS;
    var key;

    // 1. 全部 -1，收集归零者
    var due = [];
    for (key in arenaState.mines) {
      if (!Object.prototype.hasOwnProperty.call(arenaState.mines, key)) continue;

      arenaState.mines[key] -= 1;
      if (arenaState.mines[key] <= 0) due.push(key);
    }

    // 2. 把归零者放进同一个队列
    var queue = [];
    for (var i = 0; i < due.length; i++) {
      var parts = due[i].split(',');
      queue.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
    }

    // 3. 队列逐个处理；连锁进来的也会入队，天然去重
    var fired = [];
    var cells = [];
    var seen = {};
    var stones = 0;

    while (queue.length > 0) {
      var cell = queue.shift();
      var ck = T.cellKey(cell.x, cell.y);

      // 已被先前的连锁引爆过 → 跳过，绝不重复
      if (arenaState.mines[ck] === undefined) continue;

      delete arenaState.mines[ck];                     // 引爆即删除
      fired.push({ x: cell.x, y: cell.y });

      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          var nx = cell.x + dx;
          var ny = cell.y + dy;

          if (!B.isInside(board, nx, ny)) continue;    // 越界部分直接忽略

          var nkey = T.cellKey(nx, ny);

          if (seen[nkey] === undefined) {
            seen[nkey] = true;
            cells.push({ x: nx, y: ny });
          }

          if (arenaState.mines[nkey] !== undefined) {
            queue.push({ x: nx, y: ny });
          }
        }
      }
    }

    // 4. 摧毁范围内所有棋子（不分敌我）
    for (var c = 0; c < cells.length; c++) {
      if (B.removeStone(board, cells[c].x, cells[c].y)) stones++;
    }

    return {
      blasts: fired.length > 0 ? [{ mines: fired, cells: cells, stones: stones }] : [],
      cells: cells,
      stones: stones
    };
  }

  // ── 一次完整的回合结算 ──────────────────────────────────────────────────

  /**
   * 按场地规则结算一个回合。严格按此顺序：
   *   1. 所有雷区倒计时 -1
   *   2. 归零的雷区引爆（含连锁）
   *   3. 每 MINE_SPAWN_INTERVAL 回合新增 1 个雷区
   *
   * 注意本函数**不**负责 moveCount++ 与切换玩家：moveCount 已由 main.js
   * 在调用前推进（生成判定依赖推进后的 moveCount），切换玩家在调用之后。
   *
   * @param {object} board
   * @param {object} arenaState
   * @param {number} moveCount 已推进后的回合数
   * @returns {{blasts:Array, cells:Array, stones:number, spawned:object|null}}
   */
  function settleMines(board, arenaState, moveCount) {
    var resolved = resolveCountdown(board, arenaState);   // 1~2

    // 3. 每 5 回合新增 1 个雷区（只在空格生成；没有空格则本次不生成）
    var spawned = null;
    if (moveCount > 0 && moveCount % T.MINE_SPAWN_INTERVAL === 0) {
      spawned = spawnMine(board, arenaState);
    }

    return {
      blasts: resolved.blasts,
      cells: resolved.cells,
      stones: resolved.stones,
      spawned: spawned
    };
  }

  G.Mine = {
    create: create,
    settleMines: settleMines,
    resolveCountdown: resolveCountdown,
    detonate: detonate,
    spawnMine: spawnMine,
    hasFreeCell: hasFreeCell,
    countMines: countMines,
    hasMine: hasMine,
    mineCountdown: mineCountdown,
    mineList: mineList,
    randomInt: randomInt
  };
})();
