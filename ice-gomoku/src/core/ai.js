/**
 * 五子奇境 · 电脑对手（PvE）
 *
 * 职责：给定一个局面，算出一手棋。**只管计算，不碰 DOM、不改真实对局状态。**
 *
 * ── 设计取向：能看懂威胁的轻量 AI ────────────────────────────────────────
 * 五子棋是「威胁主导」的游戏。真正决定强弱的是三件事：
 *   1. 自己有四连 → 立刻成五；
 *   2. 对手在某个空点落下就能成五 → 这一手必须堵，而且要看「堵完还剩几处」；
 *   3. 都没有时，选一条让自己的「连子潜力」最大、同时压住对手潜力的点。
 * 这三条用一张**模式表**就能算得很准，不需要蒙特卡洛：
 *
 *   把棋盘上全部 572 条五连窗口（横 / 竖 / 撇 / 捺）编成索引，每条窗口按
 *   「线内已有几子」查一张权重表，落子增量就是权重差。于是「活三 / 冲四 /
 *   双三」这些威胁会自然体现在分数里，而且每格只要 5 次查表。
 *
 * 三档强度只改**决策的随机程度**（软最大抽样的温度与噪声），规则完全一致：
 *   简单：经常挑错，会漏挡活三
 *   普通：看得住活三与冲四，偶尔走次优
 *   困难：几乎总是挑当前最优，且对「两处成五」这类必死局面也认得清
 *
 * 场地（冰锥 / 河流 / 雷区）只影响**落点合法性**与轻微的选址偏好：
 * 冰块格不能下（由 isLegal 保证），雷区格与预警格会被避开一点权重。
 * 这样四模式共用一套判断，也不会因为「猜未来」而算错。
 *
 * 用法：
 *   var move = G.AI.chooseMove(state, 'normal');   // { x, y } 或 null
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  /** 依赖兜底：本文件必须排在 core 各模块之后加载。 */
  function deps() {
    if (!T || !B) throw new Error('Gomoku.AI 需要 core/types.js 与 core/board.js 先加载');

    return { T: T, B: B };
  }

  // ── 强度档位 ────────────────────────────────────────────────────────────
  // 决策只按「对手还剩几处成五」分档，再在档内挑：
  //   temperature：挑选温度。越小越接近「直接取最高分」。
  //                注意要和档内分差同量级——分差在百位左右，
  //                温度给到几千就等于在近似同分的点里乱挑，反而变弱。
  //   noise      ：加在分上的扰动，让简单档真的会挑错。
  //   blunder    ：直接「看漏」的概率——从候选里随便挑一手。
  //                只靠噪声是不够的：像「挡冲四」那种唯一好手，分数
  //                比别的点高一个量级，再怎么扰动也盖不过（实测过）。
  //                要让简单档真的输得掉，就得让它有一定概率直接走神。
  //   strict     ：是否把「对手剩下的成五点最少」当硬约束。
  //                简单档故意关掉，它就是这样才让人赢得下来。
  //   topK       ：只看最靠前的这么多个点。
  var LEVELS = {
    easy: {
      id: 'easy',
      name: '简单',
      desc: '会算，但常常走偏，也接不住连三',
      temperature: 420,
      noise: 900,
      blunder: 0.28,
      strict: false,
      topK: 6,
      minThinkMs: 300
    },
    normal: {
      id: 'normal',
      name: '普通',
      desc: '看得住活三与冲四，会抢要点',
      temperature: 90,
      noise: 160,
      blunder: 0.06,
      strict: true,
      topK: 8,
      minThinkMs: 380
    },
    hard: {
      id: 'hard',
      name: '困难',
      desc: '几乎总挑最优，认得出双威胁',
      temperature: 12,
      noise: 15,
      blunder: 0,
      strict: true,
      topK: 10,
      minThinkMs: 460
    }
  };

  var DEFAULT_LEVEL = 'normal';

  // ── 模式表 ──────────────────────────────────────────────────────────────
  // 记法：某条窗口上「已经有 m 子」时，它对那一方的价值就是 LINE[m]。
  // 于是「再落一子」（第 m 子 → 第 m+1 子）带来的增涨是 LINE[m+1] - LINE[m]。
  // 这张表是累计值，形状是「越连越多、最后一步暴涨」：
  //   m=0 空线 0
  //   m=1 一子 0
  //   m=2 二子 24        活二开始有意图
  //   m=3 三子 318       活三，对方必须应
  //   m=4 四子 5198      活四，几乎赢定
  //   m=5 五子 59998     成五，一手定胜负
  // 相邻差分（每次落子的增涨）正好是 0 / 24 / 294 / 4880 / 54800。
  // m=5 之后补一项重复值，这样查 m+1 不会越界取到 undefined。
  // 混色会互相压低（窗口里黑子多了，白子那一项自然变小）。
  var LINE_BLACK = [0, 0, 24, 318, 5198, 59998, 59998];
  var LINE_WHITE = [0, 0, 24, 318, 5198, 59998, 59998];

  // 「下完对手还有几处成五」的惩罚。必须大于一条活四的价值（4880），
  // 否则 AI 会为了自己做个活四而放过对手的活四——那等于直接输。
  var THREAT_PENALTY = 6000;

  // 四个方向：横、竖、撇、捺。用于沿整条线数连续同色段。
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // 每张表：
  //   index[cell]  经过该点的窗口下标
  //   prefB[cell]  「该点所在窗口已有 m 颗黑子 → 落下去涨多少分」的增量数组
  //   prefW[cell]  同理，白方
  // 有了它，「在 (x,y) 落一子」对每条线的影响是 O(1) 查表。
  var tables = {};

  function clamp(value, lo, hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
  }

  /** 可播种伪随机（mulberry32），仅用于测试复现；对局用 Math.random。 */
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

  /** 把 { "x,y": turns } 形式的数据转成一维数组（不共享真实对象）。 */
  function keysToArray(list) {
    var out = [];

    if (!list) return out;

    for (var key in list) {
      if (!Object.prototype.hasOwnProperty.call(list, key)) continue;

      var parts = key.split(',');
      out.push({
        x: parseInt(parts[0], 10),
        y: parseInt(parts[1], 10),
        turns: list[key]
      });
    }

    return out;
  }

  // ── 模式表构建 ──────────────────────────────────────────────────────────

  /** 为指定棋盘尺寸构建（或复用）模式表。 */
  function buildTables(size) {
    if (tables[size]) return tables[size];

    var n = size;
    var count = n * n;
    var index = new Array(count);
    var lines = [];

    var i, x, y, k, cells;

    for (i = 0; i < count; i++) index[i] = [];

    function pushLine(list) {
      var id = lines.length;
      lines.push(list);

      for (var m = 0; m < list.length; m++) index[list[m]].push(id);
    }

    // 横
    for (y = 0; y < n; y++) {
      for (x = 0; x + T.WIN_COUNT <= n; x++) {
        cells = [];
        for (k = 0; k < T.WIN_COUNT; k++) cells.push(y * n + x + k);
        pushLine(cells);
      }
    }

    // 竖
    for (x = 0; x < n; x++) {
      for (y = 0; y + T.WIN_COUNT <= n; y++) {
        cells = [];
        for (k = 0; k < T.WIN_COUNT; k++) cells.push((y + k) * n + x);
        pushLine(cells);
      }
    }

    // 撇（↘）
    for (y = 0; y + T.WIN_COUNT <= n; y++) {
      for (x = 0; x + T.WIN_COUNT <= n; x++) {
        cells = [];
        for (k = 0; k < T.WIN_COUNT; k++) cells.push((y + k) * n + x + k);
        pushLine(cells);
      }
    }

    // 捺（↗）
    for (y = T.WIN_COUNT - 1; y < n; y++) {
      for (x = 0; x + T.WIN_COUNT <= n; x++) {
        cells = [];
        for (k = 0; k < T.WIN_COUNT; k++) cells.push((y - k) * n + x + k);
        pushLine(cells);
      }
    }

    var table = {
      size: n,
      lines: lines,
      index: index,
      prefB: new Array(count),
      prefW: new Array(count)
    };

    // prefB[cell][m] = 「经过该点的某条线上已有 m 子时，再落一子的增涨」
    //   = LINE[m+1] - LINE[m]
    // 注意索引是**线内子数 m**，不是窗口序号——两者完全不同，
    // 按窗口序号存会让每个位置都写成「线上第 5 子」的增涨（踩过这个坑）。
    // 每个 m 都是常量（所有窗口长度都是 5），但按 m 填表才与查表口径一致。
    for (i = 0; i < count; i++) {
      var pb = new Int32Array(T.WIN_COUNT + 1);
      var pw = new Int32Array(T.WIN_COUNT + 1);

      for (var m = 0; m <= T.WIN_COUNT; m++) {
        pb[m] = LINE_BLACK[m + 1] - LINE_BLACK[m];
        pw[m] = LINE_WHITE[m + 1] - LINE_WHITE[m];
      }

      table.prefB[i] = pb;
      table.prefW[i] = pw;
    }

    tables[size] = table;

    return table;
  }

  // ── 局面快照 ────────────────────────────────────────────────────────────

  /** 该点周围 radius 格内是否已有棋子。 */
  function nearStone(cells, n, x, y, radius) {
    for (var dy = -radius; dy <= radius; dy++) {
      var ny = y + dy;
      if (ny < 0 || ny >= n) continue;

      for (var dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;

        var nx = x + dx;
        if (nx < 0 || nx >= n) continue;

        if (cells[ny * n + nx] !== T.EMPTY) return true;
      }
    }

    return false;
  }

  /**
   * 读取真实对局状态，建一份**只读**的分析视图。
   *
   * 这里刻意不拷贝 arenaState：AI 只需要知道哪些格子不能下（冰块）、
   * 哪些格子要避让（雷区 / 预警），这些都能从 state 直接读出来。
   */
  function analyze(state) {
    deps();

    var n = state.size;
    var table = buildTables(n);
    var cells = state.cells;
    var rowB = new Int32Array(table.lines.length);
    var rowW = new Int32Array(table.lines.length);

    var i, j, list;

    for (i = 0; i < n * n; i++) {
      var v = cells[i];
      if (v === T.EMPTY) continue;

      list = table.index[i];

      if (v === T.BLACK) {
        for (j = 0; j < list.length; j++) rowB[list[j]]++;
      } else {
        for (j = 0; j < list.length; j++) rowW[list[j]]++;
      }
    }

    var arena = state.arenaState;

    return {
      size: n,
      table: table,
      cells: cells,
      rowB: rowB,
      rowW: rowW,
      player: state.currentPlayer,
      // 场地信息：只用来做「避让」，不参与胜负判断
      ice: arena && arena.iceBlocks ? arena.iceBlocks : null,
      mines: arena && arena.mines ? arena.mines : null,
      spikes: arena && arena.spikes ? arena.spikes : null,
      riverColumns: arena && arena.riverColumns ? arena.riverColumns : null
    };
  }

  /** 该格是否被冰块封住（冰块格不可落子）。 */
  function hasIce(view, x, y) {
    return !!view.ice && Object.prototype.hasOwnProperty.call(view.ice, T.cellKey(x, y));
  }

  // ── 评分 ────────────────────────────────────────────────────────────────

  /**
   * 评估在 (x,y) 落一子。
   *
   * @returns {{win:boolean, opWins:number, my:number, op:number}}
   *   win    这一手直接成五
   *   opWins 下完这一手之后，对手还有几处「立刻能成五」的连段
   *          （0 = 对手接下来杀不了；1 = 还能再挡一手；≥2 = 堵不住，已经输了）
   *   my     这一手让自己涨多少分（各窗口增量之和）
   *   op     对手若占此点能涨多少分（所以「对手的好点」自己也要抢）
   *
   * ── 关键概念：opWins 是「我方落子后，对手还有几个一步成五的点」 ─────────
   * 注意**不是**「经过落点的威胁」——那个问法是错的。
   * 例：黑在 (3,7)~(6,7) 摆好四子，白挡在 (7,7)：
   *   经过 (7,7) 的黑棋连续段只有 1（左边被白自己的子挡住），看着像没威胁，
   *   但棋盘上另外存在一处黑子成五点吗？没有 → 挡得干净，opWins 应为 0。
   * 而白若挡在 (8,7)：黑在 (7,7) 一步成五 → opWins 为 1。
   * 所以必须**全盘数对方的必胜点**，不能只看落点所在的线。
   */
  function evaluate(view, x, y) {
    var table = view.table;
    var cells = view.cells;
    var rowB = view.rowB;
    var rowW = view.rowW;
    var n = view.size;
    var black = view.player === T.BLACK;
    var lineSelf = black ? LINE_BLACK : LINE_WHITE;
    var lineOpp = black ? LINE_WHITE : LINE_BLACK;
    var rowSelf = black ? rowB : rowW;
    var rowOpp = black ? rowW : rowB;
    var selfColor = view.player;
    var oppColor = black ? T.WHITE : T.BLACK;

    var idx = y * n + x;
    var list = table.index[idx];
    var my = 0;
    var op = 0;
    var j, id;

    // ① 分数：只看经过该点的窗口（查表，O(5)）
    for (j = 0; j < list.length; j++) {
      id = list[j];
      my += lineSelf[rowSelf[id] + 1] - lineSelf[rowSelf[id]];
      op += lineOpp[rowOpp[id] + 1] - lineOpp[rowOpp[id]];
    }

    // ② 威胁：临时落子后全盘数对手的必胜点，数完立刻撤回
    var backup = cells[idx];
    cells[idx] = selfColor;

    var selfFive = isWinningPoint(cells, n, x, y, selfColor);
    var opWins = countWinningPoints(cells, n, oppColor, 2);

    cells[idx] = backup;

    return {
      win: selfFive,
      opWins: opWins,
      my: my,
      op: op
    };
  }

  /**
   * 从 (x,y) 出发，某一方是否已经连成五子（含该点自身）。
   * 沿四个方向一路数到棋盘边缘，不受「五连窗口」的 5 格限制。
   */
  function isWinningPoint(cells, n, x, y, color) {
    return longestRun(cells, n, x, y, color) >= T.WIN_COUNT;
  }

  /**
   * 全盘数「某一方一步就能成五」的落点数。
   *
   * @param {number} [stopAt] 数到这个数量就提前收工（用于只关心 0/1/≥2 的场景）
   */
  function countWinningPoints(cells, n, color, stopAt) {
    var total = 0;

    for (var yy = 0; yy < n; yy++) {
      for (var xx = 0; xx < n; xx++) {
        var i = yy * n + xx;

        if (cells[i] !== T.EMPTY) continue;

        cells[i] = color;
        var win = longestRun(cells, n, xx, yy, color) >= T.WIN_COUNT;
        cells[i] = T.EMPTY;

        if (win) {
          total++;
          if (stopAt && total >= stopAt) return total;
        }
      }
    }

    return total;
  }

  /**
   * 经过 (x,y) 的最长同色连续段长度。
   *
   * **不使用五连窗口**，而是沿横 / 竖 / 两条斜线一路数到棋盘边缘：
   * 窗口只有 5 格，一旦计算「被截断的四连」就会数错（见 evaluate 的注释）。
   *
   * @returns {number} 含 (x,y) 自身在内的最长连续同色子数
   */
  function longestRun(cells, n, x, y, color) {
    var best = 1;

    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var count = 1;
      var cx = x - dx;
      var cy = y - dy;

      while (cx >= 0 && cy >= 0 && cx < n && cy < n && cells[cy * n + cx] === color) {
        count++;
        cx -= dx;
        cy -= dy;
      }

      cx = x + dx;
      cy = y + dy;

      while (cx >= 0 && cy >= 0 && cx < n && cy < n && cells[cy * n + cx] === color) {
        count++;
        cx += dx;
        cy += dy;
      }

      if (count > best) best = count;
    }

    return best;
  }

  /**
   * 收集候选点并排序。只考虑棋子附近 2 格内的空点：
   * 既是战术上唯一有意义的地方，也把候选数从 200+ 降到几十个。
   *
   * 排序键就是实战优先级，**安全性在价值之前**：
   *   1. 能成五 → 直接赢；
   *   2. 对手剩下的成五点越少越好（活四不挡的话，分只差一点，但下一手就死）；
   *   3. 再看综合价值。
   */
  function candidates(view) {
    var n = view.size;
    var cells = view.cells;
    var out = [];

    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (cells[y * n + x] !== T.EMPTY) continue;
        if (hasIce(view, x, y)) continue;
        if (!nearStone(cells, n, x, y, 2)) continue;

        var info = evaluate(view, x, y);

        // 靠近天元一点点的加成：只影响开局几手，权重刻意很小
        var dx = x - (n - 1) / 2;
        var dy = y - (n - 1) / 2;
        var center = -(dx * dx + dy * dy) * 0.05;

        out.push({
          x: x,
          y: y,
          my: info.my,
          op: info.op,
          win: info.win,
          opWins: info.opWins,
          score: info.my + info.op * 0.85 + center
        });
      }
    }

    out.sort(function (a, b) {
      if (a.win !== b.win) return a.win ? -1 : 1;
      if (a.opWins !== b.opWins) return a.opWins - b.opWins;
      return b.score - a.score;
    });

    return out;
  }

  // ── 决策 ────────────────────────────────────────────────────────────────

  /**
   * 算出一手棋。同步、轻量（通常 1ms 以内），不需要分帧。
   *
   * @param {object} state 真实对局状态（只读）
   * @param {string} [level] 'easy' | 'normal' | 'hard'
   * @param {object} [options] { rng: function }
   * @returns {{x:number, y:number}|null}
   */
  function chooseMove(state, level, options) {
    if (!state || state.winner !== T.WINNER_NONE) return null;

    var cfg = LEVELS[level] || LEVELS[DEFAULT_LEVEL];
    var rng = (options && options.rng) || Math.random;
    var view = analyze(state);

    // 空盘：直接走天元
    if (countStones(view) === 0) {
      var mid = Math.floor((state.size - 1) / 2);
      return { x: mid, y: mid };
    }

    var list = candidates(view);
    if (list.length === 0) return null;

    // ① 成五的点直接下，不参与随机（避免「能赢却不下」这种低级错误）
    for (var i = 0; i < list.length; i++) {
      if (list[i].win) return { x: list[i].x, y: list[i].y };
    }

    // ② 只在最靠前的 topK 个里挑
    var pool = list.slice(0, Math.max(1, Math.min(cfg.topK, list.length)));

    // ③ 安全性：中高档把它当**硬约束**——只从「对手剩下的成五点最少」
    //    那一档里挑。加个罚分是不够的：「自己做个活四（+4880）」会盖过
    //    「挡掉对手冲四」，于是 AI 为进攻放弃防守，直接被一波带走。
    //    简单档**故意不守**这个约束（它就是这样才显得弱），给玩家留出
    //    「能赢」的空间；但它仍然不会主动成五（上面已经先返回了）。
    var safest = pool[0].opWins;
    var pickPool = [];

    for (var s = 0; s < pool.length; s++) {
      if (cfg.strict ? pool[s].opWins === safest : true) pickPool.push(pool[s]);
    }

    // ④ 走神：直接从这个池子里随便挑一手。
    //    这是简单档真正「输得掉」的来源——唯一的必挡点分数往往高出一个
    //    量级，光靠噪声和温度是盖不过去的。
    if (cfg.blunder > 0 && rng() < cfg.blunder) {
      var random = pickPool[Math.floor(rng() * pickPool.length)];
      return { x: random.x, y: random.y };
    }

    // ⑤ 挑选：先按噪声扰动，再软最大抽样
    var best = -Infinity;

    for (var b = 0; b < pickPool.length; b++) {
      pickPool[b].picked = pickPool[b].score + (cfg.noise > 0 ? (rng() * 2 - 1) * cfg.noise : 0);
      if (pickPool[b].picked > best) best = pickPool[b].picked;
    }

    var total = 0;
    var weights = new Array(pickPool.length);

    for (var w = 0; w < pickPool.length; w++) {
      // 注意方向：越好的一手权重必须越大。
      // 写成 exp((v - best)/T) 的话，best 自己得到 exp(0)=1、更差的点得到
      // exp(负数) < 1 —— 那样**恰好把强弱选反了**（踩过这个坑）。
      var rel = (best - pickPool[w].picked) / cfg.temperature;   // >= 0

      weights[w] = Math.exp(-clamp(rel, 0, 40));
      total += weights[w];
    }

    var pick = rng() * total;
    var chosen = pickPool[0];

    for (var p = 0; p < pickPool.length; p++) {
      pick -= weights[p];
      if (pick <= 0) { chosen = pickPool[p]; break; }
    }

    return { x: chosen.x, y: chosen.y };
  }

  /** 盘面上的棋子数（场地会吃掉棋子，所以现数）。 */
  function countStones(view) {
    var n = 0;

    for (var i = 0; i < view.cells.length; i++) {
      if (view.cells[i] !== T.EMPTY) n++;
    }

    return n;
  }

  G.AI = {
    LEVELS: LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,

    /** 强敌档位表（界面用）。 */
    levels: function () {
      var order = ['easy', 'normal', 'hard'];
      var out = [];

      for (var i = 0; i < order.length; i++) {
        var cfg = LEVELS[order[i]];
        out.push({ id: cfg.id, name: cfg.name, desc: cfg.desc });
      }

      return out;
    },

    nameOf: function (level) {
      return (LEVELS[level] || LEVELS[DEFAULT_LEVEL]).name;
    },

    /** 该档位的最短思考时间（界面用来决定「看起来在想」多久）。 */
    thinkTimeOf: function (level) {
      return (LEVELS[level] || LEVELS[DEFAULT_LEVEL]).minThinkMs;
    },

    chooseMove: chooseMove,

    // 测试与调试出口
    _internals: {
      buildTables: buildTables,
      analyze: analyze,
      evaluate: evaluate,
      longestRun: longestRun,
      candidates: candidates,
      keysToArray: keysToArray,
      seededRandom: seededRandom
    }
  };
})();
