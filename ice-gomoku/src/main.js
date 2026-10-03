/**
 * 五子奇境 · 入口
 *
 * 职责：持有应用状态与游戏状态、绑定事件、按固定顺序驱动渲染。
 * 刻意保持「顺序调用」的直白写法——不使用回调、事件总线或观察者模式。
 *
 * 顶层状态只有两个屏幕、两个模式：
 *   appState = { screen: 'menu' | 'game', mode: 'classic' | 'snow' }
 * 模式决定是否启用场地（见 core/mode.js）。
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
  var River = G.River;
  var Mine = G.Mine;
  var Modes = G.Modes;
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

  // ── 顶层状态：只有两个屏幕、两个模式 ────────────────────────────────────
  var appState = {
    screen: 'menu',            // 'menu' | 'game'
    mode: Modes.DEFAULT        // 'classic' | 'snow'（进入 game 后有效）
  };

  /** 是否处于对局中（菜单界面下不跑游戏逻辑、不渲染棋盘）。 */
  function isPlaying() {
    return appState.screen === 'game';
  }

  // ── DOM 引用 ────────────────────────────────────────────────────────────

  function $(role) {
    return document.querySelector('[data-role="' + role + '"]');
  }

  /**
   * 取某 role 的全部元素。
   * 优先用 querySelectorAll；不支持时（如测试用的极简 DOM 桩）退回逐个探测，
   * 保证调用方拿到的始终是「可遍历 + 有 length」的对象。
   */
  function $all(role) {
    if (typeof document.querySelectorAll === 'function') {
      return document.querySelectorAll('[data-role="' + role + '"]');
    }

    var found = [];
    var one = $(role);
    if (one) found.push(one);
    return found;
  }

  // ── 画布尺寸与缩放 ──────────────────────────────────────────────────────

  /** 依窗口宽度决定棋盘边长，保持棋盘完整可见。 */
  function computeBoardSize() {
    var available = window.innerWidth - 48;
    var px = Math.min(BOARD_PX, available);
    return Math.max(MIN_BOARD_PX, Math.floor(px));
  }

  function resizeCanvas() {
    // 菜单界面下画布不可见，尺寸无意义，跳过
    if (!isPlaying()) return;

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
    if (!isPlaying()) return;
    if (renderQueued) return;
    renderQueued = true;

    window.requestAnimationFrame(function (now) {
      renderQueued = false;

      // 已经退回菜单就不再继续画（雪花动画也随之停下）
      if (!isPlaying()) return;

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
    // 菜单界面下画布不可见，也不该继续绘制
    if (!isPlaying()) return;

    ctx.clearRect(0, 0, boardPx, boardPx);

    var ghost = ghostFromHover();

    RenderArena.drawScene(ctx, state);            // 洞穴背景（棋盘之下）
    RenderBoard.drawBoard(ctx, state);            // 第一层：格子线
    RenderArena.drawArena(ctx, state, ghost);     // 第二层：场地（棋子之下）
    RenderBoard.drawPieces(ctx, state, ghost);    // 第三层：棋子
    RenderArena.drawMinePreview(ctx, state, ghost); // 雷区悬停：3×3 爆炸范围（棋子之上）
    RenderArena.drawArenaOverlay(ctx, state);     // 冰块/水波/水位条/雷区数字（最上层）

    updateHud();
  }

  /** 把鼠标位置转成落子预览；不适格则返回 null。 */
  function ghostFromHover() {
    if (!isPlaying() || !hover) return null;
    if (state.winner !== T.WINNER_NONE) return null;
    if (!B.isLegal(state, state.arenaState, hover.x, hover.y)) return null;

    return { x: hover.x, y: hover.y, player: state.currentPlayer };
  }

  function updateHud() {
    var over = state.winner !== T.WINNER_NONE;
    var mode = Modes.get(appState.mode);

    elements.mode.textContent = mode.name;

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

    // 场地信息：按场地类型显示不同内容
    var arena = state.arenaState;

    if (arena && arena.mines) {
      elements.arena.textContent = '雷区 ' + Mine.countMines(arena);
    } else if (arena && arena.riverColumns) {
      elements.arena.textContent = '水位 ' + arena.waterLevel + '% · 河宽 ' + arena.riverColumns.length + ' 列';
    } else if (arena) {
      elements.arena.textContent =
        '预警 ' + Arena.countSpikes(arena) +
        ' · 冰块 ' + Arena.countIceBlocks(arena);
    } else {
      elements.arena.textContent = '—';
    }

    // 图例只在有场地的模式显示；规则面板每个模式都有（含经典）。
    // 注意：经典模式的 mode.arena 是 null，不能用它当分类键，
    // 否则 arenaKind 会变成 ''，四个规则块都会被判为「不匹配」而全部隐藏。
    var arenaKind = mode.arena || mode.id;

    elements.legend.hidden = !mode.arena;
    elements.rulesMode.textContent = mode.name;

    for (var i = 0; i < elements.legendSnow.length; i++) {
      elements.legendSnow[i].hidden = arenaKind !== 'snow';
      elements.legendRiver[i].hidden = arenaKind !== 'river';
      elements.legendMine[i].hidden = arenaKind !== 'mine';
    }

    elements.rulesClassic.hidden = arenaKind !== 'classic';
    elements.rulesSnow.hidden = arenaKind !== 'snow';
    elements.rulesRiver.hidden = arenaKind !== 'river';
    elements.rulesMine.hidden = arenaKind !== 'mine';

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
    var arena = state.arenaState;

    // 危险雷区：顺序为「推进手数 → 倒计时 -1 → 引爆归零者 → 每 5 回合埋新雷 → 切换玩家」。
    // 生成判定依赖推进后的 moveCount，故这里先自增。
    if (arena && arena.mines) {
      state.moveCount++;                                         // 1
      var mined = Mine.settleMines(state, arena, state.moveCount); // 2~4

      // 通知渲染层做爆炸闪光，纯视觉，不影响规则
      RenderArena.notifyBlasts(mined.cells);

      state.currentPlayer = state.currentPlayer === T.BLACK ? T.WHITE : T.BLACK; // 5
      return;
    }

    // 山谷溪流：顺序为「推进手数 → 水位 → 河流扩展 → 冲走判定 → 切换玩家」。
    // 水位公式依赖推进后的 moveCount，故这里先自增。
    if (arena && arena.riverColumns) {
      state.moveCount++;                                          // 1
      var river = River.settleRiver(state, arena, state.moveCount); // 2~4

      // 通知渲染层做水波，纯视觉，不影响规则
      RenderArena.notifyWashed(river.washed);

      state.currentPlayer = state.currentPlayer === T.BLACK ? T.WHITE : T.BLACK; // 5
      return;
    }

    // 雪山洞穴：顺序为「场地结算（冰锥落下 → 冰块融化 → 补充预警）→ 推进手数 → 切换玩家」
    if (arena) {
      var settled = Arena.settleTurns(state, arena);

      // 通知渲染层做落下闪光，纯视觉，不影响规则
      RenderArena.notifyDrops(settled.drops);
    }

    state.moveCount++;
    state.currentPlayer = state.currentPlayer === T.BLACK ? T.WHITE : T.BLACK;
  }

  // ── 落子流程 ────────────────────────────────────────────────────────────

  /**
   * 处理一次落子尝试。严格按下列顺序执行：
   *   检查合法性 → 落子 → 判五连 → 若胜则结束
   *              → 未胜且落在雷区上则主动引爆 → advanceTurn → render
   */
  function playMove(x, y) {
    // 1. 检查合法性（含场地规则：冰块格不可落子；预警格与雷区格都可以落子）
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
      // 4. 若胜则结束：不引爆、不进入 advanceTurn
      state.winner = result.winner;
      state.winningLine = result.line;
      score[player === T.BLACK ? 'black' : 'white']++;
      render();
      announceWin(result.winner);
      return;
    }

    // 5. 主动引爆：落在雷区格上立即引爆该格（含连锁）。
    //    刚落下的这枚棋子本身也会被炸掉——这正是主动引爆的代价。
    if (state.arenaState && state.arenaState.mines &&
        Mine.hasMine(state.arenaState, x, y)) {
      var blasted = Mine.detonate(state, state.arenaState, x, y);
      RenderArena.notifyBlasts(blasted.cells);
    }

    // 6. advanceTurn
    advanceTurn(state);

    // 7. render
    render();
  }

  function announceWin(player) {
    var text = T.nameOf(player) + '连成五子，获胜！\n共用 ' + state.moveCount + ' 手。\n\n点击「确定」开始新的一局。';

    // 稍作延迟，让胜负高亮先画出来
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = window.setTimeout(function () {
      window.alert(text);
      restartGame();
    }, 220);
  }

  // ── 开局与重开 ──────────────────────────────────────────────────────────

  /**
   * 重开当前模式的一局。保留 appState.mode 与比分。
   *
   * 场地是否启用完全由模式的 arena 字段决定：
   *   classic → arena: null    → arenaState = null，纯五子棋
   *   snow    → arena: 'snow'  → 建立 arenaState 并补满 5 个冰锥预警
   *   river   → arena: 'river' → 建立河流状态（水位 0，河宽 2 列）
   *   mine    → arena: 'mine'  → 随机埋 5～8 个雷区，各带 5～15 回合倒计时
   */
  function restartGame() {
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = null;

    var mode = Modes.get(appState.mode);

    hover = null;
    state = T.createGameState(T.DEFAULT_SIZE);

    if (mode.arena === 'snow') {
      state.arenaState = Arena.create(state);
    } else if (mode.arena === 'river') {
      state.arenaState = River.create();
    } else if (mode.arena === 'mine') {
      state.arenaState = Mine.create(state);
    } else {
      state.arenaState = null;   // 经典模式没有场地
    }

    // 清掉上一局残留的动画痕迹（闪光、雪花、水波、爆炸）
    RenderArena.resetEffects();

    render();
  }

  // ── 屏幕切换（只有 menu 与 game 两个屏幕）───────────────────────────────

  /** 进入某个模式并开新局。 */
  function enterMode(modeId) {
    appState.mode = Modes.get(modeId).id;
    appState.screen = 'game';

    elements.menu.hidden = true;
    elements.game.hidden = false;

    resizeCanvas();     // 画布此时才可见，尺寸在这里确定
    restartGame();
  }

  /** 返回菜单：清空棋盘、清零比分、停止对局。 */
  function backToMenu() {
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = null;

    appState.screen = 'menu';

    // 清空棋盘并停掉游戏状态
    hover = null;
    state = T.createGameState(T.DEFAULT_SIZE);
    state.arenaState = null;

    // 比分只在返回菜单时清零（「重开」保留比分）
    score.black = 0;
    score.white = 0;
    elements.score.textContent = '0 : 0';

    ctx.clearRect(0, 0, boardPx, boardPx);

    elements.game.hidden = true;
    elements.menu.hidden = false;
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
    if (!isPlaying()) return;
    if (event.key === 'r' || event.key === 'R') restartGame();
    if (event.key === 'Escape') backToMenu();
  }

  function bindControls() {
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);

    elements.restartBtn.addEventListener('click', restartGame);
    elements.backBtn.addEventListener('click', backToMenu);

    elements.modeClassicBtn.addEventListener('click', function () { enterMode('classic'); });
    elements.modeSnowBtn.addEventListener('click', function () { enterMode('snow'); });
    elements.modeRiverBtn.addEventListener('click', function () { enterMode('river'); });
    elements.modeMineBtn.addEventListener('click', function () { enterMode('mine'); });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', resizeCanvas);
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  function init() {
    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');

    elements.menu = document.getElementById('menu');
    elements.game = document.getElementById('game');

    elements.mode = $('mode');
    elements.turn = $('turn');
    elements.turnDot = $('turn-dot');
    elements.moves = $('moves');
    elements.score = $('score');
    elements.arena = $('arena');
    elements.legend = $('legend');
    elements.rulesMode = $('rules-mode');

    elements.legendSnow = $all('legend-snow');
    elements.legendRiver = $all('legend-river');
    elements.legendMine = $all('legend-mine');

    elements.rulesClassic = $('rules-classic');
    elements.rulesSnow = $('rules-snow');
    elements.rulesRiver = $('rules-river');
    elements.rulesMine = $('rules-mine');

    elements.restartBtn = $('btn-restart');
    elements.backBtn = $('btn-back');
    elements.modeClassicBtn = $('btn-mode-classic');
    elements.modeSnowBtn = $('btn-mode-snow');
    elements.modeRiverBtn = $('btn-mode-river');
    elements.modeMineBtn = $('btn-mode-mine');

    // 启动时停在开始界面：先看到菜单，不自动开局
    state = T.createGameState(T.DEFAULT_SIZE);
    appState.screen = 'menu';

    elements.menu.hidden = false;
    elements.game.hidden = true;

    bindControls();
  }

  G.Main = {
    init: init,

    // 供菜单按钮与调试使用
    getAppState: function () { return appState; },
    enterMode: enterMode,
    backToMenu: backToMenu,

    // 暴露给调试与后续场地开发使用
    getState: function () { return state; },
    playMove: playMove,
    advanceTurn: advanceTurn,
    restart: restartGame,
    render: render
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
