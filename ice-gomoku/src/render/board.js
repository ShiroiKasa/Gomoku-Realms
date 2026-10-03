/**
 * 五子奇境 · 棋盘石板与棋子绘制
 *
 * 渲染分七层，顺序固定（由 main.js 的 render() 依次调用）：
 *   1. Render.Scene.drawScene       —— 场景背景（见 render/scene.js，按模式主题）
 *   2. Render.Board.drawBoard       —— 石板（缓存贴图）、格子线、星位
 *   3. Render.Arena.drawArena       —— 场地覆盖物（棋子之下）
 *   4. Render.Board.drawPieces      —— 棋子
 *   5. Render.Arena.drawMinePreview —— 雷区悬停预览
 *   6. Render.Arena.drawArenaOverlay—— 冰块 / 水波 / 水位条 / 雷区数字（棋子之上）
 *   7. Render.Scene.drawAtmosphere  —— 光线、边缘霜/尘/雾、前景粒子、暗角、胜利聚焦
 *
 * 坐标系：逻辑坐标以 CSS 像素为单位，原点在画布左上角。
 * 画布已按 devicePixelRatio 缩放，因此绘制时无需再关心物理像素。
 *
 * 美术约定：
 *  - 「石板」= 棋盘可见表面，其矩形由 Art.boardRectOf 统一给出（与场景层共用口径）；
 *  - 石板的**材质随模式主题变**（见 render/theme.js）：经典是中性冰面、雪山是冰川、
 *    溪流是湿石、雷区是砂岩。石板本体（渐变 + 冰纹 + 霜花 + 颗粒 + 倒角）只在
 *    主题/尺寸变化时生成一次，缓存成离屏贴图；
 *  - 石板上下两色的 RGB 三元组由主题提供，河流淡出直接引用同一份，杜绝两处写歪。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;
  var Art = G.Render.Art;
  var Theme = G.Render.Theme;

  // 几何参数由 configure() 写入，绘制函数只读
  var geom = {
    size: 0,        // 棋盘宽高（CSS 像素）
    margin: 0,      // 石板外留白（= 场景边框宽度）
    origin: 0,      // 第一条线的坐标
    cell: 0,        // 相邻两条线的间距
    dpr: 1          // 设备像素比，用于生成清晰的缓存贴图
  };

  /** 当前帧的主题：由 drawBoard / drawPieces 写入，供棋子光照取色。 */
  var themeNow = Theme.get('classic');

  // 与主题无关的固定色：棋子本体、最后一手标记、五连辉光
  var COLORS = {
    blackFill: '#0c141d',
    blackHighlight: '#42586e',
    blackEdge: 'rgba(3, 8, 14, 0.9)',

    whiteFill: '#e9f2f9',
    whiteHighlight: '#ffffff',
    whiteEdge: 'rgba(126, 158, 184, 0.78)',

    stoneShadow: 'rgba(5, 11, 18, 0.5)',
    stoneSpecular: 'rgba(255, 255, 255, 0.9)',

    lastMoveBlack: 'rgba(134, 220, 255, 0.95)',
    lastMoveWhite: 'rgba(22, 78, 112, 0.9)',

    winLine: '#ffb066',
    winLineCore: '#fff3e0',
    winLineGlow: 'rgba(255, 150, 70, 0.30)',
    winVeil: 'rgba(4, 10, 18, 0.34)'
  };

  var POP_MS = 220;         // 落子弹入动画时长
  var WIN_PULSE_MS = 1600;  // 五连辉光的呼吸周期

  // ── 动画时钟（由 main.js 的主循环推进）──────────────────────────────────
  var clock = 0;
  var lastClock = 0;
  var popStamp = '';        // 已播放过弹入动画的那一手
  var popAt = -1e9;
  var winOn = false;
  var winAt = 0;

  /** 推进本模块的动画时钟。 */
  function tick(nowMs) {
    if (lastClock === 0) lastClock = nowMs;

    clock += Math.max(0, nowMs - lastClock);
    lastClock = nowMs;
  }

  /** 清空动画痕迹（重开时调用）。 */
  function resetEffects() {
    popStamp = '';
    popAt = -1e9;
    winOn = false;
    winAt = 0;
    lastClock = clock;
  }

  // ── 几何 ────────────────────────────────────────────────────────────────

  /** 写入几何参数。size 为画布边长，margin 为石板外留白，dpr 为设备像素比。 */
  function configure(size, margin, dpr) {
    geom.size = size;
    geom.margin = margin;
    geom.origin = margin;
    geom.dpr = dpr > 0 ? dpr : 1;

    // 先按默认路数算一次格距：configure 之后、首次绘制之前也可能被问到
    // 坐标（命中判定就靠 pixelToPoint），此时 geom.cell 不能是 0。
    geom.cell = (size - margin * 2) / (T.DEFAULT_SIZE - 1);

    plate = null;
  }

  /** 取当前对局的路数，并据此更新格距。 */
  function gridSizeOf(state) {
    var n = state && state.size ? state.size : T.DEFAULT_SIZE;
    geom.cell = (geom.size - geom.margin * 2) / (n - 1);
    return n;
  }

  /** 交叉点 → 画布坐标。 */
  function pointToPixel(x, y) {
    return {
      px: geom.origin + x * geom.cell,
      py: geom.origin + y * geom.cell
    };
  }

  /** 画布坐标 → 最近的交叉点。 */
  function pixelToPoint(px, py) {
    return {
      x: Math.round((px - geom.origin) / geom.cell),
      y: Math.round((py - geom.origin) / geom.cell)
    };
  }

  /** 交叉点到画布坐标的像素距离，用于点击容差判断。 */
  function distanceToPoint(px, py, x, y) {
    var p = pointToPixel(x, y);
    return Math.hypot(px - p.px, py - p.py);
  }

  /** 石板矩形（棋盘可见表面）。arena 也用它裁剪，两边必须同口径。 */
  function slabRect(state) {
    return Art.boardRectOf(geom, gridSizeOf(state));
  }

  /** 石板圆角半径。 */
  function slabRadius() {
    return Art.slabRadiusOf(geom);
  }

  // ── 石板贴图（只在尺寸变化时重建）──────────────────────────────────────

  var plate = null;

  /**
   * 取当前主题与尺寸的石板贴图，必要时重建。
   * 贴图铺满整张画布：石板之外是透明的（含石板的外发光与落影），
   * 因此它必须画在场景背景之上，透明处自然露出岩壁。
   */
  function ensurePlate(state, theme) {
    var n = gridSizeOf(state);
    var key = theme.id + '|' + geom.size + '|' + geom.margin + '|' + geom.dpr + '|' + n;

    if (plate && plate.key === key) return plate;

    var rect = Art.boardRectOf(geom, n);
    var radius = Art.slabRadiusOf(geom);
    var surface = Art.createSurface(geom.size, geom.size, geom.dpr);

    if (surface) paintPlate(surface.ctx, rect, radius, theme);

    plate = {
      key: key,
      rect: rect,
      radius: radius,
      surface: surface
    };

    return plate;
  }

  /** 层理纹理：石板里斜向的细长亮纹（冰层 / 石纹 / 岩层）。 */
  function paintIceStrata(ctx, rect, rng, theme) {
    if (theme.slab.strata <= 0) return;

    var count = Math.round(30 * theme.slab.strata) + 8;

    ctx.save();
    ctx.lineCap = 'round';

    for (var i = 0; i < count; i++) {
      var x = rect.x + rng() * rect.width;
      var y = rect.y + rng() * rect.height;
      var len = rect.width * (0.10 + rng() * 0.42);
      var ang = (rng() - 0.5) * 0.42;

      ctx.globalAlpha = (0.05 + rng() * 0.11) * (0.5 + theme.slab.strata * 0.7);
      ctx.strokeStyle = rng() > 0.28 ? '#ffffff' : theme.slab.speckDark;
      ctx.lineWidth = 1 + rng() * 2.6;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** 石板内缘的霜花：沿四条边向内长出冰晶细枝（非冰系主题可关掉）。 */
  function paintFrostBorder(ctx, rect, rng, theme) {
    if (theme.slab.frost <= 0) return;

    var unit = Math.max(0.55, geom.cell / 40);
    var count = Math.round(46 * theme.slab.frost) + 6;

    for (var i = 0; i < count; i++) {
      var side = Math.floor(rng() * 4);
      var t = rng();
      var depth = 2 + rng() * Math.max(9, geom.cell * 0.55);
      var x, y, angle;

      if (side === 0) {
        x = rect.x + t * rect.width;
        y = rect.y + depth;
        angle = Math.PI / 2 + (rng() - 0.5) * 1.0;
      } else if (side === 1) {
        x = rect.x + rect.width - depth;
        y = rect.y + t * rect.height;
        angle = Math.PI + (rng() - 0.5) * 1.0;
      } else if (side === 2) {
        x = rect.x + t * rect.width;
        y = rect.y + rect.height - depth;
        angle = -Math.PI / 2 + (rng() - 0.5) * 1.0;
      } else {
        x = rect.x + depth;
        y = rect.y + t * rect.height;
        angle = (rng() - 0.5) * 1.0;
      }

      Art.frostSprig(
        ctx, x, y,
        (7 + rng() * 17) * unit,
        angle,
        (0.05 + rng() * 0.12) * theme.slab.frost,
        (0.7 + rng() * 0.7) * unit,
        rng
      );
    }
  }

  /** 颗粒：细小的亮点与暗点，让平面不平（冰晶 / 沙粒 / 卵石）。 */
  function paintSpeckles(ctx, rect, rng, theme) {
    var count = Math.round(1100 * theme.slab.speckle);

    for (var i = 0; i < count; i++) {
      var x = rect.x + rng() * rect.width;
      var y = rect.y + rng() * rect.height;
      var size = 0.5 + rng() * 1.5;

      ctx.globalAlpha = 0.04 + rng() * 0.12;
      ctx.fillStyle = rng() > 0.42 ? theme.slab.speckLight : theme.slab.speckDark;
      ctx.fillRect(x, y, size, size);
    }

    ctx.globalAlpha = 1;
  }

  /** 石板内缘的厚度感：四边向内渐暗 + 顶部一道亮边。 */
  function paintInnerShade(ctx, rect, theme) {
    var d = Math.max(11, geom.cell * 0.44);
    var w = rect.width;
    var h = rect.height;
    var ink = theme.slab.inner;

    var top = ctx.createLinearGradient(0, rect.y, 0, rect.y + d);
    top.addColorStop(0, ink);
    top.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = top;
    ctx.fillRect(rect.x, rect.y, w, d);

    var bottom = ctx.createLinearGradient(0, rect.y + h - d, 0, rect.y + h);
    bottom.addColorStop(0, 'rgba(0, 0, 0, 0)');
    bottom.addColorStop(1, ink);
    ctx.fillStyle = bottom;
    ctx.fillRect(rect.x, rect.y + h - d, w, d);

    var left = ctx.createLinearGradient(rect.x, 0, rect.x + d, 0);
    left.addColorStop(0, ink);
    left.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = left;
    ctx.fillRect(rect.x, rect.y, d, h);

    var right = ctx.createLinearGradient(rect.x + w - d, 0, rect.x + w, 0);
    right.addColorStop(0, 'rgba(0, 0, 0, 0)');
    right.addColorStop(1, ink);
    ctx.fillStyle = right;
    ctx.fillRect(rect.x + w - d, rect.y, d, h);

    // 顶部受光的一道亮边
    ctx.fillStyle = theme.slab.shine;
    ctx.fillRect(rect.x + 1, rect.y + 1, w - 2, 1.2);
  }

  /** 画石板本体（缓存贴图的绘制内容），材质全部来自主题。 */
  function paintPlate(ctx, rect, radius, theme) {
    var slab = theme.slab;
    var rng = Art.rngFrom(0x5A17B0 ^ (theme.id.length * 131));
    var w = rect.width;
    var h = rect.height;

    // ① 外发光：石板像嵌在会发光的背景里
    ctx.save();
    ctx.shadowColor = slab.rimMid;
    ctx.shadowBlur = Math.max(10, geom.cell * 0.52);
    ctx.strokeStyle = slab.rimLight;
    ctx.lineWidth = 1.6;
    Art.roundRectPath(ctx, rect.x, rect.y, w, h, radius);
    ctx.stroke();
    ctx.restore();

    // ② 落影：四层递扩的圆角矩形伪造柔和的投影
    for (var s = 4; s >= 1; s--) {
      var grow = s * Math.max(3, geom.cell * 0.13);
      ctx.fillStyle = 'rgba(2, 7, 13, ' + (0.05 + 0.028 * (4 - s)).toFixed(3) + ')';
      Art.roundRectPath(
        ctx,
        rect.x - grow * 0.42 + 1,
        rect.y - grow * 0.42 + grow * 0.95,
        w + grow * 0.84,
        h + grow * 0.84,
        radius + grow * 0.5
      );
      ctx.fill();
    }

    // ③ 石板表面：全部裁剪在圆角内
    ctx.save();
    Art.clipRoundRect(ctx, rect.x, rect.y, w, h, radius);

    var base = ctx.createLinearGradient(0, rect.y, 0, rect.y + h);
    base.addColorStop(0, slab.top);
    base.addColorStop(0.52, slab.mid);
    base.addColorStop(1, slab.bottom);
    ctx.fillStyle = base;
    ctx.fillRect(rect.x, rect.y, w, h);

    // 左上大面积柔光 + 右下阴影，撑出体积
    Art.softEllipse(ctx, rect.x + w * 0.26, rect.y + h * 0.13, w * 0.74, h * 0.56,
      slab.shine, 'rgba(255, 255, 255, 0)');
    Art.softEllipse(ctx, rect.x + w * 0.9, rect.y + h * 0.96, w * 0.64, h * 0.48,
      slab.shade, 'rgba(0, 0, 0, 0)');

    paintIceStrata(ctx, rect, rng, theme);
    paintFrostBorder(ctx, rect, rng, theme);
    paintSpeckles(ctx, rect, rng, theme);
    paintInnerShade(ctx, rect, theme);

    ctx.restore();

    // ④ 内圈倒角：左上亮、右下暗，做出石板的厚度
    var bevel = ctx.createLinearGradient(rect.x, rect.y, rect.x + w, rect.y + h);
    bevel.addColorStop(0, slab.bevelLight);
    bevel.addColorStop(0.45, slab.bevelMid);
    bevel.addColorStop(1, slab.bevelDark);

    ctx.strokeStyle = bevel;
    ctx.lineWidth = 2;
    Art.roundRectPath(ctx, rect.x + 1, rect.y + 1, w - 2, h - 2, Math.max(2, radius - 1));
    ctx.stroke();

    // ⑤ 外圈
    var rim = ctx.createLinearGradient(rect.x, rect.y, rect.x + w, rect.y + h);
    rim.addColorStop(0, slab.rimLight);
    rim.addColorStop(0.5, slab.rimMid);
    rim.addColorStop(1, slab.rimDark);

    ctx.strokeStyle = rim;
    ctx.lineWidth = 2.4;
    Art.roundRectPath(ctx, rect.x, rect.y, w, h, radius);
    ctx.stroke();
  }

  /** 没有离屏画布时的退路：直接画一层渐变石板（丢失纹理细节，但保证能看）。 */
  function drawPlateFallback(ctx, rect, radius, theme) {
    var slab = theme.slab;
    var base = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
    base.addColorStop(0, slab.top);
    base.addColorStop(0.52, slab.mid);
    base.addColorStop(1, slab.bottom);

    ctx.save();
    ctx.fillStyle = base;
    Art.roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius);
    ctx.fill();

    ctx.strokeStyle = slab.rimLight;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // ── 格子线 ──────────────────────────────────────────────────────────────

  /**
   * 棋盘线：一条暗刻痕 + 一条偏右下的高光，读起来像被划出的凹槽。
   * 线宽 1 落在整数坐标上会糊，统一偏移半像素。
   */
  function drawGrid(ctx, n, theme) {
    var slab = theme.slab;
    var start = geom.origin;
    var end = geom.origin + (n - 1) * geom.cell;
    var i, pos;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (i = 0; i < n; i++) {
      pos = Math.round(geom.origin + i * geom.cell) + 0.5;
      ctx.moveTo(pos, start);
      ctx.lineTo(pos, end);
      ctx.moveTo(start, pos);
      ctx.lineTo(end, pos);
    }
    ctx.strokeStyle = slab.grid;
    ctx.stroke();

    ctx.beginPath();
    for (i = 0; i < n; i++) {
      pos = Math.round(geom.origin + i * geom.cell) + 1.5;
      ctx.moveTo(pos, start);
      ctx.lineTo(pos, end);
      ctx.moveTo(start, pos);
      ctx.lineTo(end, pos);
    }
    ctx.strokeStyle = slab.gridHi;
    ctx.stroke();

    // 最外圈加重，棋盘边界更清晰
    ctx.strokeStyle = slab.gridEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(start, start, end - start, end - start);
    ctx.restore();
  }

  /** 星位：一枚嵌进石面的小菱形晶体。 */
  function drawStarPoints(ctx, n, theme) {
    var slab = theme.slab;
    var points = B.starPoints({ size: n });
    var r = Math.max(2, geom.cell * 0.085);

    ctx.save();
    for (var i = 0; i < points.length; i++) {
      var p = pointToPixel(points[i].x, points[i].y);

      Art.starPath(ctx, p.px, p.py, r * 1.7, r * 0.5, 4, Math.PI / 4);
      ctx.fillStyle = slab.point;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.px - r * 0.42, p.py - r * 0.42, Math.max(0.7, r * 0.42), 0, Math.PI * 2);
      ctx.fillStyle = slab.pointSpark;
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 第二层：石板 + 格子线 + 星位。
   * @param {string} [modeId] 显式模式 id（决定石板材质；缺省按 arenaState 推断）
   */
  function drawBoard(ctx, state, modeId) {
    var n = gridSizeOf(state);
    var theme = Theme.get(Theme.idOf(state, modeId));
    var entry = ensurePlate(state, theme);

    themeNow = theme;

    ctx.save();

    if (!entry.surface || !Art.blitSurface(ctx, entry.surface)) {
      drawPlateFallback(ctx, entry.rect, entry.radius, theme);
    }

    drawGrid(ctx, n, theme);
    drawStarPoints(ctx, n, theme);
    ctx.restore();
  }

  // ── 棋子 ────────────────────────────────────────────────────────────────

  /**
   * 棋子渐变缓存。
   *
   * 渐变坐标写在「以棋子中心为原点」的局部空间里：画的时候先 translate 到棋子位置，
   * 渐变随当前变换矩阵走，因此同一颗半径的所有棋子可以共用同一个渐变对象。
   * 满盘 225 颗棋子若每帧各建 5 个渐变，光垃圾回收就够呛，这里只建一次。
   */
  var gradCache = { owner: null, map: {} };

  function gradientsFor(ctx, radius, player, theme) {
    if (gradCache.owner !== ctx) {
      gradCache.owner = ctx;
      gradCache.map = {};
    }

    var key = theme.id + '|' + player + '|' + Math.round(radius * 8);
    if (gradCache.map[key]) return gradCache.map[key];

    var r = radius;
    var isBlack = player === T.BLACK;
    var halo = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.14);

    if (isBlack) {
      halo.addColorStop(0, 'rgba(5, 11, 18, 0.52)');
      halo.addColorStop(1, 'rgba(5, 11, 18, 0)');
    } else {
      halo.addColorStop(0, 'rgba(8, 16, 26, 0.38)');
      halo.addColorStop(1, 'rgba(8, 16, 26, 0)');
    }

    var body = ctx.createRadialGradient(
      -r * 0.36, -r * 0.42, r * 0.10,
      0, 0, r * 1.06
    );

    if (isBlack) {
      body.addColorStop(0, COLORS.blackHighlight);
      body.addColorStop(0.5, '#1d2b3a');
      body.addColorStop(1, COLORS.blackFill);
    } else {
      body.addColorStop(0, COLORS.whiteHighlight);
      body.addColorStop(0.58, COLORS.whiteFill);
      body.addColorStop(1, '#c2d8e9');
    }

    // 下缘反光跟着场景走：冰蓝 / 青绿 / 暖橙
    var rim = ctx.createRadialGradient(0, r * 0.46, r * 0.1, 0, r * 0.46, r * 1.05);

    if (isBlack) {
      rim.addColorStop(0, theme.stone.rim);
      rim.addColorStop(1, 'rgba(0, 0, 0, 0)');
    } else {
      rim.addColorStop(0, theme.stone.whiteRim);
      rim.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }

    var set = {
      halo: halo,
      body: body,
      rim: rim,
      edge: isBlack ? COLORS.blackEdge : COLORS.whiteEdge,
      arcHi: isBlack ? theme.stone.arc : 'rgba(255, 255, 255, 0.95)'
    };

    gradCache.map[key] = set;
    return set;
  }

  /**
   * 画一颗棋子：接地阴影 → 主体体积 → 下缘环境反光 → 高光 → 描边 → 顶部反光弧。
   * 高光位置按棋子坐标做确定性微差，避免整盘棋子像同一个模子刻出来的。
   *
   * @param {boolean} [ghost] 半透明预览（鼠标悬停）
   */
  function drawStone(ctx, px, py, player, ghost) {
    var r = geom.cell * T.STONE_RADIUS_RATIO;
    var seed = Art.hash01(Math.round(px * 3.1), Math.round(py * 3.7));
    var tilt = (seed - 0.5) * 0.85;
    var g = gradientsFor(ctx, r, player, themeNow);

    ctx.save();
    // 与调用方已设的透明度相乘（落子弹入要淡入，不能直接覆盖）
    ctx.globalAlpha = ctx.globalAlpha * (ghost ? 0.42 : 1);
    ctx.translate(px, py);

    // ① 接地阴影
    ctx.save();
    ctx.translate(0, r * 0.26);
    ctx.scale(1, 0.42);
    ctx.fillStyle = g.halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ② 主体
    ctx.fillStyle = g.body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // ③ 下缘环境反光（冰川冷光打在棋子下沿）：裁进圆内，用缓存渐变填满
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();

    ctx.beginPath();
    ctx.arc(0, r * 0.46, r * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = g.rim;
    ctx.fill();
    ctx.restore();

    // ④ 高光斑
    ctx.save();
    ctx.translate(-r * 0.33 + tilt * r * 0.16, -r * 0.38 + tilt * r * 0.08);
    ctx.rotate(-0.55 + tilt * 0.6);
    ctx.scale(1, 0.6);
    ctx.fillStyle = COLORS.stoneSpecular;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ⑤ 描边：浅色棋在浅色石板上靠它拉开边界
    ctx.lineWidth = Math.max(1, r * 0.075);
    ctx.strokeStyle = g.edge;
    ctx.beginPath();
    ctx.arc(0, 0, r - ctx.lineWidth * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // ⑥ 顶部反光弧
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.84, Math.PI * 1.14, Math.PI * 1.7);
    ctx.strokeStyle = g.arcHi;
    ctx.lineWidth = Math.max(1, r * 0.085);
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 最后一手的落点标记：格心一枚对比色小点 + 一圈呼吸光晕。
   * @param {boolean} [fresh] 是否刚落下（额外来一圈扩散环）
   */
  function drawLastMoveMark(ctx, px, py, player, fresh) {
    var r = geom.cell * T.STONE_RADIUS_RATIO;
    var breathe = 0.5 + 0.5 * Math.sin((clock % WIN_PULSE_MS) / WIN_PULSE_MS * Math.PI * 2);
    var color = player === T.BLACK ? COLORS.lastMoveBlack : COLORS.lastMoveWhite;

    ctx.save();

    Art.softEllipse(ctx, px, py, r * (0.72 + 0.16 * breathe), r * (0.72 + 0.16 * breathe),
      player === T.BLACK ? 'rgba(134, 220, 255, 0.28)' : 'rgba(22, 78, 112, 0.24)',
      'rgba(255, 255, 255, 0)');

    ctx.beginPath();
    ctx.arc(px, py, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (fresh) {
      var age = clock - popAt;
      if (age >= 0 && age < POP_MS * 1.5) {
        var t = age / (POP_MS * 1.5);
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, geom.cell * 0.045 * (1 - t));
        ctx.beginPath();
        ctx.arc(px, py, r * (0.55 + 0.7 * t), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** 五连的呼吸辉光：层层加宽的暖色描边 + 沿线跳动的星芒。 */
  function drawWinningLine(ctx, line, glowOnly) {
    if (!line || line.length < 2) return;

    var first = pointToPixel(line[0].x, line[0].y);
    var last = pointToPixel(line[line.length - 1].x, line[line.length - 1].y);
    var breathe = 0.5 + 0.5 * Math.sin((clock % WIN_PULSE_MS) / WIN_PULSE_MS * Math.PI * 2);
    var base = geom.cell * T.WIN_LINE_WIDTH_RATIO;

    ctx.save();
    ctx.lineCap = 'round';

    // 外圈柔光：用三层递减 alpha 的粗线代替 shadowBlur，省一次昂贵的模糊
    var layers = [
      { w: base * 5.2, a: 0.10 + 0.06 * breathe, c: COLORS.winLineGlow },
      { w: base * 3.0, a: 0.16 + 0.10 * breathe, c: COLORS.winLineGlow },
      { w: base * 1.9, a: 0.55 + 0.20 * breathe, c: COLORS.winLine }
    ];

    for (var i = 0; i < layers.length; i++) {
      ctx.globalAlpha = layers[i].a;
      ctx.strokeStyle = layers[i].c;
      ctx.lineWidth = layers[i].w;
      ctx.beginPath();
      ctx.moveTo(first.px, first.py);
      ctx.lineTo(last.px, last.py);
      ctx.stroke();
    }

    // 内芯：一条几乎白色的细线，让连线读起来是「发光的」
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = COLORS.winLineCore;
    ctx.lineWidth = Math.max(1.4, base * 0.6);
    ctx.beginPath();
    ctx.moveTo(first.px, first.py);
    ctx.lineTo(last.px, last.py);
    ctx.stroke();

    if (glowOnly) {
      ctx.restore();
      return;
    }

    // 沿线跳动的星芒：每颗棋子一个，相位依次错开
    var dx = last.px - first.px;
    var dy = last.py - first.py;
    var len = Math.hypot(dx, dy) || 1;

    for (var k = 0; k < line.length; k++) {
      var t = line.length === 1 ? 0.5 : k / (line.length - 1);
      var phase = ((clock % 900) / 900 + t * 0.5) % 1;
      var flick = Math.pow(Math.sin(phase * Math.PI), 2);
      var px = first.px + dx * t;
      var py = first.py + dy * t;
      var size = geom.cell * (0.18 + 0.22 * flick);

      ctx.globalAlpha = 0.5 + 0.5 * flick;
      ctx.fillStyle = '#fff6e6';
      Art.starPath(ctx, px, py, size, size * 0.26, 4, Math.PI / 4 + (clock % 4000) / 4000);
      ctx.fill();
    }

    // 两端各点一颗更大的光点
    ctx.globalAlpha = 0.55 + 0.35 * breathe;
    Art.softEllipse(ctx, first.px, first.py, geom.cell * 0.7, geom.cell * 0.7,
      'rgba(255, 196, 130, 0.7)', 'rgba(255, 196, 130, 0)');
    Art.softEllipse(ctx, last.px, last.py, geom.cell * 0.7, geom.cell * 0.7,
      'rgba(255, 196, 130, 0.7)', 'rgba(255, 196, 130, 0)');

    ctx.restore();
  }

  /**
   * 胜利聚焦：整盘压暗，再把五连的辉光重新提到最上层。
   * 由 render/arena.js 的 drawAtmosphere 在所有内容之上调用（见该文件注释）。
   */
  function drawWinSpotlight(ctx, state) {
    if (!state || !state.winningLine || state.winningLine.length < 2) return;

    ctx.save();
    ctx.fillStyle = COLORS.winVeil;
    ctx.fillRect(0, 0, geom.size, geom.size);
    ctx.restore();

    drawWinningLine(ctx, state.winningLine, true);
  }

  /**
   * 第四层：棋子。
   *
   * 顺带在这里做两件只跟画面有关的事：
   *  - 认出「新落的一手」，给它一段弹入动画；
   *  - 认出「刚成五」，给五连辉光一个起始时刻。
   *
   * @param {object} state GameState
   * @param {object|null} [ghost] { x, y, player } 鼠标悬停预览
   * @param {string} [modeId] 显式模式 id（决定棋子下缘反光取哪个场景的色）
   */
  function drawPieces(ctx, state, ghost, modeId) {
    var board = state;
    var n = gridSizeOf(state);

    themeNow = Theme.get(Theme.idOf(state, modeId));

    // 新落一手 / 刚成五：只记时间戳，不改任何游戏数据
    var stamp = state.lastMove
      ? T.cellKey(state.lastMove.x, state.lastMove.y) + '#' +
        (state.history ? state.history.length : 0)
      : '';

    if (stamp !== popStamp) {
      popStamp = stamp;
      if (stamp) popAt = clock;
    }

    if (state.winningLine && state.winningLine.length >= 2) {
      if (!winOn) {
        winOn = true;
        winAt = clock;
      }
    } else {
      winOn = false;
    }

    ctx.save();

    // 悬停预览先画，避免盖住已落下的棋子
    if (ghost && B.isEmpty(board, ghost.x, ghost.y)) {
      var gp = pointToPixel(ghost.x, ghost.y);
      drawStone(ctx, gp.px, gp.py, ghost.player, true);
    }

    var isLast = state.lastMove && state.winner === T.WINNER_NONE;

    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var player = B.getCell(board, x, y);
        if (player === T.EMPTY) continue;

        var p = pointToPixel(x, y);

        // 弹入动画：以格心为轴放大，从 0.7 收到 1（略微过冲）
        if (isLast && x === state.lastMove.x && y === state.lastMove.y) {
          var age = clock - popAt;
          if (age >= 0 && age < POP_MS) {
            var t = age / POP_MS;
            var back = 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
            var scale = 0.7 + 0.3 * back;

            ctx.save();
            ctx.globalAlpha = 0.55 + 0.45 * Math.min(1, t * 1.6);
            ctx.translate(p.px, p.py);
            ctx.scale(scale, scale);
            ctx.translate(-p.px, -p.py);
            drawStone(ctx, p.px, p.py, player, false);
            ctx.restore();
            continue;
          }
        }

        drawStone(ctx, p.px, p.py, player, false);
      }
    }

    if (isLast) {
      var lp = pointToPixel(state.lastMove.x, state.lastMove.y);
      drawLastMoveMark(ctx, lp.px, lp.py, state.lastMove.player, true);
    }

    if (state.winningLine) {
      drawWinningLine(ctx, state.winningLine, false);
    }

    ctx.restore();
  }

  /** 取当前几何参数（只读副本），供命中判定等外部逻辑使用。 */
  function geometry() {
    return {
      size: geom.size,
      margin: geom.margin,
      origin: geom.origin,
      cell: geom.cell,
      dpr: geom.dpr
    };
  }

  G.Render.Board = {
    COLORS: COLORS,
    configure: configure,
    geometry: geometry,
    pointToPixel: pointToPixel,
    pixelToPoint: pixelToPoint,
    distanceToPoint: distanceToPoint,
    slabRect: slabRect,
    slabRadius: slabRadius,
    tick: tick,
    resetEffects: resetEffects,
    drawBoard: drawBoard,
    drawPieces: drawPieces,
    drawStone: drawStone,
    drawWinSpotlight: drawWinSpotlight
  };
})();
