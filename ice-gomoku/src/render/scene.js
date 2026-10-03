/**
 * 五子奇境 · 场景层（背景 + 氛围）
 *
 * 绘制时机（由 main.js 的 render() 依次调用）：
 *   drawScene      —— 第 1 层：背景。天幕、远山/岩壁/崖壁、地面、背景粒子（石板之下）
 *   drawAtmosphere —— 第 7 层：斜向光、边缘霜/尘/雾、前景粒子、环境色偏、暗角、胜利聚焦（最上层）
 *
 * 场景**完全由模式主题驱动**（见 render/theme.js）：
 *   classic → kind 'field'  星空冰原
 *   snow    → kind 'cave'   雪山洞穴
 *   river   → kind 'valley' 山谷溪流
 *   mine    → kind 'mine'   危险雷区
 *
 * 本文件只读 state 与 state.arenaState，不改任何状态；规则结算在 core/ 各自的文件里。
 * 几何（石板矩形 / 圆角）与渲染层公共工具一律走 render/art.js，避免两处各算一遍。
 *
 * 坐标系：逻辑坐标以 CSS 像素为单位，原点在画布左上角。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
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

  /** 最近一次算出的石板矩形，供粒子落点范围复用（不参与规则）。 */
  var lastRect = null;

  // ── 时间与粒子 ──────────────────────────────────────────────────────────
  var clock = 0;
  var lastClock = 0;
  var motes = null;        // 背景粒子：飘雪 / 尘埃 / 雾带
  var fronts = null;       // 前景粒子：大雪 / 火星 / 雾团
  var moteWeather = '';    // 当前粒子对应的天气（切模式时重建）
  var frontWeather = '';

  var FRONT_COUNT = 9;

  function configure(size, margin, dpr) {
    geom.size = size;
    geom.margin = margin;
    geom.origin = margin;
    geom.dpr = dpr > 0 ? dpr : 1;

    // 先按默认路数算一次格距：configure 之后、首次绘制之前也可能被问到坐标
    geom.cell = (size - margin * 2) / (T.DEFAULT_SIZE - 1);

    scene = null;
    edge = null;
  }

  /** 取当前对局的路数，并据此更新格距（与 render/board.js 保持一致）。 */
  function gridSizeOf(state) {
    var n = state && state.size ? state.size : T.DEFAULT_SIZE;
    geom.cell = (geom.size - geom.margin * 2) / (n - 1);
    return n;
  }

  /** 返回石板区域（CSS 像素）。与 render/board.js 的 slabRect 同口径。 */
  function boardRect(state) {
    lastRect = Art.boardRectOf(geom, gridSizeOf(state));
    return lastRect;
  }

  /**
   * 推进场景时钟：粒子飘动、星点闪烁、雾带流动都在这里跟时间走。
   * @param {number} nowMs 来自 rAF 的时间戳
   */
  function tick(nowMs) {
    if (lastClock === 0) lastClock = nowMs;

    var dt = Math.max(0, nowMs - lastClock);
    lastClock = nowMs;
    clock += dt;

    stepMotes(dt);
    stepFronts(dt);
  }

  /** 清空粒子（重开时调用）。场景形状与贴图按尺寸/主题缓存，不在这里清。 */
  function resetEffects() {
    motes = null;
    fronts = null;
    moteWeather = '';
    frontWeather = '';
    lastClock = clock;
  }

  // ── 粒子 ────────────────────────────────────────────────────────────────

  /** 边框带（石板之外的可见区域）内随机取一点。 */
  function bandX(range) {
    var rect = lastRect || Art.boardRectOf(geom, T.DEFAULT_SIZE);
    var inset = Math.max(4, rect.x);
    var size = geom.size;

    // 七成粒子落在左右边框里——那里一定看得见；
    // 其余落在顶部横带，落下后会没入石板之后（物理上也说得通）。
    if (range() < 0.7) {
      return range() < 0.5 ? range() * inset : size - range() * inset;
    }

    return range() * size;
  }

  function initMotes(theme) {
    motes = [];
    moteWeather = theme.id;

    var count = Math.max(10, Math.min(76, Math.round(geom.size * 0.09 * theme.scene.weatherDensity)));

    for (var i = 0; i < count; i++) {
      motes.push(makeMote(Math.random, theme, Math.random() * geom.size));
    }
  }

  function makeMote(range, theme, py) {
    var depth = 0.45 + range() * 0.55;

    return {
      x: bandX(range),
      y: py === undefined ? -6 : py,
      depth: depth,
      r: (0.5 + range() * 1.3) * depth,
      vy: (theme.scene.weather === 'dust' ? -1 : 1) * (7 + range() * 16) * depth,
      drift: range() * Math.PI * 2,
      spin: (range() - 0.5) * 0.6
    };
  }

  function stepMotes(dt) {
    if (!motes) return;

    var seconds = dt / 1000;

    for (var i = 0; i < motes.length; i++) {
      var f = motes[i];
      f.drift += seconds * (0.8 + f.depth);
      f.y += f.vy * seconds;
      f.x += Math.sin(f.drift) * 7 * seconds;

      // 雪往下、尘埃往上，出了边界就回到另一端
      if (f.vy > 0 && f.y > geom.size + 6) motes[i] = makeMote(Math.random, currentTheme, -6 - Math.random() * 20);
      if (f.vy < 0 && f.y < -6) motes[i] = makeMote(Math.random, currentTheme, geom.size + 6 + Math.random() * 20);
    }
  }

  function drawMotes(ctx, theme) {
    var scene = theme.scene;

    ctx.save();
    ctx.fillStyle = scene.weatherColor;

    for (var i = 0; i < motes.length; i++) {
      var f = motes[i];
      ctx.globalAlpha = 0.18 + f.depth * 0.42;

      if (scene.weather === 'snow' && f.r > 1.35) {
        Art.starPath(ctx, f.x, f.y, f.r * 1.5, f.r * 0.5, 6, f.drift * 0.3);
        ctx.fill();
      } else if (scene.weather === 'mist') {
        Art.softEllipse(ctx, f.x, f.y, f.r * 7, f.r * 3.4,
          'rgba(206, 238, 242, ' + (0.05 + f.depth * 0.07).toFixed(3) + ')',
          'rgba(206, 238, 242, 0)');
      } else {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function initFronts(theme) {
    fronts = [];
    frontWeather = theme.id;

    for (var i = 0; i < FRONT_COUNT; i++) {
      fronts.push({
        x: Math.random() * geom.size,
        y: Math.random() * geom.size,
        r: 1.6 + Math.random() * 2.6,
        vy: (theme.scene.weather === 'dust' ? -1 : 1) * (9 + Math.random() * 12),
        sway: Math.random() * Math.PI * 2,
        spin: Math.random() * Math.PI * 2,
        alpha: 0.1 + Math.random() * 0.14
      });
    }
  }

  function stepFronts(dt) {
    if (!fronts) return;

    var seconds = dt / 1000;

    for (var i = 0; i < fronts.length; i++) {
      var f = fronts[i];
      f.sway += seconds * 0.5;
      f.spin += seconds * 0.35;
      f.y += f.vy * seconds;
      f.x += Math.sin(f.sway) * 11 * seconds;

      if (f.y > geom.size + 8 || f.y < -8) {
        f.y = f.vy > 0 ? -8 : geom.size + 8;
        f.x = Math.random() * geom.size;
      }
      if (f.x < -8) f.x = geom.size + 8;
      if (f.x > geom.size + 8) f.x = -8;
    }
  }

  function drawFronts(ctx, theme) {
    var weather = theme.scene.weather;

    ctx.save();

    for (var i = 0; i < fronts.length; i++) {
      var f = fronts[i];

      if (weather === 'dust') {
        // 火星：暖色光点 + 拖尾
        Art.softEllipse(ctx, f.x, f.y, f.r * 3, f.r * 3,
          'rgba(255, 190, 120, ' + (f.alpha * 0.7).toFixed(3) + ')', 'rgba(255, 190, 120, 0)');
        ctx.globalAlpha = f.alpha * 1.4;
        ctx.fillStyle = 'rgba(255, 226, 178, 0.95)';
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      if (weather === 'mist') {
        Art.softEllipse(ctx, f.x, f.y, f.r * 9, f.r * 4.6,
          'rgba(206, 238, 242, ' + (f.alpha * 0.9).toFixed(3) + ')', 'rgba(206, 238, 242, 0)');
        continue;
      }

      Art.softEllipse(ctx, f.x, f.y, f.r * 2.4, f.r * 2.4,
        'rgba(226, 244, 255, ' + (f.alpha * 0.5).toFixed(3) + ')',
        'rgba(226, 244, 255, 0)');

      ctx.globalAlpha = f.alpha;
      ctx.fillStyle = 'rgba(240, 250, 255, 0.95)';
      Art.starPath(ctx, f.x, f.y, f.r * 1.5, f.r * 0.5, 6, f.spin);
      ctx.fill();
    }

    ctx.restore();
  }

  // ── 场景形状（按「主题 + 尺寸」缓存，每帧只画不算）──────────────────────

  var scene = null;
  var currentTheme = Theme.get('classic');

  /** 建一个带 stops 的线性渐变。 */
  function ctxGradient(ctx, x0, y0, x1, y1, stops) {
    var grad = ctx.createLinearGradient(x0, y0, x1, y1);

    for (var i = 0; i < stops.length; i++) {
      grad.addColorStop(stops[i][0], stops[i][1]);
    }

    return grad;
  }

  /** 建一个带 stops 的径向渐变（用于四角的光晕）。 */
  function ctxRadial(ctx, cx, cy, r1, stops) {
    var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1);

    for (var i = 0; i < stops.length; i++) {
      grad.addColorStop(stops[i][0], stops[i][1]);
    }

    return grad;
  }

  /** 向下 / 向上的尖锥（冰锥、石笋、岩牙共用）。dir = 1 向下，-1 向上。 */
  function shardPath(ctx, cx, baseY, width, height, lean, dir) {
    var half = width / 2;
    var tipY = baseY + height * dir;

    ctx.beginPath();
    ctx.moveTo(cx - half, baseY);
    ctx.quadraticCurveTo(cx - half * 0.55, baseY + height * 0.45 * dir, cx + lean, tipY);
    ctx.quadraticCurveTo(cx + half * 0.55, baseY + height * 0.45 * dir, cx + half, baseY);
    ctx.closePath();
  }

  /** 一条起伏的横向轮廓（远山脊线、地面线）。 */
  function skyline(rng, count, size, baseY, amp) {
    var pts = [];

    for (var i = 0; i <= count; i++) {
      pts.push([
        (size / count) * i,
        baseY + (rng() - 0.5) * amp - Math.abs(Math.sin(i * 1.7)) * amp * 0.6
      ]);
    }

    return pts;
  }

  /** 某一边的锯齿岩壁：返回若干「从边往内伸」的楔形。 */
  function wallWedges(rng, count, size, inset, ratio) {
    var out = [];

    for (var i = 0; i < count; i++) {
      out.push({
        along: (i + 0.5) * (size / count) + (rng() - 0.5) * inset * 0.8,
        w: inset * (0.6 + rng() * 1.1),
        depth: inset * ratio * (0.45 + rng() * 0.8),
        skew: (rng() - 0.5) * inset * 0.5,
        alpha: 0.5 + rng() * 0.5
      });
    }

    return out;
  }

  /** 边框带内的随机点（形状生成用）。 */
  function bandPoint(rng, size, inset) {
    var side = Math.floor(rng() * 4);
    var depth = 2 + rng() * Math.max(6, inset * 0.9);

    if (side === 0) return { x: rng() * size, y: depth, side: side };
    if (side === 1) return { x: size - depth, y: rng() * size, side: side };
    if (side === 2) return { x: rng() * size, y: size - depth, side: side };
    return { x: depth, y: rng() * size, side: side };
  }

  function buildGrads(ctx, theme, size, inset) {
    var s = theme.scene.stops;

    return {
      top: ctxGradient(ctx, 0, 0, 0, size * 0.5, s.top),
      bottom: ctxGradient(ctx, 0, size, 0, size * 0.5, s.bottom),
      left: ctxGradient(ctx, 0, 0, inset * 1.5, 0, s.side),
      right: ctxGradient(ctx, size, 0, size - inset * 1.5, 0, s.side),
      corner: [
        ctxRadial(ctx, 0, 0, inset * 2.6, s.corner),
        ctxRadial(ctx, size, 0, inset * 2.6, s.corner),
        ctxRadial(ctx, 0, size, inset * 2.6, s.corner),
        ctxRadial(ctx, size, size, inset * 2.6, s.corner)
      ]
    };
  }

  /** 四角冰晶簇：洞穴与星空冰原共用。 */
  function buildCrystals(rng, size, inset) {
    var corners = [
      { x: 0, y: 0, dx: 1, dy: 1 },
      { x: size, y: 0, dx: -1, dy: 1 },
      { x: 0, y: size, dx: 1, dy: -1 },
      { x: size, y: size, dx: -1, dy: -1 }
    ];
    var out = [];

    for (var i = 0; i < corners.length; i++) {
      var c = corners[i];
      var cluster = { x: c.x, y: c.y, dx: c.dx, dy: c.dy, shards: [] };
      var count = 3 + Math.floor(rng() * 3);

      for (var k = 0; k < count; k++) {
        cluster.shards.push({
          along: rng() * inset * 1.25,
          w: inset * (0.16 + rng() * 0.26),
          len: inset * (0.55 + rng() * 1.15),
          spread: (rng() - 0.5) * 0.9
        });
      }

      out.push(cluster);
    }

    return out;
  }

  /** 洞穴：顶部冰锥 + 底部石笋 + 侧壁刻面 + 四角冰晶 + 地面雪堆。 */
  function buildCave(ctx, theme, rect, inset, rng) {
    var size = geom.size;
    var s = { kind: 'cave', rect: rect, inset: inset, drifts: [], facets: [] };
    var i, x, far;

    s.top = [];

    var topCount = Math.max(6, Math.round(size / (inset * 1.15)));

    for (i = 0; i < topCount; i++) {
      far = rng() > 0.45;
      x = (i + 0.5) * (size / topCount) + (rng() - 0.5) * inset * 0.7;

      s.top.push({
        x: x,
        w: inset * (far ? 0.3 : 0.44) * (0.7 + rng() * 0.9),
        len: inset * (far ? 1.2 + rng() * 1.5 : 0.5 + rng() * 0.95),
        lean: (rng() - 0.5) * inset * 0.4,
        alpha: far ? 0.5 : 1,
        glint: rng() > 0.4
      });
    }

    s.bottom = [];

    var botCount = Math.max(4, Math.round(size / (inset * 2.1)));

    for (i = 0; i < botCount; i++) {
      x = (i + 0.5) * (size / botCount) + (rng() - 0.5) * inset * 0.8;

      s.bottom.push({
        x: x,
        w: inset * (0.45 + rng() * 0.75),
        len: inset * (0.26 + rng() * 0.5),
        lean: (rng() - 0.5) * inset * 0.4,
        alpha: 0.5 + rng() * 0.35
      });
    }

    var sideCount = Math.max(5, Math.round(size / (inset * 1.6)));

    for (i = 0; i < sideCount; i++) {
      s.facets.push({
        y: (i + 0.5) * (size / sideCount) + (rng() - 0.5) * inset,
        h: inset * (0.8 + rng() * 1.3),
        depth: inset * (0.35 + rng() * 0.8),
        skew: (rng() - 0.5) * inset * 0.5,
        alpha: 0.5 + rng() * 0.5,
        right: rng() > 0.5
      });
    }

    var driftCount = Math.max(4, Math.round(size / (inset * 1.9)));

    for (i = 0; i < driftCount; i++) {
      s.drifts.push({
        x: (i + 0.5) * (size / driftCount) + (rng() - 0.5) * inset,
        rx: inset * (1.1 + rng() * 1.9),
        ry: inset * (0.22 + rng() * 0.34),
        alpha: 0.5 + rng() * 0.5
      });
    }

    s.crystals = buildCrystals(rng, size, inset);
    s.grads = buildGrads(ctx, theme, size, inset);
    return s;
  }

  /** 星空冰原：星点 + 远处雪脊 + 地面积冰 + 边角冰晶。 */
  function buildField(ctx, theme, rect, inset, rng) {
    var size = geom.size;
    var s = { kind: 'field', rect: rect, inset: inset, stars: [] };
    var i;

    for (i = 0; i < theme.scene.stars; i++) {
      s.stars.push({
        x: rng() * size,
        y: rng() * size,
        r: 0.35 + rng() * 1.15,
        phase: rng() * Math.PI * 2,
        warm: rng() > 0.72
      });
    }

    // 远近两层雪脊：只画在顶部边框带里
    s.ridges = [
      { pts: skyline(rng, 7, size, inset * 0.95, inset * 0.9), color: theme.scene.ridgeFar, cap: null },
      { pts: skyline(rng, 9, size, inset * 1.35, inset * 0.7), color: theme.scene.ridgeNear, cap: theme.scene.ridgeCap }
    ];

    // 地面积冰：底部一条起伏的冰带 + 几块碎冰
    s.floor = skyline(rng, 8, size, size - inset * 0.34, inset * 0.5);
    s.blocks = [];

    var blockCount = Math.max(3, Math.round(size / (inset * 3.2)));

    for (i = 0; i < blockCount; i++) {
      s.blocks.push({
        x: (i + 0.5) * (size / blockCount) + (rng() - 0.5) * inset,
        w: inset * (0.5 + rng() * 0.9),
        h: inset * (0.18 + rng() * 0.34),
        skew: (rng() - 0.5) * inset * 0.4,
        alpha: 0.5 + rng() * 0.5
      });
    }

    s.crystals = buildCrystals(rng, size, inset);
    s.grads = buildGrads(ctx, theme, size, inset);
    return s;
  }

  /** 山谷溪流：崖壁 + 河滩卵石 + 雾带。 */
  function buildValley(ctx, theme, rect, inset, rng) {
    var size = geom.size;
    var s = { kind: 'valley', rect: rect, inset: inset };

    s.walls = {
      left: wallWedges(rng, Math.max(4, Math.round(size / (inset * 1.5))), size, inset, 1.5),
      right: wallWedges(rng, Math.max(4, Math.round(size / (inset * 1.6))), size, inset, 1.4)
    };

    // 远景山脊
    s.ridge = { pts: skyline(rng, 8, size, inset * 1.1, inset * 1.1), color: theme.scene.cliffFar };

    // 河滩：底部起伏的岸线 + 卵石
    s.bank = skyline(rng, 9, size, size - inset * 0.4, inset * 0.55);
    s.pebbles = [];

    var count = Math.max(8, Math.round(size / (inset * 0.9)));

    for (var i = 0; i < count; i++) {
      s.pebbles.push({
        x: rng() * size,
        y: size - rng() * inset * 0.9,
        rx: inset * (0.12 + rng() * 0.26),
        ry: inset * (0.06 + rng() * 0.14),
        alpha: 0.3 + rng() * 0.5
      });
    }

    // 雾带：横向的柔光条，随时钟缓慢流动
    s.mist = [];

    for (var k = 0; k < 5; k++) {
      s.mist.push({
        y: size * (0.15 + 0.7 * rng()),
        rx: size * (0.3 + rng() * 0.45),
        ry: inset * (0.5 + rng() * 0.8),
        speed: 0.1 + rng() * 0.25,
        phase: rng()
      });
    }

    s.grads = buildGrads(ctx, theme, size, inset);
    return s;
  }

  /** 危险雷区：岩壁 + 矿脉 + 碎石 + 矿灯。 */
  function buildMine(ctx, theme, rect, inset, rng) {
    var size = geom.size;
    var s = { kind: 'mine', rect: rect, inset: inset };

    s.top = [];
    s.bottom = [];

    var topCount = Math.max(5, Math.round(size / (inset * 1.3)));
    var i, x;

    for (i = 0; i < topCount; i++) {
      x = (i + 0.5) * (size / topCount) + (rng() - 0.5) * inset * 0.8;
      s.top.push({
        x: x,
        w: inset * (0.55 + rng() * 0.8),
        len: inset * (0.4 + rng() * 1.0),
        lean: (rng() - 0.5) * inset * 0.5,
        alpha: 0.55 + rng() * 0.45,
        glint: false
      });
    }

    var botCount = Math.max(4, Math.round(size / (inset * 1.7)));

    for (i = 0; i < botCount; i++) {
      x = (i + 0.5) * (size / botCount) + (rng() - 0.5) * inset * 0.8;
      s.bottom.push({
        x: x,
        w: inset * (0.6 + rng() * 0.9),
        len: inset * (0.3 + rng() * 0.7),
        lean: (rng() - 0.5) * inset * 0.45,
        alpha: 0.5 + rng() * 0.4
      });
    }

    // 矿脉：沿岩壁的折线，带自发光
    s.veins = [];

    for (var v = 0; v < 7; v++) {
      var p = bandPoint(rng, size, inset);
      var seg = { x: p.x, y: p.y, steps: [], alpha: 0.4 + rng() * 0.5 };

      for (var k = 0; k < 3; k++) {
        seg.steps.push({
          dx: (rng() - 0.5) * inset * 1.6,
          dy: (rng() - 0.5) * inset * 1.6
        });
      }

      s.veins.push(seg);
    }

    // 碎石堆
    s.rubble = [];

    var rb = Math.max(4, Math.round(size / (inset * 2)));

    for (i = 0; i < rb; i++) {
      s.rubble.push({
        x: (i + 0.5) * (size / rb) + (rng() - 0.5) * inset,
        rx: inset * (0.7 + rng() * 1.3),
        ry: inset * (0.14 + rng() * 0.3),
        alpha: 0.4 + rng() * 0.5
      });
    }

    // 两盏矿灯：挂在顶部左右
    s.lamps = [
      { x: size * 0.16, y: inset * 0.5, phase: 0 },
      { x: size * 0.84, y: inset * 0.5, phase: 1.7 }
    ];

    s.crystals = buildCrystals(rng, size, inset);
    s.grads = buildGrads(ctx, theme, size, inset);
    return s;
  }

  /** 取当前主题与尺寸的场景形状，必要时重建。 */
  function ensureScene(ctx, state, theme) {
    var rect = boardRect(state);
    var key = theme.id + '|' + geom.size + '|' + geom.margin + '|' + geom.cell + '|' + geom.dpr;

    if (scene && scene.key === key && scene.owner === ctx) return scene;

    var inset = Math.max(6, rect.x);
    var rng = Art.rngFrom(0x1CE0FF ^ (theme.id.length * 977));
    var built;

    if (theme.kind === 'cave') built = buildCave(ctx, theme, rect, inset, rng);
    else if (theme.kind === 'valley') built = buildValley(ctx, theme, rect, inset, rng);
    else if (theme.kind === 'mine') built = buildMine(ctx, theme, rect, inset, rng);
    else built = buildField(ctx, theme, rect, inset, rng);

    built.key = key;
    built.owner = ctx;
    built.inset = inset;
    scene = built;
    return scene;
  }

  // ── 各类场景的画法 ──────────────────────────────────────────────────────

  /** 天幕：整块画布铺主题渐变。 */
  function drawSky(ctx, theme) {
    var grad = ctx.createLinearGradient(0, 0, 0, geom.size);
    grad.addColorStop(0, theme.scene.skyTop);
    grad.addColorStop(1, theme.scene.skyBottom);

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, geom.size, geom.size);
    ctx.restore();
  }

  /** 石板方向的中心光池：让石板看起来在照亮四周。 */
  function drawBoardGlow(ctx, theme, state) {
    var rect = boardRect(state);

    ctx.save();
    Art.softEllipse(
      ctx,
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      geom.size * 0.82, geom.size * 0.74,
      theme.scene.glow, theme.scene.glowFade
    );
    ctx.restore();
  }

  function drawCave(ctx, theme, s) {
    var size = geom.size;
    var inset = s.inset;
    var i;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 天花板与地面
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = theme.scene.ceiling;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.lineTo(size, inset * 0.18);

    for (i = 6; i >= 0; i--) {
      ctx.lineTo((size / 6) * i, inset * (0.12 + 0.1 * Math.abs(Math.sin(i * 1.7))));
    }

    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = theme.scene.floorSnow;
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, size);
    ctx.lineTo(size, size - inset * 0.14);

    for (i = 6; i >= 0; i--) {
      ctx.lineTo((size / 6) * i, size - inset * (0.1 + 0.09 * Math.abs(Math.cos(i * 2.1))));
    }

    ctx.closePath();
    ctx.fill();

    for (i = 0; i < s.drifts.length; i++) {
      var d = s.drifts[i];
      ctx.globalAlpha = 0.5 * d.alpha;
      Art.softEllipse(ctx, d.x, size - d.ry * 0.3, d.rx, d.ry, theme.scene.drift, 'rgba(226, 246, 255, 0)');
    }

    // 侧壁刻面
    ctx.globalAlpha = 1;

    for (i = 0; i < s.facets.length; i++) {
      var f = s.facets[i];
      var x0 = f.right ? size : 0;
      var dx = (f.right ? -1 : 1) * f.depth;

      ctx.globalAlpha = 0.55 * f.alpha;
      ctx.beginPath();
      ctx.moveTo(x0, f.y - f.h * 0.45);
      ctx.lineTo(x0 + dx, f.y - f.h * 0.2 + f.skew);
      ctx.lineTo(x0 + dx * 0.7, f.y + f.h * 0.5);
      ctx.lineTo(x0, f.y + f.h * 0.75);
      ctx.closePath();
      ctx.fillStyle = f.right ? s.grads.right : s.grads.left;
      ctx.fill();

      ctx.globalAlpha = 0.3 * f.alpha;
      ctx.strokeStyle = theme.scene.iceEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 顶部冰锥：先远后近
    ctx.globalAlpha = 1;

    for (i = 0; i < s.top.length; i++) {
      var t = s.top[i];
      ctx.globalAlpha = t.alpha;

      shardPath(ctx, t.x, 0, t.w, t.len, t.lean, 1);
      ctx.fillStyle = s.grads.top;
      ctx.fill();

      ctx.globalAlpha = t.alpha * 0.5;
      ctx.strokeStyle = theme.scene.iceEdge;
      ctx.lineWidth = 1;
      ctx.stroke();

      if (t.glint) {
        ctx.globalAlpha = t.alpha * 0.9;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(t.x + t.lean * 0.8, t.len * 0.86, Math.max(0.6, inset * 0.026), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 底部石笋
    for (i = 0; i < s.bottom.length; i++) {
      var b = s.bottom[i];
      ctx.globalAlpha = b.alpha;

      shardPath(ctx, b.x, size, b.w, b.len, b.lean, -1);
      ctx.fillStyle = s.grads.bottom;
      ctx.fill();

      ctx.globalAlpha = b.alpha * 0.22;
      ctx.strokeStyle = theme.scene.iceEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    drawCrystals(ctx, theme, s);
    ctx.restore();
  }

  /** 四角冰晶簇。 */
  function drawCrystals(ctx, theme, s) {
    var inset = s.inset;

    for (var i = 0; i < s.crystals.length; i++) {
      var c = s.crystals[i];
      var gx = c.x + c.dx * inset * 1.9;
      var gy = c.y + c.dy * inset * 1.9;

      ctx.globalAlpha = 1;
      Art.softEllipse(ctx, gx, gy, inset * 1.5, inset * 1.5,
        theme.scene.wallTint || 'rgba(150, 205, 245, 0.3)',
        'rgba(150, 205, 245, 0)');

      for (var k = 0; k < c.shards.length; k++) {
        var sh = c.shards[k];
        var bx = c.x + c.dx * sh.along * 0.6;
        var by = c.y + c.dy * sh.along;

        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(
          bx + c.dx * sh.len * (1 + sh.spread * 0.2),
          by + c.dy * sh.len * (0.55 + sh.spread * 0.3)
        );
        ctx.lineTo(bx + c.dy * sh.w, by - c.dx * sh.w);
        ctx.closePath();

        ctx.fillStyle = s.grads.corner[i];
        ctx.fill();

        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = theme.scene.iceEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /** 星空冰原：星点 + 雪脊 + 地面积冰。 */
  function drawField(ctx, theme, s) {
    var size = geom.size;
    var i;

    ctx.save();
    ctx.lineJoin = 'round';

    // 星点：一部分缓慢闪烁
    for (i = 0; i < s.stars.length; i++) {
      var st = s.stars[i];
      var tw = 0.55 + 0.45 * Math.sin(clock / 1400 + st.phase);

      ctx.globalAlpha = (0.25 + 0.6 * tw) * (st.warm ? 0.8 : 1);
      ctx.fillStyle = st.warm ? theme.scene.starWarm : theme.scene.star;

      if (st.r > 1.1) {
        Art.starPath(ctx, st.x, st.y, st.r * 2.2, st.r * 0.5, 4, st.phase);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 远处雪脊：折线填充 + 山脊压一道亮边
    for (var r = 0; r < s.ridges.length; r++) {
      var ridge = s.ridges[r];

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(-2, -2);
      ctx.lineTo(size + 2, -2);
      for (i = ridge.pts.length - 1; i >= 0; i--) {
        ctx.lineTo(ridge.pts[i][0], ridge.pts[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = ridge.color;
      ctx.fill();

      if (ridge.cap) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = ridge.cap;
        ctx.lineWidth = Math.max(1, s.inset * 0.05);
        ctx.beginPath();
        for (i = 0; i < ridge.pts.length; i++) {
          if (i === 0) ctx.moveTo(ridge.pts[i][0], ridge.pts[i][1]);
          else ctx.lineTo(ridge.pts[i][0], ridge.pts[i][1]);
        }
        ctx.stroke();
      }
    }

    // 地面积冰
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(-2, size + 2);
    ctx.lineTo(size + 2, size + 2);
    for (i = s.floor.length - 1; i >= 0; i--) {
      ctx.lineTo(s.floor[i][0], s.floor[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = theme.scene.floor;
    ctx.fill();

    ctx.strokeStyle = theme.scene.floorEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 底部碎冰
    for (i = 0; i < s.blocks.length; i++) {
      var blk = s.blocks[i];

      ctx.globalAlpha = 0.6 * blk.alpha;
      shardPath(ctx, blk.x, size - s.inset * 0.2, blk.w, -blk.h, blk.skew, 1);
      ctx.fillStyle = s.grads.bottom;
      ctx.fill();
    }

    drawCrystals(ctx, theme, s);
    ctx.restore();
  }

  /** 山谷：崖壁 + 河滩 + 雾带。 */
  function drawValley(ctx, theme, s) {
    var size = geom.size;
    var inset = s.inset;
    var i;

    ctx.save();
    ctx.lineJoin = 'round';

    // 远景山脊
    ctx.beginPath();
    ctx.moveTo(-2, -2);
    ctx.lineTo(size + 2, -2);
    for (i = s.ridge.pts.length - 1; i >= 0; i--) {
      ctx.lineTo(s.ridge.pts[i][0], s.ridge.pts[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = s.ridge.color;
    ctx.fill();

    // 左右崖壁：由外向内收的楔形，越靠外越暗
    for (var side = 0; side < 2; side++) {
      var wedges = side === 0 ? s.walls.left : s.walls.right;
      var x0 = side === 0 ? 0 : size;
      var dir = side === 0 ? 1 : -1;

      for (i = 0; i < wedges.length; i++) {
        var w = wedges[i];
        var depth = w.depth;

        ctx.globalAlpha = 0.9 * w.alpha;
        ctx.beginPath();
        ctx.moveTo(x0, w.along - w.w * 0.5);
        ctx.lineTo(x0 + dir * depth * 0.68, w.along - w.w * 0.18 + w.skew);
        ctx.lineTo(x0 + dir * depth, w.along + w.w * 0.32);
        ctx.lineTo(x0 + dir * depth * 0.5, w.along + w.w * 0.62);
        ctx.lineTo(x0, w.along + w.w * 0.78);
        ctx.closePath();

        ctx.fillStyle = (i % 2 === 0) ? theme.scene.cliffMid : theme.scene.cliffNear;
        ctx.fill();

        ctx.globalAlpha = 0.45 * w.alpha;
        ctx.strokeStyle = theme.scene.cliffEdge;
        ctx.lineWidth = 1;
        ctx.stroke();

        // 崖顶的亮边（积雾/苔色）
        ctx.globalAlpha = 0.4 * w.alpha;
        ctx.strokeStyle = theme.scene.cliffCap;
        ctx.beginPath();
        ctx.moveTo(x0, w.along - w.w * 0.5);
        ctx.lineTo(x0 + dir * depth * 0.68, w.along - w.w * 0.18 + w.skew);
        ctx.stroke();
      }
    }

    // 河滩：岸线 + 卵石
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(-2, size + 2);
    ctx.lineTo(size + 2, size + 2);
    for (i = s.bank.length - 1; i >= 0; i--) {
      ctx.lineTo(s.bank[i][0], s.bank[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = theme.scene.bank;
    ctx.fill();

    for (i = 0; i < s.pebbles.length; i++) {
      var pb = s.pebbles[i];
      ctx.globalAlpha = 0.5 * pb.alpha;
      Art.softEllipse(ctx, pb.x, pb.y, pb.rx, pb.ry, theme.scene.gravel, 'rgba(176, 200, 192, 0)');
    }

    // 雾带：随时间横向飘移
    for (i = 0; i < s.mist.length; i++) {
      var m = s.mist[i];
      var drift = ((clock / 1000 * m.speed + m.phase) % 1.4) - 0.2;
      var cx = drift * size * 1.2;

      ctx.globalAlpha = 1;
      Art.softEllipse(ctx, cx, m.y, m.rx, m.ry, theme.scene.mist, 'rgba(196, 232, 238, 0)');
    }

    // 顶部压一层阴天云带
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = theme.scene.cliffFar;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.lineTo(size, inset * 0.2);
    for (i = 5; i >= 0; i--) {
      ctx.lineTo((size / 5) * i, inset * (0.14 + 0.12 * Math.abs(Math.cos(i * 1.9))));
    }
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /** 矿洞：岩壁 + 矿脉 + 碎石 + 矿灯。 */
  function drawMine(ctx, theme, s) {
    var size = geom.size;
    var inset = s.inset;
    var i;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 顶部岩牙
    for (i = 0; i < s.top.length; i++) {
      var t = s.top[i];
      ctx.globalAlpha = t.alpha;

      shardPath(ctx, t.x, 0, t.w, t.len, t.lean, 1);
      ctx.fillStyle = s.grads.top;
      ctx.fill();

      ctx.globalAlpha = t.alpha * 0.45;
      ctx.strokeStyle = theme.scene.rockEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 底部碎石堆
    for (i = 0; i < s.bottom.length; i++) {
      var b = s.bottom[i];
      ctx.globalAlpha = b.alpha;

      shardPath(ctx, b.x, size, b.w, b.len, b.lean, -1);
      ctx.fillStyle = s.grads.bottom;
      ctx.fill();

      ctx.globalAlpha = b.alpha * 0.35;
      ctx.strokeStyle = theme.scene.rockEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 两侧岩体
    var walls = [
      { x0: 0, dir: 1 },
      { x0: size, dir: -1 }
    ];

    for (var wl = 0; wl < walls.length; wl++) {
      var wall = walls[wl];
      var steps = Math.max(6, Math.round(size / (inset * 1.1)));

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(wall.x0, -2);

      for (i = 0; i <= steps; i++) {
        var y = (size / steps) * i;
        var d = inset * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.3 + wl * 2.1)));

        ctx.lineTo(wall.x0 + wall.dir * d, y);
      }

      ctx.lineTo(wall.x0, size + 2);
      ctx.closePath();
      ctx.fillStyle = wall.dir === 1 ? s.grads.left : s.grads.right;
      ctx.fill();
    }

    // 碎石堆（地面）
    for (i = 0; i < s.rubble.length; i++) {
      var rb = s.rubble[i];
      ctx.globalAlpha = 0.6 * rb.alpha;
      Art.softEllipse(ctx, rb.x, size - rb.ry * 0.4, rb.rx, rb.ry, theme.scene.rubble, 'rgba(122, 92, 68, 0)');
    }

    // 矿脉：折线 + 自发光
    for (i = 0; i < s.veins.length; i++) {
      var v = s.veins[i];
      var px = v.x;
      var py = v.y;

      ctx.globalAlpha = 0.5 * v.alpha;
      Art.softEllipse(ctx, px, py, inset * 1.4, inset * 1.4, theme.scene.vein, 'rgba(255, 152, 76, 0)');

      ctx.globalAlpha = v.alpha;
      ctx.strokeStyle = theme.scene.vein;
      ctx.lineWidth = Math.max(1, inset * 0.07);
      ctx.beginPath();
      ctx.moveTo(px, py);

      for (var k = 0; k < v.steps.length; k++) {
        px += v.steps[k].dx;
        py += v.steps[k].dy;
        ctx.lineTo(px, py);
      }

      ctx.stroke();

      ctx.globalAlpha = v.alpha * 0.7;
      ctx.strokeStyle = theme.scene.veinHot;
      ctx.lineWidth = Math.max(1, inset * 0.028);
      ctx.stroke();
    }

    // 矿灯：暖光 + 灯芯，缓慢明暗
    for (i = 0; i < s.lamps.length; i++) {
      var lamp = s.lamps[i];
      var flicker = 0.62 + 0.38 * Math.sin(clock / 900 + lamp.phase);

      ctx.globalAlpha = flicker;
      Art.softEllipse(ctx, lamp.x, lamp.y, inset * 2.6, inset * 2.6,
        'rgba(255, 178, 96, 0.5)', 'rgba(255, 178, 96, 0)');

      ctx.globalAlpha = 0.9;
      ctx.fillStyle = theme.scene.lamp;
      ctx.beginPath();
      ctx.arc(lamp.x, lamp.y, Math.max(1, inset * 0.13), 0, Math.PI * 2);
      ctx.fill();
    }

    drawCrystals(ctx, theme, s);
    ctx.restore();
  }

  function drawBackdrop(ctx, theme, s) {
    if (s.kind === 'cave') drawCave(ctx, theme, s);
    else if (s.kind === 'valley') drawValley(ctx, theme, s);
    else if (s.kind === 'mine') drawMine(ctx, theme, s);
    else drawField(ctx, theme, s);
  }

  /**
   * 第 1 层：场景背景。在 drawBoard 之前调用。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state GameState
   * @param {string} [modeId] 显式模式 id（main.js 传入；缺省按 arenaState 推断）
   */
  function drawScene(ctx, state, modeId) {
    if (!geom.size) return;

    var theme = Theme.get(Theme.idOf(state, modeId));
    currentTheme = theme;

    drawSky(ctx, theme);
    drawBoardGlow(ctx, theme, state);
    drawBackdrop(ctx, theme, ensureScene(ctx, state, theme));

    // 背景粒子：天气随主题走（飘雪 / 尘埃 / 雾带）
    if (!motes || moteWeather !== theme.id) initMotes(theme);
    drawMotes(ctx, theme);
  }

  // ── 氛围层（最上层）────────────────────────────────────────────────────

  var edge = null;

  /** 画布边缘的附加层：冰霜 / 雾气 / 矿尘，只生成一次。 */
  function ensureEdge(ctx, theme) {
    var key = theme.id + '|' + geom.size + '|' + geom.dpr;

    if (edge && edge.key === key) return edge;

    var surface = Art.createSurface(geom.size, geom.size, geom.dpr);
    edge = { key: key, surface: surface };

    if (!surface) return edge;

    var ectx = surface.ctx;
    var rng = Art.rngFrom(0xF0057);
    var size = geom.size;
    var reach = size * 0.16;
    var i, p, depth, angle, fade;

    ectx.save();
    ectx.lineCap = 'round';

    if (theme.scene.edge === 'frost') {
      for (i = 0; i < 130; i++) {
        p = bandPoint(rng, size, reach);
        depth = Math.min(reach, Math.hypot(p.x < size / 2 ? p.x : size - p.x, p.y < size / 2 ? p.y : size - p.y));
        angle = (p.side === 0 ? Math.PI / 2 : p.side === 1 ? Math.PI : p.side === 2 ? -Math.PI / 2 : 0) +
          (rng() - 0.5) * 1.4;
        fade = 1 - depth / reach;

        Art.frostSprig(
          ectx, p.x, p.y,
          (10 + rng() * 26) * (0.5 + fade),
          angle,
          (0.04 + rng() * 0.09) * (0.4 + fade) * (theme.scene.edgeAlpha / 0.55),
          0.7 + rng() * 0.8,
          rng
        );
      }
    } else if (theme.scene.edge === 'dust') {
      // 矿尘：暖色颗粒，越靠边越密
      for (i = 0; i < 160; i++) {
        p = bandPoint(rng, size, reach);
        ectx.globalAlpha = (0.1 + rng() * 0.3) * theme.scene.edgeAlpha;

        if (rng() > 0.75) {
          Art.softEllipse(ectx, p.x, p.y, 5 + rng() * 12, 4 + rng() * 8,
            'rgba(255, 186, 120, ' + (0.3 * theme.scene.edgeAlpha).toFixed(3) + ')',
            'rgba(255, 186, 120, 0)');
        } else {
          ectx.fillStyle = theme.scene.edgeColor;
          ectx.beginPath();
          ectx.arc(p.x, p.y, 0.5 + rng() * 1.2, 0, Math.PI * 2);
          ectx.fill();
        }
      }
    } else {
      // 雾气：贴边的柔光条
      for (i = 0; i < 90; i++) {
        p = bandPoint(rng, size, reach);
        ectx.globalAlpha = (0.06 + rng() * 0.16) * theme.scene.edgeAlpha;
        Art.softEllipse(ectx, p.x, p.y, 16 + rng() * 40, 8 + rng() * 18,
          theme.scene.edgeColor, 'rgba(200, 234, 238, 0)');
      }
    }

    ectx.restore();
    return edge;
  }

  /** 从左上斜切进来的光柱（颜色随主题）。 */
  function drawShafts(ctx, theme) {
    var size = geom.size;
    var drift = Math.sin(clock / 5200) * size * 0.02;
    var rgb = theme.scene.shaft;
    var a = theme.scene.shaftAlpha;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    var shafts = [
      { x: size * 0.06, w: size * 0.2, lean: size * 0.36, a: 0.9 },
      { x: size * 0.32, w: size * 0.11, lean: size * 0.3, a: 0.55 },
      { x: size * 0.72, w: size * 0.08, lean: size * 0.22, a: 0.35 }
    ];

    for (var i = 0; i < shafts.length; i++) {
      var s = shafts[i];
      var top = -size * 0.05;
      var bottom = size * 1.05;
      var grad = ctx.createLinearGradient(s.x + drift, top, s.x + drift + s.lean, bottom);

      grad.addColorStop(0, Art.rgba(rgb, 0));
      grad.addColorStop(0.35, Art.rgba(rgb, (a * 1.4 * s.a).toFixed(3)));
      grad.addColorStop(0.6, Art.rgba(rgb, (a * 0.9 * s.a).toFixed(3)));
      grad.addColorStop(1, Art.rgba(rgb, 0));

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(s.x + drift - s.w / 2, top);
      ctx.lineTo(s.x + drift + s.w / 2, top);
      ctx.lineTo(s.x + drift + s.lean + s.w, bottom);
      ctx.lineTo(s.x + drift + s.lean - s.w, bottom);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  /** 环境色偏；雷区倒计时紧迫时加一层会呼吸的暖红。 */
  function drawAmbient(ctx, state, theme) {
    var tint = theme.ambient;
    var arena = state ? state.arenaState : null;

    if (arena && arena.mines && theme.ambientUrgent) {
      var mines = Mine.mineList(arena);
      var urgent = false;

      for (var i = 0; i < mines.length; i++) {
        if (mines[i].turns <= 3) { urgent = true; break; }
      }

      if (urgent) {
        var pulse = 0.5 + 0.5 * Math.sin(clock / 320);
        var c = theme.ambientUrgent;
        tint = 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' +
          (0.03 + 0.05 * pulse).toFixed(3) + ')';
      }
    }

    ctx.save();
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, geom.size, geom.size);
    ctx.restore();
  }

  /** 暗角：把注意力收回画面中心。 */
  function drawVignette(ctx, theme) {
    var size = geom.size;

    ctx.save();

    var grad = ctx.createRadialGradient(
      size / 2, size / 2, size * 0.34,
      size / 2, size / 2, size * 0.78
    );
    grad.addColorStop(0, 'rgba(2, 6, 12, 0)');
    grad.addColorStop(0.65, 'rgba(2, 6, 12, 0.2)');
    grad.addColorStop(1, theme.scene.vignette || 'rgba(2, 6, 12, 0.5)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  /**
   * 第 7 层：氛围。光柱 → 边缘层 → 前景粒子 → 环境色偏 → 暗角 →（胜利时）聚焦。
   * 胜利聚焦要先压暗整盘再把五连提到最上，所以放最后，并回调
   * render/board.js 的 drawWinSpotlight。
   */
  function drawAtmosphere(ctx, state, modeId) {
    if (!geom.size) return;

    var theme = Theme.get(Theme.idOf(state, modeId));

    drawShafts(ctx, theme);

    var layer = ensureEdge(ctx, theme);
    if (layer.surface) Art.blitSurface(ctx, layer.surface);

    if (!fronts || frontWeather !== theme.id) initFronts(theme);
    drawFronts(ctx, theme);

    drawAmbient(ctx, state, theme);
    drawVignette(ctx, theme);

    if (state && state.winner !== T.WINNER_NONE && G.Render.Board &&
        G.Render.Board.drawWinSpotlight) {
      G.Render.Board.drawWinSpotlight(ctx, state);
    }
  }

  G.Render.Scene = {
    configure: configure,
    boardRect: boardRect,
    tick: tick,
    resetEffects: resetEffects,
    drawScene: drawScene,
    drawAtmosphere: drawAtmosphere
  };
})();
