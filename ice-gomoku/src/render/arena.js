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
  var River = G.River;

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
    flashRing: 'rgba(160, 215, 255, 0.8)',

    // 河流
    riverShallow: [100, 180, 230],   // 水位 0 时的 RGB
    riverDeep: [60, 130, 200],       // 水位 80% 时的 RGB
    riverAlphaMin: 0.15,
    riverAlphaMax: 0.45,
    riverHeart: 'rgba(190, 235, 255, 0.16)',  // 河心高亮
    riverEdge: 'rgba(120, 190, 235, 0.45)',
    ripple: 'rgba(226, 245, 255, 0.9)',
    rainDrop: 'rgba(196, 232, 255, 0.55)',

    // 水位条
    gaugeTrack: 'rgba(255, 255, 255, 0.14)',
    gaugeLow: '#7ec8f0',
    gaugeMid: '#4a90d9',
    gaugeWarn: '#f0a24a',
    gaugeDanger: '#e8543f',
    gaugeText: 'rgba(214, 234, 248, 0.92)'
  };

  // ── 时间与动画 ──────────────────────────────────────────────────────────
  var FALL_MS = 200;        // 冰锥落下的闪光时长
  var KNOCK_MS = 260;       // 冰块生成动画时长
  var RIPPLE_MS = 520;      // 棋子被冲走的水波时长
  var SNOWFLAKE_COUNT = 44;
  var RAIN_STREAK_COUNT = 26;

  var clock = 0;            // 由 main.js 主循环推进的时钟（毫秒）
  var lastClock = 0;
  var snowflakes = null;    // 延迟初始化，首次绘制时定位

  /** 冰锥落下动画：{ "x,y": 起始时刻 }。只影响绘制，不参与规则。 */
  var knockAt = {};

  /** 棋子被冲走的水波：{ "x,y": 起始时刻 }。只影响绘制。 */
  var rippleAt = {};

  /** 雨丝（相对坐标 0..1，绘制时再换算），延迟初始化。 */
  var rainStreaks = null;

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
    stepRain(dt);
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

  /**
   * 记录被冲走棋子的位置，触发水波动画。
   * 由 main.js 在结算后调用。纯视觉，不影响任何规则。
   * @param {Array<{x:number,y:number}>} washed
   */
  function notifyWashed(washed) {
    if (!washed) return;

    for (var i = 0; i < washed.length; i++) {
      rippleAt[T.cellKey(washed[i].x, washed[i].y)] = clock;
    }
  }

  /** 清空动画痕迹（重开时调用）。 */
  function resetEffects() {
    knockAt = {};
    rippleAt = {};
    snowflakes = null;
    rainStreaks = null;
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

  // ── 山谷溪流 ────────────────────────────────────────────────────────────

  /** 水位（0..80）→ 河流底色。水位越高，蓝色越深。 */
  function riverColor(level) {
    var t = Math.min(1, Math.max(0, level / T.RIVER_MAX_WATER));
    var a = COLORS.riverShallow;
    var b = COLORS.riverDeep;

    return 'rgba(' +
      Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ',' +
      (COLORS.riverAlphaMin + (COLORS.riverAlphaMax - COLORS.riverAlphaMin) * t).toFixed(3) +
      ')';
  }

  /** 河流区域：当前河列的整条纵向带。 */
  function drawRiver(ctx, state) {
    if (!River || !state.arenaState) return;

    var columns = River.getColumns(state.arenaState);
    if (columns.length === 0) return;

    var level = state.arenaState.waterLevel || 0;
    var first = columns[0];
    var last = columns[columns.length - 1];
    var box = cellBox(state, 0, 0);

    var left = box.cx + (first - 0.5) * geom.cell;
    var right = box.cx + (last + 0.5) * geom.cell;
    var top = box.cy - 0.5 * geom.cell;
    var height = (state.size - 1) * geom.cell + geom.cell;

    ctx.save();
    clipBoard(ctx, state);

    // 水带主体
    var grad = ctx.createLinearGradient(left, 0, right, 0);
    var base = riverColor(level);
    grad.addColorStop(0, base);
    grad.addColorStop(0.5, riverColor(Math.min(T.RIVER_MAX_WATER, level + 18)));
    grad.addColorStop(1, base);

    ctx.fillStyle = grad;
    ctx.fillRect(left, top, right - left, height);

    // 河心两列轻微高亮，暗示这里冲走概率最高
    var heartLeft = box.cx + (6 - 0.5) * geom.cell;
    var heartWidth = 2 * geom.cell;

    ctx.fillStyle = COLORS.riverHeart;
    ctx.fillRect(heartLeft, top, heartWidth, height);

    // 水流线：横向细纹，随水位升高而更明显
    ctx.strokeStyle = COLORS.riverEdge;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.25 + 0.4 * (level / T.RIVER_MAX_WATER);

    for (var y = 0; y < state.size; y++) {
      var cy = box.cy + y * geom.cell;
      ctx.beginPath();
      ctx.moveTo(left + 3, cy - geom.cell * 0.22);
      ctx.lineTo(right - 3, cy - geom.cell * 0.22);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** 每格的危险度：以河心为轴的径向渐变，越靠河心越亮。 */
  function drawRiverDanger(ctx, state) {
    if (!River || !state.arenaState) return;

    var level = state.arenaState.waterLevel || 0;
    if (level <= 0) return;

    var box = cellBox(state, 0, 0);
    var heartX = box.cx + T.RIVER_CENTER * geom.cell;

    ctx.save();
    clipBoard(ctx, state);

    var grad = ctx.createRadialGradient(
      heartX, box.cy, geom.cell * 0.5,
      heartX, box.cy, geom.cell * 5.2
    );
    grad.addColorStop(0, 'rgba(210, 245, 255, ' + (0.16 * (level / T.RIVER_MAX_WATER)).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(210, 245, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(
      box.cx - geom.cell, box.cy - geom.cell,
      (state.size + 1) * geom.cell, (state.size + 1) * geom.cell
    );

    ctx.restore();
  }

  /** 雨丝：水位 > 0 时在河流带内画斜线。 */
  function initRain() {
    rainStreaks = [];

    for (var i = 0; i < RAIN_STREAK_COUNT; i++) {
      rainStreaks.push({
        u: Math.random(),              // 横向相对位置 0..1
        y: Math.random(),              // 纵向起始位置 0..1
        len: 0.05 + Math.random() * 0.06,
        speed: 0.55 + Math.random() * 0.8
      });
    }
  }

  function stepRain(dt) {
    if (!rainStreaks) return;

    var seconds = dt / 1000;

    for (var i = 0; i < rainStreaks.length; i++) {
      var s = rainStreaks[i];
      s.y += s.speed * seconds * 0.9;
      if (s.y > 1.05) s.y -= 1.1;
    }
  }

  function drawRain(ctx, state) {
    if (!River || !state.arenaState) return;

    var level = state.arenaState.waterLevel || 0;
    if (level <= 0) return;

    if (!rainStreaks) initRain();

    var columns = River.getColumns(state.arenaState);
    if (columns.length === 0) return;

    var box = cellBox(state, 0, 0);
    var left = box.cx + (columns[0] - 0.5) * geom.cell;
    var right = box.cx + (columns[columns.length - 1] + 0.5) * geom.cell;
    var top = box.cy - 0.5 * geom.cell;
    var height = (state.size - 1) * geom.cell + geom.cell;

    ctx.save();
    clipBoard(ctx, state);
    ctx.strokeStyle = COLORS.rainDrop;
    ctx.lineWidth = 1;
    ctx.globalAlpha = Math.min(1, 0.3 + level / T.RIVER_MAX_WATER);

    for (var i = 0; i < rainStreaks.length; i++) {
      var s = rainStreaks[i];
      var x = left + (right - left) * s.u;
      var y = top + height * s.y;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 3, y + height * s.len);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** 棋子被冲走的水波：扩散圆圈 + 两点飞溅。 */
  function drawRipples(ctx, state) {
    var key;

    ctx.save();
    clipBoard(ctx, state);

    for (key in rippleAt) {
      if (!Object.prototype.hasOwnProperty.call(rippleAt, key)) continue;

      var age = clock - rippleAt[key];
      if (age >= RIPPLE_MS) { delete rippleAt[key]; continue; }

      var parts = key.split(',');
      var box = cellBox(state, parseInt(parts[0], 10), parseInt(parts[1], 10));
      var t = age / RIPPLE_MS;

      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = COLORS.ripple;
      ctx.lineWidth = Math.max(1, geom.cell * 0.06 * (1 - t));
      ctx.beginPath();
      ctx.arc(box.cx, box.cy, geom.cell * (0.15 + 0.5 * t), 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.fillStyle = COLORS.ripple;
      for (var k = 0; k < 2; k++) {
        var ang = -Math.PI / 2 + (k === 0 ? -1 : 1) * 0.5;
        var d = geom.cell * (0.2 + 0.55 * t);
        ctx.beginPath();
        ctx.arc(box.cx + Math.cos(ang) * d, box.cy + Math.sin(ang) * d,
          Math.max(1, geom.cell * 0.05 * (1 - t)), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // ── 水位指示条 ──────────────────────────────────────────────────────────

  /** 水位越高颜色越警示：<60 蓝、≥60 橙、=80 红。 */
  function gaugeColor(level) {
    if (level >= T.RIVER_MAX_WATER) return COLORS.gaugeDanger;
    if (level >= 60) return COLORS.gaugeWarn;
    if (level >= 30) return COLORS.gaugeMid;
    return COLORS.gaugeLow;
  }

  /**
   * 在棋盘下方留白处画水位进度条 + 文字。
   * 只占 margin 区域，不挤压棋盘。
   */
  function drawWaterGauge(ctx, state) {
    if (!River || !state.arenaState) return;

    var level = state.arenaState.waterLevel || 0;
    var t = level / T.RIVER_MAX_WATER;

    var x = geom.origin;
    var width = (state.size - 1) * geom.cell;
    var height = Math.max(5, geom.cell * 0.16);
    var y = geom.origin + (state.size - 1) * geom.cell + Math.max(9, geom.margin * 0.32);

    ctx.save();

    // 轨道
    roundRect(ctx, x, y, width, height, height / 2);
    ctx.fillStyle = COLORS.gaugeTrack;
    ctx.fill();

    // 已蓄水量
    if (t > 0) {
      var grad = ctx.createLinearGradient(x, 0, x + width, 0);
      grad.addColorStop(0, COLORS.gaugeLow);
      grad.addColorStop(1, gaugeColor(level));

      roundRect(ctx, x, y, Math.max(height, width * t), height, height / 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // 30 / 60 阈值刻度
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    var marks = [T.RIVER_EXPANSIONS[0].level, T.RIVER_EXPANSIONS[1].level];

    for (var i = 0; i < marks.length; i++) {
      var mx = x + width * (marks[i] / T.RIVER_MAX_WATER);
      ctx.beginPath();
      ctx.moveTo(mx, y - 3);
      ctx.lineTo(mx, y + height + 3);
      ctx.stroke();
    }

    // 文字
    ctx.fillStyle = COLORS.gaugeText;
    ctx.font = '600 ' + Math.max(11, Math.round(geom.cell * 0.3)) +
      'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('水位 ' + level + '%', x + width, y - height);

    ctx.restore();
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
   * 第二层：场地覆盖物。在 drawBoard 之后、drawPieces 之前调用。
   *
   * 按场地类型分派：
   *   arenaState.spikes 存在  → 雪山洞穴：画冰锥预警
   *   arenaState.riverColumns 存在 → 山谷溪流：画河流、危险度、雨丝
   *   arenaState 为 null      → 经典模式：什么都不画
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state
   */
  function drawArena(ctx, state) {
    // 经典模式没有场地：arenaState 为 null，直接不画任何东西
    if (!state || !state.arenaState) return;

    // 山谷溪流
    if (state.arenaState.riverColumns) {
      drawRiver(ctx, state);
      drawRiverDanger(ctx, state);
      drawRain(ctx, state);
      return;
    }

    // 雪山洞穴：冰锥预警
    if (state.arenaState.spikes) {
      var spikes = Arena.spikeList(state.arenaState);
      if (spikes.length === 0) return;

      ctx.save();
      clipBoard(ctx, state);

      for (var i = 0; i < spikes.length; i++) {
        drawSpikeIcon(ctx, state, spikes[i].x, spikes[i].y);
      }

      ctx.restore();
    }
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

    // 山谷溪流：水波画在棋子上方，最后叠加水位条
    if (state.arenaState.riverColumns) {
      drawRipples(ctx, state);
      drawWaterGauge(ctx, state);
      return;
    }

    // 雪山洞穴：冰块必须压在棋子上方
    if (!state.arenaState.iceBlocks) return;

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
    notifyWashed: notifyWashed,
    resetEffects: resetEffects,
    drawScene: drawScene,
    drawArena: drawArena,
    drawArenaOverlay: drawArenaOverlay
  };
})();
