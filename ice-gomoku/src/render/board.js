/**
 * 五子奇境 · 棋盘与棋子绘制
 *
 * 渲染分三层，顺序固定（由 main.js 依次调用）：
 *   1. Render.Board.drawBoard  —— 底色与格子线
 *   2. Render.Arena.drawArena  —— 场地覆盖物（见 render/arena.js）
 *   3. Render.Board.drawPieces —— 棋子
 *
 * 坐标系：逻辑坐标以 CSS 像素为单位，原点在画布左上角。
 * 画布已按 devicePixelRatio 缩放，因此绘制时无需再关心物理像素。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  // 几何参数由 configure() 写入，绘制函数只读
  var geom = {
    size: 0,        // 棋盘宽高（CSS 像素）
    margin: 0,      // 棋盘外留白
    origin: 0,      // 第一条线的坐标
    cell: 0         // 相邻两条线的间距
  };

  // 冰川色系（与雪山洞穴场地一致）
  var COLORS = {
    boardTop: '#eef7fd',
    boardBottom: '#bcd8ec',
    gridLine: 'rgba(34, 74, 106, 0.55)',
    gridEdge: 'rgba(28, 60, 88, 0.72)',
    starPoint: 'rgba(34, 74, 106, 0.72)',
    blackFill: '#101a24',
    blackHighlight: 'rgba(255, 255, 255, 0.34)',
    blackEdge: 'rgba(0, 0, 0, 0.85)',
    whiteFill: '#f4f8fc',
    whiteHighlight: 'rgba(255, 255, 255, 0.95)',
    whiteEdge: 'rgba(146, 172, 192, 0.9)',
    shadow: 'rgba(6, 16, 26, 0.38)',
    winLine: '#ff8a4c',
    winLineGlow: 'rgba(255, 138, 76, 0.34)'
  };

  /** 写入几何参数。size 为画布边长，margin 为棋盘外留白。 */
  function configure(size, margin) {
    geom.size = size;
    geom.margin = margin;
    geom.origin = margin;
    // 先按默认路数算一次格距：configure 之后、首次绘制之前也可能被问到
    // 坐标（命中判定就靠 pixelToPoint），此时 geom.cell 不能是 0。
    geom.cell = (size - margin * 2) / (T.DEFAULT_SIZE - 1);
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

  // ── 棋盘底色与格子线 ────────────────────────────────────────────────────

  function drawBoardBackground(ctx) {
    var grad = ctx.createLinearGradient(0, 0, 0, geom.size);
    grad.addColorStop(0, COLORS.boardTop);
    grad.addColorStop(1, COLORS.boardBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, geom.size, geom.size);
  }

  function drawGrid(ctx, n) {
    var start = geom.origin;
    var end = geom.origin + (n - 1) * geom.cell;

    ctx.save();
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    // 线宽 1 落在整数坐标上会糊，偏移半像素让线条锐利
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var pos = Math.round(geom.origin + i * geom.cell) + 0.5;
      ctx.moveTo(pos, start);
      ctx.lineTo(pos, end);
      ctx.moveTo(start, pos);
      ctx.lineTo(end, pos);
    }
    ctx.stroke();

    // 最外圈加重，棋盘边界更清晰
    ctx.strokeStyle = COLORS.gridEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(start, start, end - start, end - start);
    ctx.restore();
  }

  function drawStarPoints(ctx, n) {
    var points = B.starPoints({ size: n });
    var radius = Math.max(2, geom.cell * 0.09);

    ctx.save();
    ctx.fillStyle = COLORS.starPoint;
    for (var i = 0; i < points.length; i++) {
      var p = pointToPixel(points[i].x, points[i].y);
      ctx.beginPath();
      ctx.arc(p.px, p.py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 第一层：棋盘。 */
  function drawBoard(ctx, state) {
    var n = gridSizeOf(state);

    ctx.save();
    drawBoardBackground(ctx);
    drawGrid(ctx, n);
    drawStarPoints(ctx, n);
    ctx.restore();
  }

  // ── 棋子 ────────────────────────────────────────────────────────────────

  /** 单颗棋子的调色板。 */
  function paletteFor(player) {
    if (player === T.BLACK) {
      return {
        fill: COLORS.blackFill,
        highlight: COLORS.blackHighlight,
        edge: COLORS.blackEdge
      };
    }
    return {
      fill: COLORS.whiteFill,
      highlight: COLORS.whiteHighlight,
      edge: COLORS.whiteEdge
    };
  }

  /**
   * 画一颗棋子。含投影、径向高光与描边。
   * @param {boolean} [ghost] 半透明预览（鼠标悬停）
   */
  function drawStone(ctx, px, py, player, ghost) {
    var radius = geom.cell * T.STONE_RADIUS_RATIO;
    var colors = paletteFor(player);

    ctx.save();
    ctx.globalAlpha = ghost ? 0.4 : 1;

    // 投影
    ctx.beginPath();
    ctx.arc(px, py + radius * 0.16, radius, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.shadow;
    ctx.fill();

    // 主体 + 斜向高光
    var grad = ctx.createRadialGradient(
      px - radius * 0.36, py - radius * 0.42, radius * 0.14,
      px, py, radius * 1.06
    );
    grad.addColorStop(0, colors.highlight);
    grad.addColorStop(1, colors.fill);

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // 描边：浅色棋在浅色盘面上靠它拉开边界
    ctx.lineWidth = Math.max(1, radius * 0.07);
    ctx.strokeStyle = colors.edge;
    ctx.stroke();

    ctx.restore();
  }

  /** 最后一手的落点标记。 */
  function drawLastMoveMark(ctx, px, py, player) {
    var radius = geom.cell * T.STONE_RADIUS_RATIO;

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = player === T.BLACK ? '#7fd8ff' : '#1d5a7d';
    ctx.fill();
    ctx.restore();
  }

  /** 五连高亮：沿连线画一道发光粗线。 */
  function drawWinningLine(ctx, line) {
    if (!line || line.length < 2) return;

    var first = pointToPixel(line[0].x, line[0].y);
    var last = pointToPixel(line[line.length - 1].x, line[line.length - 1].y);

    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(first.px, first.py);
    ctx.lineTo(last.px, last.py);
    ctx.strokeStyle = COLORS.winLineGlow;
    ctx.lineWidth = geom.cell * T.WIN_LINE_WIDTH_RATIO * 3.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(first.px, first.py);
    ctx.lineTo(last.px, last.py);
    ctx.strokeStyle = COLORS.winLine;
    ctx.lineWidth = geom.cell * T.WIN_LINE_WIDTH_RATIO;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 第三层：棋子。
   * @param {object} state GameState
   * @param {object|null} [ghost] { x, y, player } 鼠标悬停预览
   */
  function drawPieces(ctx, state, ghost) {
    var board = state;
    var n = gridSizeOf(state);

    ctx.save();

    // 悬停预览先画，避免盖住已落下的棋子
    if (ghost && B.isEmpty(board, ghost.x, ghost.y)) {
      var gp = pointToPixel(ghost.x, ghost.y);
      drawStone(ctx, gp.px, gp.py, ghost.player, true);
    }

    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var player = B.getCell(board, x, y);
        if (player === T.EMPTY) continue;

        var p = pointToPixel(x, y);
        drawStone(ctx, p.px, p.py, player, false);
      }
    }

    if (state.lastMove && state.winner === T.WINNER_NONE) {
      var lp = pointToPixel(state.lastMove.x, state.lastMove.y);
      drawLastMoveMark(ctx, lp.px, lp.py, state.lastMove.player);
    }

    if (state.winningLine) {
      drawWinningLine(ctx, state.winningLine);
    }

    ctx.restore();
  }

  /** 取当前几何参数（只读副本），供命中判定等外部逻辑使用。 */
  function geometry() {
    return {
      size: geom.size,
      margin: geom.margin,
      origin: geom.origin,
      cell: geom.cell
    };
  }

  G.Render = G.Render || {};
  G.Render.Board = {
    COLORS: COLORS,
    configure: configure,
    geometry: geometry,
    pointToPixel: pointToPixel,
    pixelToPoint: pixelToPoint,
    distanceToPoint: distanceToPoint,
    drawBoard: drawBoard,
    drawPieces: drawPieces,
    drawStone: drawStone
  };
})();
