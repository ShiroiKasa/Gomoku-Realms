/**
 * 五子奇境 · 渲染层公共绘制工具
 *
 * 定位：只放「不读任何状态、不碰任何规则」的纯绘制工具与小数学函数。
 * 载入顺序在 render/board.js 与 render/arena.js **之前**（两者都依赖本文件）。
 *
 * 约定：
 *  - 本文件不持有动画状态、不引用 state、不修改任何游戏数据；
 *  - 所有函数只吃参数、只画图，方便两边共用同一套几何与配色口径；
 *  - 与场地/棋盘相关的几何（boardRect / slabRadius）也放在这里，避免两处各算一遍。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});

  // ── 小数学 ──────────────────────────────────────────────────────────────

  function clamp(value, lo, hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * 确定性伪随机：同样的 (a, b) 永远得到同一个 0..1 的数。
   * 用于「纹理只生成一次」和「每格棋子的高光微差」——不允许用 Math.random，
   * 否则每帧重画会闪。
   */
  function hash01(a, b) {
    var n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }

  /**
   * 确定性随机数发生器（mulberry32）。
   * 贴图只生成一次，但每次生成必须长得一模一样——不能用 Math.random。
   *
   * @param {number} seed
   * @returns {function():number} 0..1
   */
  function rngFrom(seed) {
    var s = (seed || 1) >>> 0;

    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** [r, g, b] + alpha → CSS 颜色串。 */
  function rgba(rgb, alpha) {
    return 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' +
      Math.round(rgb[2]) + ',' + alpha + ')';
  }

  /** 两个 [r, g, b] 之间线性插值，返回新的数组。 */
  function mixRgb(a, b, t) {
    var k = clamp(t, 0, 1);
    return [
      lerp(a[0], b[0], k),
      lerp(a[1], b[1], k),
      lerp(a[2], b[2], k)
    ];
  }

  // ── 几何 ────────────────────────────────────────────────────────────────

  /**
   * 棋盘「石板」矩形（CSS 像素）：网格外沿再多半格，保证边线上的棋子完整落在石板上。
   * render/board.js 与 render/arena.js 共用此口径（历史坑：两处各算一遍容易错开）。
   *
   * @param {{origin:number, cell:number}} geom 已写入格距的几何参数
   * @param {number} n 路数
   */
  function boardRectOf(geom, n) {
    var half = geom.cell / 2;
    var start = geom.origin - half;
    var span = (n - 1) * geom.cell + geom.cell;

    return { x: start, y: start, width: span, height: span };
  }

  /** 石板的圆角半径：随格距走，但夹在一个好看的区间里。 */
  function slabRadiusOf(geom) {
    return clamp(geom.cell * 0.46, 10, 20);
  }

  // ── 路径 ────────────────────────────────────────────────────────────────

  /** 圆角矩形路径（不 fill / 不 stroke，只铺路径）。 */
  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = clamp(r, 0, Math.min(w, h) / 2);

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  /** 把后续绘制裁剪进一个圆角矩形。 */
  function clipRoundRect(ctx, x, y, w, h, r) {
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
  }

  /** 星形 / 雪花路径：外半径与内半径交替。 */
  function starPath(ctx, cx, cy, outer, inner, points, rot) {
    var count = Math.max(3, points | 0);
    var r0 = rot || 0;

    ctx.beginPath();
    for (var i = 0; i < count * 2; i++) {
      var a = r0 + (Math.PI * i) / count;
      var r = i % 2 === 0 ? outer : inner;
      var px = cx + Math.cos(a) * r;
      var py = cy + Math.sin(a) * r;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  // ── 光与雪 ──────────────────────────────────────────────────────────────

  /**
   * 柔和的椭圆光斑 / 阴影：用缩放的正圆画径向渐变，避免依赖 ellipse()。
   * @param {string} inner 中心色（含 alpha）
   * @param {string} outer 边缘色（通常是同色 alpha 0）
   */
  function softEllipse(ctx, cx, cy, rx, ry, inner, outer) {
    if (!(rx > 0) || !(ry > 0)) return;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);

    var grad = ctx.createRadialGradient(0, 0, rx * 0.18, 0, 0, rx);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 霜花细枝：一根主干 + 两三根侧枝 + 顶端亮点。
   * 用于石板边缘的结霜与画布四角的霜层（都只生成一次，缓存成贴图）。
   *
   * @param {function():number} rng 0..1 随机源（确定性）
   */
  function frostSprig(ctx, x, y, len, angle, alpha, lineWidth, rng) {
    if (!(len > 0)) return;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 主干
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();

    // 侧枝：左右交替，越靠顶端越短
    var branches = 2 + Math.floor(rng() * 3);

    for (var i = 0; i < branches; i++) {
      var at = len * (0.24 + 0.62 * ((i + 0.5) / branches));
      var bl = len * (0.34 - 0.18 * (i / branches)) * (0.7 + rng() * 0.6);
      var spread = 0.62 + rng() * 0.5;

      ctx.beginPath();
      ctx.moveTo(at, 0);
      ctx.lineTo(at + Math.cos(-spread) * bl, Math.sin(-spread) * bl);
      ctx.moveTo(at, 0);
      ctx.lineTo(at + Math.cos(spread) * bl, Math.sin(spread) * bl);
      ctx.stroke();
    }

    // 顶端亮点
    ctx.fillStyle = 'rgba(255,255,255,' + (alpha * 1.6).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(len, 0, Math.max(0.4, lineWidth * 0.9), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── 离屏贴图 ────────────────────────────────────────────────────────────

  /**
   * 建一张离屏画布，供「每帧都要画、但内容不变」的纹理缓存使用。
   * 环境不支持（或被测试桩挡住）时返回 null，调用方必须退回直绘路径。
   *
   * @param {number} w 逻辑宽（CSS 像素）
   * @param {number} h 逻辑高
   * @param {number} dpr 设备像素比，后备缓冲按它放大以免高分屏发糊
   * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D,
   *            width:number, height:number, scale:number}|null}
   */
  function createSurface(w, h, dpr) {
    if (typeof document === 'undefined' || !document.createElement) return null;

    var scale = dpr > 0 ? dpr : 1;
    var canvas;

    try {
      canvas = document.createElement('canvas');
    } catch (err) {
      return null;
    }

    if (!canvas || typeof canvas.getContext !== 'function') return null;

    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (ctx.setTransform) ctx.setTransform(scale, 0, 0, scale, 0, 0);

    return {
      canvas: canvas,
      ctx: ctx,
      width: w,
      height: h,
      scale: scale
    };
  }

  /** 把缓存贴图贴回主画布（按逻辑尺寸，避免 DPR 二次缩放）。 */
  function blitSurface(ctx, surface) {
    if (!surface || !surface.canvas) return false;

    ctx.drawImage(surface.canvas, 0, 0, surface.width, surface.height);
    return true;
  }

  G.Render = G.Render || {};
  G.Render.Art = {
    clamp: clamp,
    lerp: lerp,
    hash01: hash01,
    rngFrom: rngFrom,
    rgba: rgba,
    mixRgb: mixRgb,

    boardRectOf: boardRectOf,
    slabRadiusOf: slabRadiusOf,

    roundRectPath: roundRectPath,
    clipRoundRect: clipRoundRect,
    starPath: starPath,

    softEllipse: softEllipse,
    frostSprig: frostSprig,

    createSurface: createSurface,
    blitSurface: blitSurface
  };
})();
