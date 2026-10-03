/**
 * 五子奇境 · 雪山洞穴场地绘制
 *
 * 绘制分两个时机（由 main.js 的主渲染流程依次调用）：
 *   drawScene     —— 洞穴背景（落在棋盘之下）
 *   drawArena     —— 冰锥预警（落在棋盘之上、**棋子之下**）
 *   drawArenaOverlay —— 冰块（落在**棋子之上**，否则压不住棋子）
 *
 * 本文件只读 state.arenaState，不改任何状态；场地规则的结算在 core/arena.js。
 *
 * 坐标系：逻辑坐标以 CSS 像素为单位，原点在画布左上角。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;
  var Arena = G.Arena;

  // ── 几何参数（由 configure 写入）──────────────────────────────────────────
  var geom = {
    size: 0,
    margin: 0,
    origin: 0,
    cell: 0
  };

  var COLORS = {
    // 洞穴
    caveTop: '#0a1522',
    caveBottom: '#050b14',
    wallFar: 'rgba(120, 170, 215, 0.10)',
    wallMid: 'rgba(150, 195, 235, 0.13)',
    wallNear: 'rgba(185, 220, 250, 0.10)',
    wallEdge: 'rgba(200, 232, 255, 0.20)',
    snow: 'rgba(232, 245, 255, 0.85)',
    iceGlow: 'rgba(140, 205, 255, 0.22)',

    // 棋盘（冰川质感）
    boardTop: '#eef7fd',
    boardBottom: '#c2dcef',
    boardRim: 'rgba(140, 200, 232, 0.9)',
    frost: 'rgba(255, 255, 255, 0.5)',

    // 冰锥预警
    spike: '#4A90D9',
    spikeOnStone: 'rgba(160, 215, 255, 0.9)',
    spikeStroke: 'rgba(255, 255, 255, 0.75)',

    // 冰块
    iceFill: 'rgba(150, 210, 255, 0.55)',
    iceBorder: '#8CC8E8',
    iceSheen: 'rgba(255, 255, 255, 0.5)',
    iceDot: 'rgba(58, 122, 168, 0.85)',
    iceDotBack: 'rgba(255, 255, 255, 0.45)',

    // 冰锥落下的闪光
    flash: 'rgba(255, 255, 255, 0.9)',
    flashRing: 'rgba(160, 215, 255, 0.8)'
  };

  // ── 时间与动画 ──────────────────────────────────────────────────────────
  var FALL_MS = 200;        // 冰锥落下的闪光时长
  var KNOCK_MS = 260;       // 冰块生成动画时长
  var SNOWFLAKE_COUNT = 44;

  var clock = 0;            // 由 main.js 主循环推进的时钟（毫秒）
  var lastClock = 0;
  var snowflakes = null;    // 延迟初始化，首次绘制时定位

  /** 冰锥落下动画：{ "x,y": 起始时刻 }。只影响绘制，不参与规则。 */
  var knockAt = {};

  // ── 配置 ────────────────────────────────────────────────────────────────

  function configure(size, margin) {
    geom.size = size;
    geom.margin = margin;
    geom.origin = margin;
    geom.cell = (size - margin * 2) / (T.DEFAULT_SIZE - 1);
  }

  /** 取当前对局的路数，并据此更新格距（与 render/board.js 保持一致）。 */
  function gridSizeOf(state) {
    var n = state && state.size ? state.size : T.DEFAULT_SIZE;
    geom.cell = (geom.size - geom.margin * 2) / (n - 1);
    return n;
  }

  /** 返回棋盘区域（CSS 像素）。 */
  function boardRect(state) {
    var n = gridSizeOf(state);
    var half = geom.cell / 2;
    var start = geom.origin - half;
    var span = (n - 1) * geom.cell + geom.cell;

    return { x: start, y: start, width: span, height: span };
  }

  /** 将后续绘制裁剪到棋盘区域内。 */
  function clipBoard(ctx, state) {
    var rect = boardRect(state);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
  }

  /** 格子中心（或其角落偏移）的画布坐标。 */
  function cellBox(state, x, y) {
    var px = geom.origin + x * geom.cell;
    var py = geom.origin + y * geom.cell;
    var half = geom.cell / 2;

    return {
      cx: px,
      cy: py,
      x: px - half,
      y: py - half,
      size: geom.cell
    };
  }

  // ── 动画时钟 ────────────────────────────────────────────────────────────

  /**
   * 推进本模块的动画时钟。
   * @param {number} nowMs 来自 performance.now() / rAF 的时间戳
   */
  function tick(nowMs) {
    if (lastClock === 0) lastClock = nowMs;

    var dt = nowMs - lastClock;
    lastClock = nowMs;
    clock += dt;

    stepSnow(dt);
  }

  /**
   * 记录冰锥落下的位置，触发 200ms 闪光 + 冰块生成动画。
   * 由 main.js 在结算后调用。纯视觉，不影响任何规则。
   * @param {Array<{x:number,y:number}>} drops
   */
  function notifyDrops(drops) {
    if (!drops) return;

    for (var i = 0; i < drops.length; i++) {
      knockAt[T.cellKey(drops[i].x, drops[i].y)] = clock;
    }
  }

  /** 清空动画痕迹（重开时调用）。 */
  function resetEffects() {
    knockAt = {};
    snowflakes = null;
    lastClock = clock;
  }

  // ── 洞穴背景 ────────────────────────────────────────────────────────────

  function initSnow() {
    snowflakes = [];

    for (var i = 0; i < SNOWFLAKE_COUNT; i++) {
      snowflakes.push(makeFlake(Math.random() * geom.size));
    }
  }

  function makeFlake(py) {
    return {
      x: Math.random() * geom.size,
      y: py === undefined ? -4 : py,
      r: 0.6 + Math.random() * 1.5,   // 半径
      vy: 6 + Math.random() * 14,     // 下落速度（像素/秒）
      drift: Math.random() * Math.PI * 2
    };
  }

  function stepSnow(dt) {
    if (!snowflakes) return;

    var seconds = dt / 1000;

    for (var i = 0; i < snowflakes.length; i++) {
      var f = snowflakes[i];
      f.drift += seconds * 1.2;
      f.y += f.vy * seconds;
      f.x += Math.sin(f.drift) * 6 * seconds;

      if (f.y > geom.size + 4) snowflakes[i] = makeFlake(-4);
    }
  }

  /** 洞穴内壁：上下左右各一层起伏的冰岩。 */
  function drawCaveWalls(ctx) {
    var size = geom.size;
    var margin = geom.margin;
    var n = 7;          // 起伏段数
    var reach = margin;  // 岩壁向画布内延伸的深度

    ctx.save();
    ctx.lineJoin = 'round';

    function ridge(from, to, depth, color, phase) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);

      for (var i = 1; i <= n; i++) {
        var t = i / n;
        var amp = depth * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + phase)));

        if (from.x === to.x) {
          // 竖向边：左右岩壁
          var yy = from.y + (to.y - from.y) * t;
          var xx = from.x + (to.x - from.x) * t + (to.x > from.x ? -amp : amp);
          ctx.lineTo(xx, yy);
        } else {
          // 横向边：上下岩壁
          var xx2 = from.x + (to.x - from.x) * t;
          var yy2 = from.y + (to.y - from.y) * t + (to.y > from.y ? -amp : amp);
          ctx.lineTo(xx2, yy2);
        }
      }

      ctx.lineTo(to.x, to.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = COLORS.wallEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 上壁冰柱
    ridge({ x: 0, y: 0 }, { x: size, y: 0 }, reach * 1.35, COLORS.wallFar, 0.6);
    // 下壁
    ridge({ x: 0, y: size }, { x: size, y: size }, reach * 0.95, COLORS.wallMid, 2.1);
    // 左壁
    ridge({ x: 0, y: 0 }, { x: 0, y: size }, reach * 0.85, COLORS.wallMid, 3.4);
    // 右壁
    ridge({ x: size, y: 0 }, { x: size, y: size }, reach * 0.85, COLORS.wallFar, 4.9);

    ctx.restore();
  }

  function drawSnow(ctx) {
    if (!snowflakes) initSnow();

    ctx.save();
    ctx.fillStyle = COLORS.snow;

    for (var i = 0; i < snowflakes.length; i++) {
      var f = snowflakes[i];
      ctx.globalAlpha = 0.25 + (f.r / 2.1) * 0.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /** 棋盘外围的冷光，让棋盘像嵌在冰壁里。 */
  function drawBoardGlow(ctx, state) {
    var rect = boardRect(state);

    ctx.save();
    ctx.shadowColor = COLORS.iceGlow;
    ctx.shadowBlur = geom.cell * 1.2;
    ctx.strokeStyle = COLORS.boardRim;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  /**
   * 洞穴背景 + 棋盘外围光晕。在 drawBoard 之前调用。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state
   */
  function drawScene(ctx, state) {
    if (!geom.size) return;

    var grad = ctx.createLinearGradient(0, 0, 0, geom.size);
    grad.addColorStop(0, COLORS.caveTop);
    grad.addColorStop(1, COLORS.caveBottom);

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, geom.size, geom.size);
    ctx.restore();

    drawSnow(ctx);
    drawCaveWalls(ctx);
    drawBoardGlow(ctx, state);
  }

  // ── 冰锥预警 ────────────────────────────────────────────────────────────

  /** 向下指的三角形路径。 */
  function spikePath(ctx, cx, cy, radius) {
    var h = radius * 1.7;   // 三角形总高

    ctx.beginPath();
    ctx.moveTo(cx, cy + h * 0.5);          // 下顶点（锥尖）
    ctx.lineTo(cx - radius, cy - h * 0.5); // 左上
    ctx.lineTo(cx + radius, cy - h * 0.5); // 右上
    ctx.closePath();
  }

  /** 预警下的棋子会完全遮住格心，故把冰锥挪到格子右上角。 */
  function drawSpikeIcon(ctx, state, x, y) {
    var box = cellBox(state, x, y);
    var onStone = B.getCell(state, x, y) !== T.EMPTY;

    ctx.save();

    if (onStone) {
      // 右上角小三角，压在棋子边缘上，保证位置仍然可见
      var r = geom.cell * 0.15;
      var cx = box.cx + geom.cell * 0.29;
      var cy = box.cy - geom.cell * 0.29;

      ctx.globalAlpha = 0.95;
      ctx.fillStyle = COLORS.spikeOnStone;
      spikePath(ctx, cx, cy, r);
      ctx.fill();

      ctx.strokeStyle = COLORS.spike;
      ctx.lineWidth = Math.max(1, geom.cell * 0.035);
      ctx.stroke();
    } else {
      // 空格：格心的大三角
      var radius = geom.cell * 0.2;

      ctx.globalAlpha = 0.72;
      ctx.fillStyle = COLORS.spike;
      spikePath(ctx, box.cx, box.cy, radius);
      ctx.fill();

      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = COLORS.spikeStroke;
      ctx.lineWidth = Math.max(1, geom.cell * 0.03);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 第二层：冰锥预警。在 drawBoard 之后、drawPieces 之前调用。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state
   */
  function drawArena(ctx, state) {
    if (!state || !state.arenaState) return;

    var spikes = Arena.spikeList(state.arenaState);
    if (spikes.length === 0) return;

    ctx.save();
    clipBoard(ctx, state);

    for (var i = 0; i < spikes.length; i++) {
      drawSpikeIcon(ctx, state, spikes[i].x, spikes[i].y);
    }

    ctx.restore();
  }

  // ── 冰块 ────────────────────────────────────────────────────────────────

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /** 角落的剩余回合小点：亮起 turns 个。 */
  function drawIceTurns(ctx, box, turns) {
    var total = T.ARENA.ICE_TURNS;
    var r = Math.max(1, geom.cell * 0.045);
    var gap = r * 2.8;
    var startX = box.x + box.size - r * 1.6 - (total - 1) * gap;
    var cy = box.y + box.size - r * 1.9;

    for (var i = 0; i < total; i++) {
      ctx.beginPath();
      ctx.arc(startX + i * gap, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = i < turns ? COLORS.iceDot : COLORS.iceDotBack;
      ctx.fill();
    }
  }

  function drawIceBlock(ctx, state, x, y, turns) {
    var box = cellBox(state, x, y);
    var pad = Math.max(1.5, geom.cell * 0.06);
    var radius = Math.max(3, geom.cell * 0.2);
    var key = T.cellKey(x, y);
    var born = knockAt[key];

    ctx.save();

    // 刚生成的冰块做一个短促的弹入 + 淡入
    var alpha = 1;

    if (born !== undefined) {
      var age = clock - born;

      if (age < KNOCK_MS) {
        var t = age / KNOCK_MS;
        var scale = 0.72 + 0.28 * (1 - Math.pow(1 - t, 3));  // ease-out 弹入
        var cx = box.cx;
        var cy = box.cy;

        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);

        alpha = 0.55 + 0.45 * t;
      } else {
        delete knockAt[key];
      }
    }

    // 半透明浅蓝圆角矩形
    ctx.globalAlpha = alpha;
    roundRect(ctx, box.x + pad, box.y + pad, box.size - pad * 2, box.size - pad * 2, radius);
    ctx.fillStyle = COLORS.iceFill;
    ctx.fill();

    ctx.strokeStyle = COLORS.iceBorder;
    ctx.lineWidth = Math.max(1, geom.cell * 0.045);
    ctx.stroke();

    // 左上角一道高光，制造冰的通透感
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath();
    ctx.moveTo(box.x + pad * 2.2, box.y + box.size * 0.55);
    ctx.lineTo(box.x + box.size * 0.5, box.y + pad * 2);
    ctx.strokeStyle = COLORS.iceSheen;
    ctx.lineWidth = Math.max(1, geom.cell * 0.06);
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.globalAlpha = alpha;
    drawIceTurns(ctx, box, turns);

    ctx.restore();
  }

  /** 冰锥落下的闪光：扩散的白环 + 中心亮斑，200ms。 */
  function drawDropFlash(ctx, state, x, y) {
    var age = clock - knockAt[T.cellKey(x, y)];
    if (age >= FALL_MS) return;

    var t = age / FALL_MS;
    var box = cellBox(state, x, y);

    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = COLORS.flashRing;
    ctx.lineWidth = Math.max(1, geom.cell * 0.08 * (1 - t));
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, geom.cell * (0.16 + 0.42 * t), 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = (1 - t) * 0.8;
    ctx.fillStyle = COLORS.flash;
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, geom.cell * 0.12 * (1 - t), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 第三层半：冰块覆盖层。在 drawPieces **之后**调用，
   * 这样冰块才能压在棋子上方（棋子已被冰锥摧毁时该格本来就是空的）。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state
   */
  function drawArenaOverlay(ctx, state) {
    if (!state || !state.arenaState) return;

    var blocks = Arena.iceList(state.arenaState);

    ctx.save();
    clipBoard(ctx, state);

    for (var i = 0; i < blocks.length; i++) {
      drawIceBlock(ctx, state, blocks[i].x, blocks[i].y, blocks[i].turns);
    }

    // 闪光画在最上层
    for (var j = 0; j < blocks.length; j++) {
      drawDropFlash(ctx, state, blocks[j].x, blocks[j].y);
    }

    ctx.restore();
  }

  G.Render = G.Render || {};
  G.Render.Arena = {
    COLORS: COLORS,
    configure: configure,
    boardRect: boardRect,
    clipBoard: clipBoard,
    cellBox: cellBox,
    tick: tick,
    notifyDrops: notifyDrops,
    resetEffects: resetEffects,
    drawScene: drawScene,
    drawArena: drawArena,
    drawArenaOverlay: drawArenaOverlay
  };
})();
