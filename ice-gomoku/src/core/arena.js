/**
 * 五子奇境 · 雪山洞穴场地规则
 *
 * 职责：场地状态的创建与结算。**只管数据，不碰 DOM、不做绘制。**
 * 绘制在 render/arena.js，两者通过 state.arenaState 传递数据。
 *
 * 场地状态与棋盘数据严格分离：
 *   arenaState.spikes    冰锥预警，"x,y" -> true
 *   arenaState.iceBlocks 冰块，    "x,y" -> 剩余回合数
 *   arenaState.rng       随机数源（可注入，便于测试）
 *
 * 回合结算顺序（每回合结束时，由 main.js 的 advanceTurn 调用 settleTurns）：
 *   1. 结算冰锥落下（每个预警独立 30% 判定）
 *   2. 结算冰块融化（倒计时 -1，归零则移除）
 *   3. 补充预警至 5 个
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  var A = T.ARENA;

  // ── 随机数 ──────────────────────────────────────────────────────────────

  /**
   * 可播种的伪随机数发生器（mulberry32）。
   * 只用于测试复现；正常对局传入 Math.random 即可。
   * @param {number} seed
   * @returns {function(): number} 0 <= n < 1
   */
  function seededRandom(seed) {
    var a = seed >>> 0;

    return function () {
      a = (a + 0x6D2B79F5) >>> 0;

      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── 创建 ────────────────────────────────────────────────────────────────

  /**
   * 创建场地状态，并补满初始预警。
   * @param {object} board
   * @param {function} [rng] 随机数源，默认 Math.random
   * @returns {object} arenaState
   */
  function create(board, rng) {
    var arenaState = {
      spikes: {},
      iceBlocks: {},
      rng: rng || Math.random
    };

    refillSpikes(board, arenaState);

    return arenaState;
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 当前预警数量。 */
  function countSpikes(arenaState) {
    if (!arenaState || !arenaState.spikes) return 0;
    return Object.keys(arenaState.spikes).length;
  }

  /** 当前冰块数量。 */
  function countIceBlocks(arenaState) {
    if (!arenaState || !arenaState.iceBlocks) return 0;
    return Object.keys(arenaState.iceBlocks).length;
  }

  /** 取所有预警坐标，形如 [{ x, y }]。 */
  function spikeList(arenaState) {
    var out = [];

    if (!arenaState || !arenaState.spikes) return out;

    for (var key in arenaState.spikes) {
      if (!Object.prototype.hasOwnProperty.call(arenaState.spikes, key)) continue;

      var parts = key.split(',');
      out.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
    }

    return out;
  }

  /** 取所有冰块坐标与剩余回合数，形如 [{ x, y, turns }]。 */
  function iceList(arenaState) {
    var out = [];

    if (!arenaState || !arenaState.iceBlocks) return out;

    for (var key in arenaState.iceBlocks) {
      if (!Object.prototype.hasOwnProperty.call(arenaState.iceBlocks, key)) continue;

      var parts = key.split(',');
      out.push({
        x: parseInt(parts[0], 10),
        y: parseInt(parts[1], 10),
        turns: arenaState.iceBlocks[key]
      });
    }

    return out;
  }

  // ── 结算步骤 1：冰锥落下 ────────────────────────────────────────────────

  /**
   * 每个预警独立判定是否落下。
   *
   * 落下则：摧毁该格棋子 → 生成冰块（ICE_TURNS 回合后融化）→ 移除该预警。
   * 未落下则预警保留到下一回合。
   *
   * @returns {Array<{x:number,y:number,hadStone:boolean}>} 本回合落下的冰锥
   */
  function resolveSpikeDrops(board, arenaState) {
    var drops = [];
    var rng = arenaState.rng || Math.random;

    // 先把坐标取出来：结算过程中会改动 spikes，不能边遍历边改
    var pending = spikeList(arenaState);

    for (var i = 0; i < pending.length; i++) {
      var x = pending[i].x;
      var y = pending[i].y;
      var key = T.cellKey(x, y);

      // 该格若已被冰块占据（理论上不会发生），预警作废
      if (arenaState.iceBlocks[key] !== undefined) {
        delete arenaState.spikes[key];
        continue;
      }

      if (rng() >= A.SPIKE_DROP_CHANCE) continue;  // 没落下，预警保留

      // 落下：摧毁该格棋子
      var hadStone = B.removeStone(board, x, y);

      // 生成冰块并移除预警
      arenaState.iceBlocks[key] = A.ICE_TURNS;
      delete arenaState.spikes[key];

      drops.push({ x: x, y: y, hadStone: hadStone });
    }

    return drops;
  }

  // ── 结算步骤 2：冰块融化 ────────────────────────────────────────────────

  /**
   * 所有冰块倒计时 -1，归零则移除（格子恢复可用，也可重新出现预警）。
   *
   * @param {object} arenaState
   * @param {Array<string>} [keys] 只结算这些格子的冰块；省略则结算全部。
   *        本回合刚生成的冰块必须排除在外，否则它会在同一回合被扣掉 1 点，
   *        导致「持续 2 回合」实际只持续 1 回合。
   * @returns {Array<{x:number,y:number}>} 本回合融化的冰块
   */
  function resolveIceMelt(arenaState, keys) {
    var melted = [];
    var list = keys || Object.keys(arenaState.iceBlocks);

    for (var i = 0; i < list.length; i++) {
      var key = list[i];

      if (arenaState.iceBlocks[key] === undefined) continue;

      arenaState.iceBlocks[key] -= 1;

      if (arenaState.iceBlocks[key] <= 0) {
        delete arenaState.iceBlocks[key];

        var parts = key.split(',');
        melted.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
      }
    }

    return melted;
  }

  // ── 结算步骤 3：补充预警 ────────────────────────────────────────────────

  /**
   * 若预警不足 MAX_SPIKES，在随机空格上补足。
   *
   * 可选格的判定：在界内、无冰块、无已有预警。
   * 注意「有棋子」不算占用——预警可以出现在棋子下方，这正是场地博弈的核心。
   *
   * 采用水库抽样（reservoir sampling），一趟遍历即可均匀随机取 k 个，
   * 无需构造候选数组再洗牌。
   *
   * @returns {Array<{x:number,y:number}>} 本次新增的预警
   */
  function refillSpikes(board, arenaState) {
    var added = [];
    var need = A.MAX_SPIKES - countSpikes(arenaState);

    if (need <= 0) return added;

    var rng = arenaState.rng || Math.random;
    var chosen = [];
    var seen = 0;

    for (var y = 0; y < board.size; y++) {
      for (var x = 0; x < board.size; x++) {
        var key = T.cellKey(x, y);

        if (arenaState.spikes[key] !== undefined) continue;   // 已有预警
        if (arenaState.iceBlocks[key] !== undefined) continue; // 有冰块

        seen++;
        if (chosen.length < need) {
          chosen.push({ x: x, y: y });
        } else {
          // 以 need/seen 的概率替换掉已选中的某一个，保证均匀
          var j = Math.floor(rng() * seen);
          if (j < need) chosen[j] = { x: x, y: y };
        }
      }
    }

    for (var i = 0; i < chosen.length; i++) {
      arenaState.spikes[T.cellKey(chosen[i].x, chosen[i].y)] = true;
      added.push(chosen[i]);
    }

    return added;
  }

  // ── 一次完整的回合结算 ──────────────────────────────────────────────────

  /**
   * 按场地规则结算一个回合。严格按此顺序：
   *   1. 冰锥落下  2. 冰块融化  3. 补充预警
   *
   * 注意本函数**不**负责 moveCount++ 与切换玩家，那两步由 main.js 的
   * advanceTurn 在本函数之后完成，以便未来插入更多场地事件。
   *
   * @param {object} board
   * @param {object} arenaState
   * @returns {{drops: Array, melted: Array, added: Array}}
   */
  function settleTurns(board, arenaState) {
    // 记录结算前就存在的冰块：本回合刚生成的冰块不参与本回合的融化结算
    var existingIce = Object.keys(arenaState.iceBlocks);

    var drops = resolveSpikeDrops(board, arenaState);  // 1. 冰锥落下
    var melted = resolveIceMelt(arenaState, existingIce); // 2. 冰块融化
    var added = refillSpikes(board, arenaState);       // 3. 补充预警

    return { drops: drops, melted: melted, added: added };
  }

  G.Arena = {
    create: create,
    settleTurns: settleTurns,
    resolveSpikeDrops: resolveSpikeDrops,
    resolveIceMelt: resolveIceMelt,
    refillSpikes: refillSpikes,
    countSpikes: countSpikes,
    countIceBlocks: countIceBlocks,
    spikeList: spikeList,
    iceList: iceList,
    seededRandom: seededRandom
  };
})();
