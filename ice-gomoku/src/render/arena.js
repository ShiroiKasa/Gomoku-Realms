/**
 * 五子奇境 · 各场地覆盖物绘制（冰锥 / 河流 / 雷区）
 *
 * 绘制时机（由 main.js 的 render() 依次调用）：
 *   drawArena         —— 场地覆盖物：冰锥预警 / 河流 / 雷区底盘（棋子之下）
 *   drawMinePreview   —— 雷区悬停的 3×3 爆炸范围（棋子之上）
 *   drawArenaOverlay  —— 冰块 / 水波 / 水位条 / 雷区数字 / 爆炸闪光（棋子之上）
 *
 * 场景背景与氛围层在 render/scene.js（按模式主题），石板在 render/board.js。
 * 本文件只读 state 与 state.arenaState，不改任何状态；规则结算在 core/ 各自的文件里。
 * 与棋盘共用的几何（石板矩形 / 圆角）走 render/art.js，河流淡出的两端色值走
 * render/theme.js 的石板配色，杜绝两处各写一份导致淡出露接缝（历史坑）。
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
  var Mine = G.Mine;
  var Art = G.Render.Art;
  var Theme = G.Render.Theme;

  // ── 几何参数（由 configure 写入）──────────────────────────────────────────
  var geom = {
    size: 0,
    margin: 0,
    origin: 0,
    cell: 0,
    dpr: 1
  };

  var COLORS = {
    // 冰锥预警
    spike: '#4A90D9',
    spikeSheen: 'rgba(232, 248, 255, 0.85)',
    spikeOnStone: 'rgba(178, 224, 255, 0.95)',
    spikeRing: 'rgba(146, 206, 244, 0.5)',

    // 冰块
    iceFillTop: 'rgba(228, 246, 255, 0.82)',
    iceFillMid: 'rgba(160, 215, 250, 0.62)',
    iceFillDeep: 'rgba(108, 175, 225, 0.62)',
    iceBorder: '#a8dcf6',
    iceSheen: 'rgba(255, 255, 255, 0.7)',
    iceCrack: 'rgba(255, 255, 255, 0.45)',
    iceDot: 'rgba(46, 110, 158, 0.9)',
    iceDotBack: 'rgba(255, 255, 255, 0.45)',

    // 冰锥落下的闪光
    flash: 'rgba(255, 255, 255, 0.92)',
    flashRing: 'rgba(166, 218, 255, 0.85)',

    // 河流
    riverShallow: [104, 186, 234],   // 水位 0 时的 RGB
    riverDeep: [46, 112, 182],       // 水位 80% 时的 RGB
    riverAlphaMin: 0.18,
    riverAlphaMax: 0.5,
    riverHeart: 'rgba(198, 240, 255, 0.16)',  // 河心高亮
    riverBank: 'rgba(206, 240, 255, 0.4)',
    current: 'rgba(222, 244, 255, 0.85)',
    ripple: 'rgba(230, 246, 255, 0.9)',
    rainDrop: 'rgba(198, 234, 255, 0.6)',

    // 水位条
    gaugeTrack: 'rgba(8, 22, 34, 0.5)',
    gaugeEdge: 'rgba(158, 216, 255, 0.3)',
    gaugeLow: '#7ec8f0',
    gaugeMid: '#4a90d9',
    gaugeWarn: '#f0a24a',
    gaugeDanger: '#e8543f',
    gaugeText: 'rgba(240, 250, 255, 0.95)',

    // 雷区
    mineRing: '#E0645F',
    mineRingHot: '#FF6B5A',
    mineCore: 'rgba(201, 48, 44, 0.32)',
    mineCoreHot: 'rgba(226, 62, 48, 0.5)',
    mineGlow: 'rgba(228, 74, 58, 0.30)',
    mineText: '#FFF3F2',
    mineTextHot: '#FFD9D6',
    minePreview: 'rgba(217, 83, 79, 0.16)',
    minePreviewEdge: 'rgba(240, 120, 100, 0.7)',
    blast: 'rgba(255, 238, 214, 0.95)',
    blastRing: 'rgba(255, 168, 96, 0.9)',
    blastSpark: 'rgba(255, 196, 130, 0.9)'
  };

  // ── 时间与动画 ──────────────────────────────────────────────────────────
  var FALL_MS = 220;        // 冰锥落下的闪光时长
  var KNOCK_MS = 260;       // 冰块生成动画时长
  var RIPPLE_MS = 560;      // 棋子被冲走的水波时长
  var BLAST_MS = 300;       // 雷区爆炸的闪光时长
  var MINE_BLINK_MS = 420;  // 倒计时紧迫时的闪烁周期
  var RAIN_STREAK_COUNT = 30;

  var clock = 0;            // 由 main.js 主循环推进的时钟（毫秒）
  var lastClock = 0;
  var rainStreaks = null;   // 雨丝（河流带内）

  /** 冰锥落下动画：{ "x,y": 起始时刻 }。只影响绘制，不参与规则。 */
  var knockAt = {};

  /** 棋子被冲走的水波：{ "x,y": 起始时刻 }。只影响绘制。 */
  var rippleAt = {};

  /** 雷区爆炸的闪光：{ "x,y": 起始时刻 }。只影响绘制。 */
  var blastAt = {};

  // ── 配置 ────────────────────────────────────────────────────────────────

  function configure(size, margin, dpr) {
    geom.size = size;
    geom.margin = margin;
    geom.origin = margin;
    geom.dpr = dpr > 0 ? dpr : 1;

    // 先按默认路数算一次格距：configure 之后、首次绘制之前也可能被问到坐标
    // （boardRect / cellBox），此时 geom.cell 不能是 0。
    geom.cell = (size - margin * 2) / (T.DEFAULT_SIZE - 1);
  }

  /** 取当前对局的路数，并据此更新格距（与 render/board.js 保持一致）。 */
  function gridSizeOf(state) {
    var n = state && state.size ? state.size : T.DEFAULT_SIZE;
    geom.cell = (geom.size - geom.margin * 2) / (n - 1);
    return n;
  }

  /** 返回石板区域（CSS 像素）。与 render/board.js 的 slabRect 同口径。 */
  function boardRect(state) {
    return Art.boardRectOf(geom, gridSizeOf(state));
  }

  /** 把后续绘制裁剪进石板（含圆角，避免河流等溢出石板切角）。 */
  function clipBoard(ctx, state) {
    var rect = boardRect(state);
    Art.clipRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, Art.slabRadiusOf(geom));
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
   * 推进本模块的动画时钟（水波、爆炸余晖、紧迫闪烁都按它衰减）。
   * @param {number} nowMs 来自 performance.now() / rAF 的时间戳
   */
  function tick(nowMs) {
    if (lastClock === 0) lastClock = nowMs;

    var dt = Math.max(0, nowMs - lastClock);
    lastClock = nowMs;
    clock += dt;

    stepRain(dt);
  }

  /**
   * 记录冰锥落下的位置，触发闪光 + 冰块生成动画。
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

  /**
   * 记录雷区爆炸波及的格子，触发闪光。
   * 由 main.js 在结算后调用。纯视觉，不影响任何规则。
   * @param {Array<{x:number,y:number}>} cells
   */
  function notifyBlasts(cells) {
    if (!cells) return;

    for (var i = 0; i < cells.length; i++) {
      blastAt[T.cellKey(cells[i].x, cells[i].y)] = clock;
    }
  }

  /** 清空动画痕迹（重开时调用）。 */
  function resetEffects() {
    knockAt = {};
    rippleAt = {};
    blastAt = {};
    rainStreaks = null;
    lastClock = clock;
  }

  // ── 山谷溪流 ────────────────────────────────────────────────────────────

  /** 水位（0..80）→ 河流底色。水位越高，蓝色越深。 */
  function riverColor(level) {
    var t = Art.clamp(level / T.RIVER_MAX_WATER, 0, 1);
    var rgb = Art.mixRgb(COLORS.riverShallow, COLORS.riverDeep, t);
    var alpha = COLORS.riverAlphaMin +
      (COLORS.riverAlphaMax - COLORS.riverAlphaMin) * t;

    return Art.rgba(rgb, alpha.toFixed(3));
  }

  /**
   * 河流的横向边界（CSS 像素）。
   * 河流纵向铺满整块石板——它是一条穿过画面的河，不该在首尾两行处截断。
   */
  function riverBounds(state) {
    var columns = River.getColumns(state.arenaState);
    var box = cellBox(state, 0, 0);

    return {
      columns: columns,
      left: box.cx + (columns[0] - 0.5) * geom.cell,
      right: box.cx + (columns[columns.length - 1] + 0.5) * geom.cell
    };
  }

  /** 河流区域：当前河列的整条纵向带 + 由水位驱动的流动水纹。 */
  function drawRiver(ctx, state) {
    if (!River || !state.arenaState) return;

    var level = state.arenaState.waterLevel || 0;
    var bounds = riverBounds(state);
    var rect = boardRect(state);

    if (bounds.columns.length === 0) return;

    var width = bounds.right - bounds.left;

    ctx.save();

    // 横向渐变：两岸略深、中间提亮，让水面有体积感
    var base = riverColor(level);
    var grad = ctx.createLinearGradient(bounds.left, 0, bounds.right, 0);
    grad.addColorStop(0, base);
    grad.addColorStop(0.5, riverColor(Math.min(T.RIVER_MAX_WATER, level + 18)));
    grad.addColorStop(1, base);

    ctx.fillStyle = grad;
    ctx.fillRect(bounds.left, rect.y, width, rect.height);

    // 纵向收尾：首尾各淡出一段，与石板面色融合（两端色值取自当前主题的石板配色）
    var slab = Theme.get(Theme.idOf(state)).slab;
    var fade = Math.min(rect.height * 0.24, geom.margin * 1.2);
    var fadeGrad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
    fadeGrad.addColorStop(0, Art.rgba(slab.topRgb, 1));
    fadeGrad.addColorStop(fade / rect.height, Art.rgba(slab.topRgb, 0));
    fadeGrad.addColorStop(1 - fade / rect.height, Art.rgba(slab.bottomRgb, 0));
    fadeGrad.addColorStop(1, Art.rgba(slab.bottomRgb, 1));

    ctx.fillStyle = fadeGrad;
    ctx.fillRect(bounds.left, rect.y, width, rect.height);

    // 河心两列轻微高亮，暗示这里冲走概率最高
    var box = cellBox(state, 0, 0);
    var heartLeft = box.cx + (6 - 0.5) * geom.cell;
    ctx.fillStyle = COLORS.riverHeart;
    ctx.fillRect(heartLeft, rect.y, 2 * geom.cell, rect.height);

    // 两岸的一线亮边
    ctx.strokeStyle = COLORS.riverBank;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(bounds.left + 0.75, rect.y);
    ctx.lineTo(bounds.left + 0.75, rect.y + rect.height);
    ctx.moveTo(bounds.right - 0.75, rect.y);
    ctx.lineTo(bounds.right - 0.75, rect.y + rect.height);
    ctx.stroke();

    // 流动水纹：随水位变密变亮，并随时间纵向滚动
    var lineCount = 16;
    var drift = (clock / 4200) % 1;

    ctx.strokeStyle = COLORS.current;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';

    for (var i = 0; i < lineCount; i++) {
      var t = (i / lineCount + drift) % 1;
      var y = rect.y + t * rect.height;
      var shape = Math.sin(t * Math.PI);

      ctx.globalAlpha = (0.06 + 0.3 * (level / T.RIVER_MAX_WATER)) * shape;

      ctx.beginPath();
      for (var px = bounds.left; px <= bounds.right + 0.1; px += 6) {
        var k = (px - bounds.left) / Math.max(1, width);
        var wave = Math.sin(k * 7.5 + clock / 640 + i * 0.9) * geom.cell * 0.055;

        if (px === bounds.left) ctx.moveTo(px, y + wave);
        else ctx.lineTo(px, y + wave);
      }
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
    var rect = boardRect(state);
    var heartX = box.cx + T.RIVER_CENTER * geom.cell;

    ctx.save();
    clipBoard(ctx, state);

    var grad = ctx.createRadialGradient(
      heartX, rect.y + rect.height / 2, geom.cell * 0.5,
      heartX, rect.y + rect.height / 2, rect.width * 0.42
    );
    grad.addColorStop(0, 'rgba(210, 245, 255, ' + (0.16 * (level / T.RIVER_MAX_WATER)).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(210, 245, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.restore();
  }

  /** 雨丝：水位 > 0 时在河流带内画斜线。 */
  function initRain() {
    rainStreaks = [];

    for (var i = 0; i < RAIN_STREAK_COUNT; i++) {
      rainStreaks.push({
        u: Math.random(),              // 横向相对位置 0..1
        y: Math.random(),              // 纵向起始位置 0..1
        len: 0.05 + Math.random() * 0.07,
        speed: 0.55 + Math.random() * 0.8,
        alpha: 0.5 + Math.random() * 0.5
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

    var bounds = riverBounds(state);
    var rect = boardRect(state);
    if (bounds.columns.length === 0) return;

    var fade = Math.min(rect.height * 0.24, geom.margin * 1.2);
    var top = rect.y + fade * 0.6;
    var height = rect.height - fade * 1.2;
    var lean = 3 + level * 0.05;

    ctx.save();
    clipBoard(ctx, state);
    ctx.strokeStyle = COLORS.rainDrop;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    for (var i = 0; i < rainStreaks.length; i++) {
      var s = rainStreaks[i];
      var x = bounds.left + (bounds.right - bounds.left) * s.u;
      var y = top + height * s.y;

      ctx.globalAlpha = Math.min(1, (0.32 + level / T.RIVER_MAX_WATER * 0.9) * s.alpha);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - lean, y + height * s.len);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** 棋子被冲走的水波：两道扩散圆环 + 四点飞溅。 */
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

      // 两道错开的圆环
      ctx.strokeStyle = COLORS.ripple;

      for (var ring = 0; ring < 2; ring++) {
        var rt = Art.clamp(t - ring * 0.16, 0, 1);
        if (rt <= 0) continue;

        ctx.globalAlpha = (1 - rt) * 0.75;
        ctx.lineWidth = Math.max(1, geom.cell * 0.055 * (1 - rt));
        ctx.beginPath();
        ctx.arc(box.cx, box.cy, geom.cell * (0.14 + 0.52 * rt), 0, Math.PI * 2);
        ctx.stroke();
      }

      // 飞溅水珠
      ctx.fillStyle = COLORS.ripple;

      for (var k = 0; k < 4; k++) {
        var ang = -Math.PI / 2 + (k - 1.5) * 0.62;
        var d = geom.cell * (0.2 + 0.62 * t);

        ctx.globalAlpha = (1 - t) * 0.65;
        ctx.beginPath();
        ctx.arc(
          box.cx + Math.cos(ang) * d,
          box.cy + Math.sin(ang) * d * 0.8,
          Math.max(1, geom.cell * 0.045 * (1 - t)), 0, Math.PI * 2
        );
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
   * 石板下方留白处的水位胶囊条：刻度、填充与读数都压在条内。
   * 只占边框区域，不挤压棋盘。
   */
  function drawWaterGauge(ctx, state) {
    if (!River || !state.arenaState) return;

    var level = state.arenaState.waterLevel || 0;
    var t = Art.clamp(level / T.RIVER_MAX_WATER, 0, 1);
    var rect = boardRect(state);
    var band = Art.clamp(geom.size - (rect.y + rect.height), 10, geom.margin);
    var height = Art.clamp(band * 0.56, 11, 17);
    var x = rect.x;
    var width = rect.width;
    var y = rect.y + rect.height + (band - height) / 2;

    ctx.save();

    // 轨道
    Art.roundRectPath(ctx, x, y, width, height, height / 2);
    ctx.fillStyle = COLORS.gaugeTrack;
    ctx.fill();
    ctx.strokeStyle = COLORS.gaugeEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 已蓄水量
    if (t > 0.001) {
      var grad = ctx.createLinearGradient(x, 0, x + width, 0);
      grad.addColorStop(0, COLORS.gaugeLow);
      grad.addColorStop(1, gaugeColor(level));

      ctx.save();
      Art.roundRectPath(ctx, x, y, width, height, height / 2);
      ctx.clip();

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(height * 0.6, width * t), height);

      // 水面的一线高光 + 缓慢流动的光泽
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillRect(x, y + 1, Math.max(height * 0.6, width * t), Math.max(1, height * 0.22));

      var shineX = x + ((clock / 26) % (width + 160)) - 80;
      var shine = ctx.createLinearGradient(shineX - 60, 0, shineX + 60, 0);
      shine.addColorStop(0, 'rgba(255, 255, 255, 0)');
      shine.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
      shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = shine;
      ctx.fillRect(x, y, width, height);
      ctx.restore();
    }

    // 30 / 60 阈值刻度
    var marks = [T.RIVER_EXPANSIONS[0].level, T.RIVER_EXPANSIONS[1].level];

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;

    for (var i = 0; i < marks.length; i++) {
      var mx = x + width * (marks[i] / T.RIVER_MAX_WATER);
      ctx.beginPath();
      ctx.moveTo(mx, y);
      ctx.lineTo(mx, y + height);
      ctx.stroke();
    }

    // 读数：压在胶囊条正中，深色描边保证在浅色填充上也读得清
    ctx.font = '700 ' + Math.max(10, Math.round(height * 0.82)) +
      'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, height * 0.22);
    ctx.strokeStyle = 'rgba(6, 20, 32, 0.7)';
    ctx.strokeText('水位 ' + level + '%', x + width / 2, y + height / 2 + 0.5);
    ctx.fillStyle = COLORS.gaugeText;
    ctx.fillText('水位 ' + level + '%', x + width / 2, y + height / 2 + 0.5);

    ctx.restore();
  }

  // ── 危险雷区 ────────────────────────────────────────────────────────────

  /** 倒计时紧迫度：≤3 视为即将爆炸，需要闪烁与加粗。 */
  function mineIsUrgent(turns) {
    return turns <= 3;
  }

  /**
   * 雷区底盘：警戒环 + 罗盘刻线 + 淡红填充。画在棋子**之下**。
   */
  function drawMineMarker(ctx, state, x, y, turns) {
    var box = cellBox(state, x, y);
    var urgent = mineIsUrgent(turns);
    var radius = geom.cell * 0.4;
    var phase = (clock % MINE_BLINK_MS) / MINE_BLINK_MS;
    var pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    var alpha = urgent ? 0.6 + 0.4 * pulse : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 底盘辉光
    Art.softEllipse(ctx, box.cx, box.cy, radius * 1.5, radius * 1.5,
      urgent ? 'rgba(255, 96, 72, 0.34)' : COLORS.mineGlow, 'rgba(255, 96, 72, 0)');

    // 填充圆
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = urgent ? COLORS.mineCoreHot : COLORS.mineCore;
    ctx.fill();

    // 四道罗盘刻线
    ctx.strokeStyle = urgent ? COLORS.mineRingHot : COLORS.mineRing;
    ctx.lineWidth = Math.max(1, geom.cell * 0.035);
    ctx.lineCap = 'round';

    for (var k = 0; k < 4; k++) {
      var a = Math.PI / 4 + k * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(box.cx + Math.cos(a) * radius * 0.72, box.cy + Math.sin(a) * radius * 0.72);
      ctx.lineTo(box.cx + Math.cos(a) * radius * 0.98, box.cy + Math.sin(a) * radius * 0.98);
      ctx.stroke();
    }

    // 虚线警戒环（紧迫时缓慢自转）
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, radius, 0, Math.PI * 2);
    ctx.setLineDash([Math.max(3, geom.cell * 0.15), Math.max(2, geom.cell * 0.1)]);
    ctx.lineDashOffset = urgent ? -(clock / 1000) * geom.cell * 0.6 : 0;
    ctx.strokeStyle = urgent ? COLORS.mineRingHot : COLORS.mineRing;
    ctx.lineWidth = Math.max(2, geom.cell * (urgent ? 0.09 : 0.06));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 紧迫时向外扫出的声呐环
    if (urgent) {
      var sonar = (clock % MINE_BLINK_MS) / MINE_BLINK_MS;
      ctx.globalAlpha = (1 - sonar) * 0.5;
      ctx.strokeStyle = COLORS.mineRingHot;
      ctx.lineWidth = Math.max(1, geom.cell * 0.03);
      ctx.beginPath();
      ctx.arc(box.cx, box.cy, radius * (1 + sonar * 0.7), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 倒计时数字。画在棋子**之上**，否则有棋子的格子会把数字盖住。
   * 白字加深色描边，保证在黑子与白子上都读得清。
   */
  function drawMineNumbers(ctx, state) {
    if (!Mine || !state.arenaState || !state.arenaState.mines) return;

    var mines = Mine.mineList(state.arenaState);
    if (mines.length === 0) return;

    ctx.save();
    clipBoard(ctx, state);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var i = 0; i < mines.length; i++) {
      var box = cellBox(state, mines[i].x, mines[i].y);
      var urgent = mineIsUrgent(mines[i].turns);
      var alpha = 1;
      var scale = 1;

      if (urgent) {
        var phase = (clock % MINE_BLINK_MS) / MINE_BLINK_MS;
        var pulse = Math.abs(Math.sin(phase * Math.PI));
        alpha = 0.62 + 0.38 * pulse;
        scale = 1 + 0.08 * pulse;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(box.cx, box.cy);
      ctx.scale(scale, scale);
      ctx.font = '700 ' + Math.max(12, Math.round(geom.cell * 0.42)) +
        'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

      // 描边保证在黑白棋子上都可读
      ctx.lineWidth = Math.max(2, geom.cell * 0.11);
      ctx.strokeStyle = 'rgba(28, 8, 8, 0.85)';
      ctx.strokeText(String(mines[i].turns), 0, 0.5);

      ctx.fillStyle = urgent ? COLORS.mineTextHot : COLORS.mineText;
      ctx.fillText(String(mines[i].turns), 0, 0.5);

      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * 爆炸表现：中心亮斑 → 扩散冲击环 → 四散的余烬。
   * 只对「本帧仍在攻击范围内」的格子生效——规则层已把雷区删除，
   * 这里靠 blastAt 记录的时间戳在之后若干帧内继续画余晖。
   */
  function drawBlastFlashes(ctx, state) {
    var key;

    ctx.save();
    clipBoard(ctx, state);

    for (key in blastAt) {
      if (!Object.prototype.hasOwnProperty.call(blastAt, key)) continue;

      var age = clock - blastAt[key];
      if (age >= BLAST_MS) { delete blastAt[key]; continue; }

      var parts = key.split(',');
      var box = cellBox(state, parseInt(parts[0], 10), parseInt(parts[1], 10));
      var t = age / BLAST_MS;
      var seed = Art.hash01(parseInt(parts[0], 10) + 1, parseInt(parts[1], 10) + 1);

      // 中心亮斑
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.fillStyle = COLORS.blast;
      ctx.beginPath();
      ctx.arc(box.cx, box.cy, geom.cell * 0.46 * (1 - t * 0.7), 0, Math.PI * 2);
      ctx.fill();

      // 扩散环
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = COLORS.blastRing;
      ctx.lineWidth = Math.max(1, geom.cell * 0.08 * (1 - t));
      ctx.beginPath();
      ctx.arc(box.cx, box.cy, geom.cell * (0.2 + 0.66 * t), 0, Math.PI * 2);
      ctx.stroke();

      // 余烬：八条向外飞的短线
      ctx.strokeStyle = COLORS.blastSpark;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, geom.cell * 0.05 * (1 - t));

      for (var s = 0; s < 8; s++) {
        var a = (s / 8) * Math.PI * 2 + seed * 3;
        var d0 = geom.cell * (0.22 + 0.5 * t);
        var d1 = d0 + geom.cell * 0.2 * (1 - t);

        ctx.globalAlpha = (1 - t) * 0.75;
        ctx.beginPath();
        ctx.moveTo(box.cx + Math.cos(a) * d0, box.cy + Math.sin(a) * d0);
        ctx.lineTo(box.cx + Math.cos(a) * d1, box.cy + Math.sin(a) * d1);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * 悬停预览：鼠标停在雷区格上时，淡淡的红雾 + 四角准星标出 3×3 爆炸范围。
   * 纯提示，不影响规则。
   */
  function drawMinePreview(ctx, state, ghost) {
    if (!Mine || !state.arenaState) return;
    if (!ghost || ghost.x === undefined) return;

    // 只有悬停在雷区上才预览
    if (!Mine.hasMine(state.arenaState, ghost.x, ghost.y)) return;

    var radius = T.MINE_BLAST_RADIUS;
    var x0 = ghost.x - radius;
    var y0 = ghost.y - radius;
    var x1 = ghost.x + radius;
    var y1 = ghost.y + radius;
    var breathe = 0.5 + 0.5 * Math.sin(clock / 260);

    ctx.save();
    clipBoard(ctx, state);

    // 红雾
    for (var yy = y0; yy <= y1; yy++) {
      for (var xx = x0; xx <= x1; xx++) {
        if (!B.isInside(state, xx, yy)) continue;

        var box = cellBox(state, xx, yy);
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.minePreview;
        ctx.fillRect(box.x, box.y, box.size, box.size);
      }
    }

    // 四角准星：只画范围内侧的那一段
    var first = cellBox(state, Math.max(0, x0), Math.max(0, y0));
    var last = cellBox(
      state,
      Math.min(state.size - 1, x1),
      Math.min(state.size - 1, y1)
    );
    var bx = first.x;
    var by = first.y;
    var bw = last.x + last.size - bx;
    var bh = last.y + last.size - by;
    var arm = geom.cell * 0.45;

    ctx.globalAlpha = 0.5 + 0.35 * breathe;
    ctx.strokeStyle = COLORS.minePreviewEdge;
    ctx.lineWidth = Math.max(1.5, geom.cell * 0.07);
    ctx.lineCap = 'round';

    var corners = [
      [bx, by, 1, 1],
      [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1],
      [bx + bw, by + bh, -1, -1]
    ];

    for (var c = 0; c < corners.length; c++) {
      var p = corners[c];

      ctx.beginPath();
      ctx.moveTo(p[0] + p[2] * arm, p[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.lineTo(p[0], p[1] + p[3] * arm);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── 冰锥预警 ────────────────────────────────────────────────────────────

  /** 向下 / 向上的冰锥路径。dir = 1 向下（挂顶），-1 向上（长在底部）。 */
  function shardPath(ctx, cx, baseY, width, height, lean, dir) {
    var half = width / 2;
    var tipY = baseY + height * dir;

    ctx.beginPath();
    ctx.moveTo(cx - half, baseY);
    ctx.quadraticCurveTo(cx - half * 0.55, baseY + height * 0.45 * dir, cx + lean, tipY);
    ctx.quadraticCurveTo(cx + half * 0.55, baseY + height * 0.45 * dir, cx + half, baseY);
    ctx.closePath();
  }

  /** 预警下的棋子会完全遮住格心，故把冰锥缩小挪到格子右上角。 */
  function drawSpikeOnStone(ctx, state, x, y) {
    var box = cellBox(state, x, y);
    var r = geom.cell * 0.17;
    var cx = box.cx + geom.cell * 0.3;
    var cy = box.cy - geom.cell * 0.31;

    ctx.save();
    ctx.globalAlpha = 0.95;

    // 轻微的冷光，让冰锥与棋子分得开（不能太重，否则黑子上会糊成灰斑）
    Art.softEllipse(ctx, cx, cy + r * 1.1, r * 1.25, r * 1.0,
      'rgba(150, 205, 250, 0.22)', 'rgba(150, 205, 250, 0)');

    var body = ctx.createLinearGradient(0, cy - r * 1.2, 0, cy + r * 1.2);
    body.addColorStop(0, 'rgba(216, 240, 255, 0.98)');
    body.addColorStop(1, 'rgba(96, 168, 224, 0.98)');

    ctx.fillStyle = body;
    shardPath(ctx, cx, cy - r * 1.1, r * 1.6, r * 2.1, 0, 1);
    ctx.fill();

    ctx.strokeStyle = COLORS.spike;
    ctx.lineWidth = Math.max(1, geom.cell * 0.035);
    ctx.stroke();
    ctx.restore();
  }

  /** 空格上的预警：警示虚线圈 + 轻轻悬浮的冰锥，暗示「随时会落下」。 */
  function drawSpikeOnEmpty(ctx, state, x, y) {
    var box = cellBox(state, x, y);
    var seed = Art.hash01(x + 3, y + 7);
    var float = Math.sin(clock / 900 + seed * Math.PI * 2) * geom.cell * 0.055;
    var h = geom.cell * 0.62;
    var w = geom.cell * 0.34;
    var topY = box.cy - h * 0.52 + float;

    ctx.save();

    // 落点的冷光：先铺一层光，冰锥才「浮」得起来
    Art.softEllipse(ctx, box.cx, box.cy, geom.cell * 0.52, geom.cell * 0.52,
      'rgba(140, 205, 250, 0.34)', 'rgba(140, 205, 250, 0)');

    // 警示虚线圈：说明落点就是格心
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([Math.max(2.5, geom.cell * 0.11), Math.max(2.5, geom.cell * 0.13)]);
    ctx.lineDashOffset = -(clock / 42) % 1000;
    ctx.strokeStyle = COLORS.spikeRing;
    ctx.lineWidth = Math.max(1, geom.cell * 0.03);
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, geom.cell * 0.44, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 悬浮冰锥（底边在上、锥尖朝下）
    var body = ctx.createLinearGradient(0, topY, 0, topY + h);
    body.addColorStop(0, 'rgba(196, 232, 255, 0.95)');
    body.addColorStop(0.45, 'rgba(126, 190, 238, 0.95)');
    body.addColorStop(1, 'rgba(74, 144, 217, 0.95)');

    ctx.globalAlpha = 1;
    shardPath(ctx, box.cx, topY, w, h, 0, 1);
    ctx.fillStyle = body;
    ctx.fill();

    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = COLORS.spikeSheen;
    ctx.lineWidth = Math.max(1, geom.cell * 0.032);
    ctx.stroke();

    // 左侧亮面：做出冰的通透
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = COLORS.spikeSheen;
    ctx.lineWidth = Math.max(1, geom.cell * 0.028);
    ctx.beginPath();
    ctx.moveTo(box.cx - w * 0.3, topY + h * 0.1);
    ctx.lineTo(box.cx - w * 0.07, topY + h * 0.6);
    ctx.stroke();

    // 锥尖的一点高光
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(box.cx, topY + h * 0.16, Math.max(1, geom.cell * 0.032), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * 第二层：场地覆盖物。在 drawBoard 之后、drawPieces 之前调用。
   *
   * 按场地类型分派：
   *   arenaState.mines 存在         → 危险雷区：底盘 + 悬停预览
   *   arenaState.riverColumns 存在  → 山谷溪流：河流、危险度、雨丝
   *   arenaState.spikes 存在        → 雪山洞穴：冰锥预警
   *   arenaState 为 null            → 经典模式：什么都不画
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state
   */
  function drawArena(ctx, state) {
    // 经典模式没有场地：arenaState 为 null，直接不画任何东西
    if (!state || !state.arenaState) return;

    if (state.arenaState.mines) {
      var list = Mine.mineList(state.arenaState);
      if (list.length === 0) return;

      ctx.save();
      clipBoard(ctx, state);

      for (var m = 0; m < list.length; m++) {
        drawMineMarker(ctx, state, list[m].x, list[m].y, list[m].turns);
      }

      ctx.restore();
      return;
    }

    if (state.arenaState.riverColumns) {
      drawRiver(ctx, state);
      drawRiverDanger(ctx, state);
      drawRain(ctx, state);
      return;
    }

    if (state.arenaState.spikes) {
      var spikes = Arena.spikeList(state.arenaState);
      if (spikes.length === 0) return;

      ctx.save();
      clipBoard(ctx, state);

      for (var i = 0; i < spikes.length; i++) {
        if (B.getCell(state, spikes[i].x, spikes[i].y) === T.EMPTY) {
          drawSpikeOnEmpty(ctx, state, spikes[i].x, spikes[i].y);
        } else {
          drawSpikeOnStone(ctx, state, spikes[i].x, spikes[i].y);
        }
      }

      ctx.restore();
    }
  }

  // ── 冰块 ────────────────────────────────────────────────────────────────

  /** 角落的剩余回合小点：亮起 turns 个；只剩 1 回合时改成水滴。 */
  function drawIceTurns(ctx, box, turns) {
    var total = T.ARENA.ICE_TURNS;
    var r = Math.max(1, geom.cell * 0.042);
    var gap = r * 3;
    var startX = box.x + box.size - r * 1.8 - (total - 1) * gap;
    var cy = box.y + box.size - r * 2;

    for (var i = 0; i < total; i++) {
      ctx.beginPath();
      ctx.arc(startX + i * gap, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = i < turns ? COLORS.iceDot : COLORS.iceDotBack;
      ctx.fill();
    }
  }

  /** 冰块：带刻面与裂纹的半透明冰晶块，压在棋子上方。 */
  function drawIceBlock(ctx, state, x, y, turns) {
    var box = cellBox(state, x, y);
    var pad = Math.max(1.5, geom.cell * 0.055);
    var size = box.size - pad * 2;
    var radius = Math.max(3, geom.cell * 0.22);
    var key = T.cellKey(x, y);
    var born = knockAt[key];
    var melting = turns <= 1;

    ctx.save();

    // 刚生成的冰块做一个短促的弹入 + 淡入
    var alpha = 1;

    if (born !== undefined) {
      var age = clock - born;

      if (age < KNOCK_MS) {
        var t = age / KNOCK_MS;
        var scale = 0.72 + 0.28 * (1 - Math.pow(1 - t, 3));  // ease-out 弹入

        ctx.translate(box.cx, box.cy);
        ctx.scale(scale, scale);
        ctx.translate(-box.cx, -box.cy);

        alpha = 0.55 + 0.45 * t;
      } else {
        delete knockAt[key];
      }
    }

    ctx.globalAlpha = alpha * (melting ? 0.86 : 1);

    // 底部的接触阴影
    Art.softEllipse(ctx, box.cx, box.y + box.size - pad * 1.4,
      box.size * 0.38, box.size * 0.12,
      'rgba(36, 84, 122, 0.34)', 'rgba(36, 84, 122, 0)');

    // 主体：左上透亮、右下结厚冰
    var body = ctx.createLinearGradient(box.x + pad, box.y + pad, box.x + pad + size, box.y + pad + size);
    body.addColorStop(0, COLORS.iceFillTop);
    body.addColorStop(0.46, COLORS.iceFillMid);
    body.addColorStop(1, COLORS.iceFillDeep);

    Art.roundRectPath(ctx, box.x + pad, box.y + pad, size, size, radius);
    ctx.fillStyle = body;
    ctx.fill();

    // 内部刻面：两块不同角度的多边形
    ctx.save();
    Art.roundRectPath(ctx, box.x + pad, box.y + pad, size, size, radius);
    ctx.clip();

    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.moveTo(box.x + pad, box.y + pad + size * 0.34);
    ctx.lineTo(box.x + pad + size * 0.46, box.y + pad);
    ctx.lineTo(box.x + pad + size * 0.62, box.y + pad + size * 0.3);
    ctx.lineTo(box.x + pad + size * 0.18, box.y + pad + size * 0.72);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = alpha * 0.38;
    ctx.fillStyle = 'rgba(120, 180, 226, 0.7)';
    ctx.beginPath();
    ctx.moveTo(box.x + pad + size, box.y + pad + size * 0.24);
    ctx.lineTo(box.x + pad + size * 0.52, box.y + pad + size * 0.62);
    ctx.lineTo(box.x + pad + size, box.y + pad + size * 0.86);
    ctx.closePath();
    ctx.fill();

    // 裂纹
    ctx.globalAlpha = alpha * 0.65;
    ctx.strokeStyle = COLORS.iceCrack;
    ctx.lineWidth = Math.max(1, geom.cell * 0.02);
    ctx.beginPath();
    ctx.moveTo(box.x + pad + size * 0.28, box.y + pad + size * 0.12);
    ctx.lineTo(box.x + pad + size * 0.42, box.y + pad + size * 0.42);
    ctx.lineTo(box.x + pad + size * 0.3, box.y + pad + size * 0.66);
    ctx.moveTo(box.x + pad + size * 0.72, box.y + pad + size * 0.5);
    ctx.lineTo(box.x + pad + size * 0.86, box.y + pad + size * 0.74);
    ctx.stroke();

    // 左上角一道高光，制造冰的通透感
    ctx.globalAlpha = alpha * 0.75;
    ctx.beginPath();
    ctx.moveTo(box.x + pad * 2.2, box.y + box.size * 0.56);
    ctx.lineTo(box.x + box.size * 0.5, box.y + pad * 2);
    ctx.strokeStyle = COLORS.iceSheen;
    ctx.lineWidth = Math.max(1, geom.cell * 0.07);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // 描边 + 顶部亮边
    ctx.globalAlpha = alpha;
    Art.roundRectPath(ctx, box.x + pad, box.y + pad, size, size, radius);
    ctx.strokeStyle = COLORS.iceBorder;
    ctx.lineWidth = Math.max(1, geom.cell * 0.045);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.8;
    ctx.beginPath();
    ctx.moveTo(box.x + pad + radius * 0.6, box.y + pad + 1.2);
    ctx.lineTo(box.x + pad + size - radius * 0.6, box.y + pad + 1.2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, geom.cell * 0.03);
    ctx.stroke();

    // 即将融化：底缘挂两颗水珠
    if (melting) {
      ctx.globalAlpha = alpha * 0.75;
      ctx.fillStyle = 'rgba(150, 210, 245, 0.85)';

      for (var d = 0; d < 2; d++) {
        ctx.beginPath();
        ctx.arc(
          box.x + pad + size * (0.34 + d * 0.32),
          box.y + pad + size + Math.max(1, geom.cell * 0.03) * (1 + d * 0.4),
          Math.max(1, geom.cell * 0.04), 0, Math.PI * 2
        );
        ctx.fill();
      }
    }

    ctx.globalAlpha = alpha;
    drawIceTurns(ctx, box, turns);

    ctx.restore();
  }

  /** 冰锥落下的闪光：扩散的白环 + 中心亮斑。 */
  function drawDropFlash(ctx, state, x, y) {
    var born = knockAt[T.cellKey(x, y)];
    if (born === undefined) return;

    var age = clock - born;
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
   * 这样冰块才能压在棋子上方（冰块格本来就不可能有棋子，视觉上也要在后面）。
   */
  function drawArenaOverlay(ctx, state) {
    if (!state || !state.arenaState) return;

    // 危险雷区：倒计时数字与爆炸闪光都必须压在棋子上方
    if (state.arenaState.mines) {
      drawMineNumbers(ctx, state);
      drawBlastFlashes(ctx, state);
      return;
    }

    // 山谷溪流：水波画在棋子上方，水位条落在石板下方的边框里
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

  G.Render.Arena = {
    COLORS: COLORS,
    configure: configure,
    boardRect: boardRect,
    clipBoard: clipBoard,
    cellBox: cellBox,
    tick: tick,
    notifyDrops: notifyDrops,
    notifyWashed: notifyWashed,
    notifyBlasts: notifyBlasts,
    drawMinePreview: drawMinePreview,
    resetEffects: resetEffects,
    drawArena: drawArena,
    drawArenaOverlay: drawArenaOverlay
  };
})();
