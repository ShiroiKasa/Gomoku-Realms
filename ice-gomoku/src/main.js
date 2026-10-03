/**
 * 五子奇境 · 入口
 *
 * 职责：持有游戏状态、绑定事件、按固定顺序驱动渲染。
 * 刻意保持「顺序调用」的直白写法——不使用回调、事件总线或观察者模式。
 *
 * 落子流程（固定顺序）：
 *   检查合法性 → 落子 → 判五连 → 若胜则结束 → advanceTurn → render
 *
 * 场地「雪山洞穴」的事件挂在 advanceTurn 里，见该函数注释。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;
  var Rules = G.Rules;
  var Arena = G.Arena;
  var RenderBoard = G.Render.Board;
  var RenderArena = G.Render.Arena;

  // ── 棋盘尺寸 ────────────────────────────────────────────────────────────
  var BOARD_PX = 640;        // 目标边长（CSS 像素）
  var MIN_BOARD_PX = 300;
  var BOARD_MARGIN = 34;     // 棋盘外留白，保证边线上的棋子不被裁掉

  // ── 模块状态 ────────────────────────────────────────────────────────────
  var state = null;          // GameState
  var canvas = null;
  var ctx = null;
  var elements = {};

  var boardPx = BOARD_PX;
  var hover = null;          // { x, y } 鼠标所在交叉点
  var renderQueued = false;

  var score = { black: 0, white: 0 };
  var winNoticeTimer = null;

  // ── DOM 引用 ────────────────────────────────────────────────────────────

  function $(role) {
    return document.querySelector('[data-role="' + role + '"]');
  }

  // ── 画布尺寸与缩放 ──────────────────────────────────────────────────────

  /** 依窗口宽度决定棋盘边长，保持棋盘完整可见。 */
  function computeBoardSize() {
    var available = window.innerWidth - 48;
    var px = Math.min(BOARD_PX, available);
    return Math.max(MIN_BOARD_PX, Math.floor(px));
  }

  function resizeCanvas() {
    boardPx = computeBoardSize();

    var dpr = window.devicePixelRatio || 1;

    // 画布后备缓冲按物理像素放大，CSS 尺寸保持逻辑像素，以适配高分屏
    canvas.width = Math.round(boardPx * dpr);
    canvas.height = Math.round(boardPx * dpr);
    canvas.style.width = boardPx + 'px';
    canvas.style.height = boardPx + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    RenderBoard.configure(boardPx, BOARD_MARGIN);
    RenderArena.configure(boardPx, BOARD_MARGIN);

    scheduleRender();
  }

  // ── 渲染主循环 ──────────────────────────────────────────────────────────

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;

    window.requestAnimationFrame(function (now) {
      renderQueued = false;

      // 推进场地动画时钟（雪花飘落、冰锥闪光、冰块弹入）
      RenderArena.tick(typeof now === 'number' ? now : 0);

      render();
    });
  }

  /**
   * 渲染分多层，顺序固定：
   *   drawScene（洞穴背景）→ drawBoard → drawArena（冰锥）→ drawPieces → drawArenaOverlay（冰块）
   *
   * 冰块必须画在棋子之后，否则压不住棋子。
   */
  function render() {
    ctx.clearRect(0, 0, boardPx, boardPx);

    var ghost = ghostFromHover();

    RenderArena.drawScene(ctx, state);         // 洞穴背景（棋盘之下）
    RenderBoard.drawBoard(ctx, state);         // 第一层：格子线
    RenderArena.drawArena(ctx, state, ghost);  // 第二层：冰锥预警（棋子之下）
    RenderBoard.drawPieces(ctx, state, ghost); // 第三层：棋子
    RenderArena.drawArenaOverlay(ctx, state);  // 冰块（棋子之上）

    updateHud();
  }

  /** 把鼠标位置转成落子预览；不适格则返回 null。 */
  function ghostFromHover() {
    if (!hover || state.winner !== T.WINNER_NONE) return null;
    if (!B.isLegal(state, state.arenaState, hover.x, hover.y)) return null;

    return { x: hover.x, y: hover.y, player: state.currentPlayer };
  }

  function updateHud() {
    var over = state.winner !== T.WINNER_NONE;

    elements.turn.textContent = over
      ? T.nameOf(state.winner) + '胜'
      : T.nameOf(state.currentPlayer);

    elements.turnDot.style.background = over
      ? (state.winner === T.BLACK ? '#1b2b3a' : '#eef5fb')
      : (state.currentPlayer === T.BLACK ? '#1b2b3a' : '#eef5fb');

    // 手数以棋盘上的棋子数为准：胜负分出时不再走 advanceTurn，
    // 若沿用 state.moveCount 会少算制胜的那一手。
    elements.moves.textContent = String(B.countStones(state));
    elements.score.textContent = score.black + ' : ' + score.white;

    // 场地信息：雪山洞穴
    elements.arena.textContent = state.arenaState
      ? '预警 ' + Arena.countSpikes(state.arenaState) +
        ' · 冰块 ' + Arena.countIceBlocks(state.arenaState)
      : '—';

    canvas.classList.toggle('is-over', over);
  }

  // ── 回合推进（独立函数，场地事件的挂载点）──────────────────────────────

  /**
   * 推进一个回合。所有「每回合发生一次的场地事件」都写在这里。
   *
   * 「雪山洞穴」结算顺序（严格按此顺序）：
   *   1. 结算冰锥落下（遍历所有预警，各 30% 判定）
   *   2. 结算冰块融化（倒计时 -1，归零则移除）
   *   3. 补充预警至 5 个
   *   4. moveCount++
   *   5. 切换玩家
   *
   * 四步与五步之后，玩家看到的就是结算后的棋盘。
   * 注意这里只推进状态，不做判胜、不做渲染。
   *
   * @param {object} state GameState
   */
  function advanceTurn(state) {
    // 1~3. 场地结算（冰锥落下 → 冰块融化 → 补充预警）
    if (state.arenaState) {
      var settled = Arena.settleTurns(state, state.arenaState);

      // 通知渲染层做落下闪光，纯视觉，不影响规则
      RenderArena.notifyDrops(settled.drops);
    }

    // 4. 推进手数
    state.moveCount++;

    // 5. 切换玩家
    state.currentPlayer = state.currentPlayer === T.BLACK ? T.WHITE : T.BLACK;
  }

  // ── 落子流程 ────────────────────────────────────────────────────────────

  /**
   * 处理一次落子尝试。严格按下列顺序执行：
   *   检查合法性 → 落子 → 判五连 → 若胜则结束 → advanceTurn → render
   */
  function playMove(x, y) {
    // 1. 检查合法性（含场地规则：冰块格不可落子；预警格可以落子）
    if (state.winner !== T.WINNER_NONE) return;
    if (!B.isLegal(state, state.arenaState, x, y)) return;

    var player = state.currentPlayer;

    // 2. 落子（Board.place 内部还会再校验一次）
    if (!B.place(state, x, y, player)) return;
    state.lastMove = { x: x, y: y, player: player };
    state.history.push({ x: x, y: y, player: player });

    // 3. 判五连
    var result = Rules.checkFrom(state, x, y, player);

    if (result) {
      // 4. 若胜则结束（不再推进回合）
      state.winner = result.winner;
      state.winningLine = result.line;
      score[player === T.BLACK ? 'black' : 'white']++;
      render();
      announceWin(result.winner);
      return;
    }

    // 5. advanceTurn
    advanceTurn(state);

    // 6. render
    render();
  }

  function announceWin(player) {
    var text = T.nameOf(player) + '连成五子，获胜！\n共用 ' + state.moveCount + ' 手。\n\n点击「确定」开始新的一局。';

    // 稍作延迟，让胜负高亮先画出来
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = window.setTimeout(function () {
      window.alert(text);
      restart();
    }, 220);
  }

  // ── 开局与重开 ──────────────────────────────────────────────────────────

  function restart() {
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = null;

    hover = null;
    state = T.createGameState(T.DEFAULT_SIZE);

    // 初始化场地：创建 arenaState 并补满初始的 5 个冰锥预警
    state.arenaState = Arena.create(state);

    // 清掉上一局残留的动画痕迹（闪光、雪花位置）
    RenderArena.resetEffects();

    render();
  }

  // ── 事件绑定 ────────────────────────────────────────────────────────────

  /** 鼠标坐标 → 画布逻辑坐标。 */
  function toCanvasPoint(event) {
    var rect = canvas.getBoundingClientRect();

    // 画布可能被 CSS 缩放，按实际显示尺寸换算
    var scaleX = boardPx / rect.width;
    var scaleY = boardPx / rect.height;

    return {
      px: (event.clientX - rect.left) * scaleX,
      py: (event.clientY - rect.top) * scaleY
    };
  }

  /** 定位最近的交叉点；点击容差过远时返回 null。 */
  function locatePoint(px, py) {
    var point = RenderBoard.pixelToPoint(px, py);

    if (!B.isInside(state, point.x, point.y)) return null;

    // 容差取半格，避免点在两颗棋子之间时误判
    var tolerance = RenderBoard.geometry().cell * 0.5;
    if (RenderBoard.distanceToPoint(px, py, point.x, point.y) > tolerance) return null;

    return { x: point.x, y: point.y };
  }

  function onPointerMove(event) {
    var p = toCanvasPoint(event);
    var point = locatePoint(p.px, p.py);
    var same = (hover === null && point === null) ||
      (hover !== null && point !== null && hover.x === point.x && hover.y === point.y);

    if (same) return;

    hover = point;
    scheduleRender();
  }

  function onPointerLeave() {
    if (hover === null) return;
    hover = null;
    scheduleRender();
  }

  function onPointerDown(event) {
    var p = toCanvasPoint(event);
    var point = locatePoint(p.px, p.py);
    if (!point) return;

    playMove(point.x, point.y);
  }

  function onKeyDown(event) {
    if (event.key === 'r' || event.key === 'R') restart();
  }

  function bindControls() {
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);

    elements.restartBtn.addEventListener('click', restart);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', resizeCanvas);
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  function init() {
    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');

    elements.turn = $('turn');
    elements.turnDot = $('turn-dot');
    elements.moves = $('moves');
    elements.score = $('score');
    elements.arena = $('arena');
    elements.restartBtn = $('btn-restart');

    resizeCanvas();
    bindControls();

    // 由 restart 统一负责建立 state（含场地初始化）并首次渲染
    restart();
  }

  G.Main = {
    init: init,
    // 暴露给调试与后续场地开发使用
    getState: function () { return state; },
    playMove: playMove,
    advanceTurn: advanceTurn,
    restart: restart,
    render: render
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
