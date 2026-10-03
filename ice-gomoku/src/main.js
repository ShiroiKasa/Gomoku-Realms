/**
 * 五子奇境 · 入口
 *
 * 职责：持有应用状态与游戏状态、绑定事件、按固定顺序驱动渲染。
 * 刻意保持「顺序调用」的直白写法——不使用回调、事件总线或观察者模式。
 *
 * 顶层状态只有两个屏幕、四个模式：
 *   appState = { screen: 'menu' | 'game', mode: 'classic' | 'snow' | 'river' | 'mine' }
 * 模式决定是否启用场地（见 core/mode.js）。
 *
 * 落子流程（固定顺序）：
 *   检查合法性 → 落子 → 判五连 → 若胜则结束 → advanceTurn → render
 *
 * 渲染循环：对局中由 rAF 连续驱动（场地的雪/水纹/辉光都是连续动画），
 * 退回菜单后循环自然停住。各场地事件挂在 advanceTurn 里，见该函数注释。
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
  var AI = G.AI;
  var RenderScene = G.Render.Scene;
  var RenderBoard = G.Render.Board;
  var RenderArena = G.Render.Arena;

  // ── 棋盘尺寸 ────────────────────────────────────────────────────────────
  var BOARD_PX = 640;        // 目标边长（CSS 像素）
  var MIN_BOARD_PX = 300;
  var MARGIN_RATIO = 0.085;  // 石板外留白占边长的比例——这段留白就是洞穴岩壁
  var MIN_MARGIN = 18;
  var MAX_MARGIN = 56;

  // ── 模块状态 ────────────────────────────────────────────────────────────
  var state = null;          // GameState
  var canvas = null;
  var ctx = null;
  var elements = {};

  var boardPx = BOARD_PX;
  var hover = null;          // { x, y } 鼠标所在交叉点
  var renderQueued = false;
  var reducedMotion = false; // 系统「减少动态效果」时不再连续重绘

  var score = { black: 0, white: 0 };
  var winNoticeTimer = null;
  var hudCache = {};         // HUD 只在值变化时才写 DOM（连续重绘下必须节流）

  // ── 电脑对手（PvE）──────────────────────────────────────────────────────
  // 电脑执白，人执黑，所以开局第一手永远是人下的。
  // 决策本身很轻（模式表查表，通常 1ms 以内），所以不需要分帧搜索；
  // 这里只做一件事：落子前等一小会儿，让人看清「轮到电脑了」。
  var ai = {
    level: 'human',   // 'human' | 'easy' | 'normal' | 'hard'
    timer: 0,         // 还需要等多久才落子（毫秒，仅供界面显示"思考中"）
    deadline: 0       // 到点就落子的绝对时刻
  };

  /** 取当前时间（优先高精度时钟）。 */
  function nowMs() {
    if (window.performance && typeof window.performance.now === 'function') {
      return window.performance.now();
    }

    return Date.now();
  }

  /** 是否启用了电脑对手。 */
  function aiIsActive() {
    return ai.level !== 'human';
  }

  /** 电脑执白：棋盘为空时黑方是人，所以第一手永远由人来下。 */
  function aiPlayer() {
    return T.WHITE;
  }

  /** 现在是否轮到电脑。 */
  function aiShouldMove() {
    if (!isPlaying() || !aiIsActive()) return false;
    if (state.winner !== T.WINNER_NONE) return false;
    return state.currentPlayer === aiPlayer();
  }

  /** 是否正在「思考」（已经在等待落子）。 */
  function aiIsThinking() {
    return ai.timer > 0;
  }

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
   * 取某 role 的全部元素，**始终返回真数组**。
   *
   * 优先用 querySelectorAll；不支持时（如测试用的极简 DOM 桩）退回逐个探测。
   * 注意 querySelectorAll 返回的是 NodeList —— 它有 length 也能遍历，
   * 但**没有数组方法**（concat / map / slice 都不行）。所以这里统一转成数组，
   * 调用方才能安全地拼接多个来源（踩过这个坑：拿 NodeList 直接 .concat
   * 会抛 TypeError，把整个 init 带崩，页面上所有按钮都点不动）。
   */
  function $all(role) {
    if (typeof document.querySelectorAll === 'function') {
      return Array.prototype.slice.call(
        document.querySelectorAll('[data-role="' + role + '"]')
      );
    }

    var found = [];
    var one = $(role);
    if (one) found.push(one);
    return found;
  }

  // ── 画布尺寸与缩放 ──────────────────────────────────────────────────────

  /** 依窗口宽高决定棋盘边长，保持整块石板完整可见。 */
  function computeBoardSize() {
    var byWidth = (window.innerWidth || BOARD_PX) - 48;
    var byHeight = (window.innerHeight || 0) - 216;   // 顺便让上下内容也尽量留在屏内
    var px = Math.min(BOARD_PX, byWidth);

    if (byHeight > 0) px = Math.min(px, byHeight);

    return Math.max(MIN_BOARD_PX, Math.floor(px));
  }

  /** 石板外留白：就是洞穴岩壁的可见宽度，随边长缩放并夹在区间内。 */
  function computeMargin(px) {
    return Math.round(Math.max(MIN_MARGIN, Math.min(MAX_MARGIN, px * MARGIN_RATIO)));
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

    var margin = computeMargin(boardPx);
    RenderScene.configure(boardPx, margin, dpr);
    RenderBoard.configure(boardPx, margin, dpr);
    RenderArena.configure(boardPx, margin, dpr);

    scheduleRender();
  }

  // ── 渲染主循环 ──────────────────────────────────────────────────────────

  /**
   * 排一帧渲染。
   *
   * 关键点：这里会在帧末**继续排下一帧**，形成一个只在对局中运行的循环。
   * 场地里的飘雪、水纹、爆炸余晖、五连辉光都是连续动画，只在事件（落子/移动鼠标）
   * 时重绘的话它们会整帧冻住——所以只要 isPlaying() 为真就一直画下去；
   * 退回菜单后 isPlaying() 变假，循环在下一帧自然停住，画布不再空转。
   */
  function scheduleRender() {
    if (!isPlaying()) return;
    if (renderQueued) return;
    renderQueued = true;

    window.requestAnimationFrame(function (now) {
      renderQueued = false;

      // 已经退回菜单就不再继续画（雪花动画也随之停下）
      if (!isPlaying()) return;

      var stamp = typeof now === 'number' ? now : 0;

      aiFrame();   // 电脑对手：先检查是否到点该落子，再画这一帧

      // 推进各层时钟（场景粒子、水纹与闪光、棋子弹入、五连辉光）
      RenderScene.tick(stamp);
      RenderArena.tick(stamp);
      RenderBoard.tick(stamp);

      render();

      if (!reducedMotion) scheduleRender();
    });
  }

  /**
   * 渲染分七层，顺序固定：
   *   drawScene（场景背景，按模式主题）→ drawBoard（石板/格线/星位）→ drawArena（场地，棋子之下）
   *   → drawPieces（棋子）→ drawMinePreview（雷区悬停）→ drawArenaOverlay（冰块等，棋子之上）
   *   → drawAtmosphere（光柱/边缘霜尘雾/前景粒子/暗角/胜利聚焦，最上层）
   *
   * 冰块、雷区数字必须画在棋子之后，否则压不住棋子；
   * 氛围层必须最后画，否则压不住任何东西。
   * 场景与石板都按 appState.mode 选主题（见 render/theme.js），所以要显式传下去。
   */
  function render() {
    // 菜单界面下画布不可见，也不该继续绘制
    if (!isPlaying()) return;

    ctx.clearRect(0, 0, boardPx, boardPx);

    var ghost = ghostFromHover();

    var mode = appState.mode;

    RenderScene.drawScene(ctx, state, mode);        // 场景背景（石板之下）
    RenderBoard.drawBoard(ctx, state, mode);        // 石板 + 格子线 + 星位
    RenderArena.drawArena(ctx, state, ghost);       // 场地（棋子之下）
    RenderBoard.drawPieces(ctx, state, ghost, mode);// 棋子
    RenderArena.drawMinePreview(ctx, state, ghost); // 雷区悬停：3×3 爆炸范围
    RenderArena.drawArenaOverlay(ctx, state);       // 冰块/水波/水位条/雷区数字
    RenderScene.drawAtmosphere(ctx, state, mode);   // 氛围与胜利聚焦（最上层）

    updateHud();
  }

  /** 把鼠标位置转成落子预览；不适格则返回 null。 */
  function ghostFromHover() {
    if (!isPlaying() || !hover) return null;
    if (state.winner !== T.WINNER_NONE) return null;
    if (aiShouldMove() || aiIsThinking()) return null;   // 电脑思考时不显示人的落点预览
    if (!B.isLegal(state, state.arenaState, hover.x, hover.y)) return null;

    return { x: hover.x, y: hover.y, player: state.currentPlayer };
  }

  /** 只在值确实变化时写 DOM：连续重绘时每帧写 HUD 会白白触发布局。 */
  function setText(el, key, value) {
    if (!el || hudCache[key] === value) return;
    hudCache[key] = value;
    el.textContent = value;
  }

  /** 同理，只在变化时改样式 / 类名。 */
  function setStyle(el, key, prop, value) {
    if (!el || hudCache[key] === value) return;
    hudCache[key] = value;
    el.style[prop] = value;
  }

  function setToggle(el, key, cls, on) {
    if (!el || hudCache[key] === on) return;
    hudCache[key] = on;
    el.classList.toggle(cls, on);
  }

  function setHidden(el, key, hidden) {
    if (!el || hudCache[key] === hidden) return;
    hudCache[key] = hidden;
    el.hidden = hidden;
  }

  function updateHud() {
    var over = state.winner !== T.WINNER_NONE;
    var mode = Modes.get(appState.mode);

    setText(elements.mode, 'mode', mode.name);

    setText(elements.turn, 'turn', over
      ? T.nameOf(state.winner) + '胜'
      : T.nameOf(state.currentPlayer));

    setStyle(elements.turnDot, 'turnDot', 'background', over
      ? (state.winner === T.BLACK ? '#1b2b3a' : '#eef5fb')
      : (state.currentPlayer === T.BLACK ? '#1b2b3a' : '#eef5fb'));

    // 手数以棋盘上的棋子数为准：胜负分出时不再走 advanceTurn，
    // 若沿用 state.moveCount 会少算制胜的那一手。
    setText(elements.moves, 'moves', String(B.countStones(state)));
    setText(elements.score, 'score', score.black + ' : ' + score.white);

    // 场地信息：按场地类型显示不同内容
    var arena = state.arenaState;

    if (arena && arena.mines) {
      setText(elements.arena, 'arena', '雷区 ' + Mine.countMines(arena));
    } else if (arena && arena.riverColumns) {
      setText(elements.arena, 'arena',
        '水位 ' + arena.waterLevel + '% · 河宽 ' + arena.riverColumns.length + ' 列');
    } else if (arena) {
      setText(elements.arena, 'arena',
        '预警 ' + Arena.countSpikes(arena) +
        ' · 冰块 ' + Arena.countIceBlocks(arena));
    } else {
      setText(elements.arena, 'arena', '—');
    }

    // 图例只在有场地的模式显示；规则面板每个模式都有（含经典）。
    // 注意：经典模式的 mode.arena 是 null，不能用它当分类键，
    // 否则 arenaKind 会变成 ''，四个规则块都会被判为「不匹配」而全部隐藏。
    var arenaKind = mode.arena || mode.id;

    // 让 CSS 里的 --accent 跟着模式走（HUD、按钮、面板的强调色）
    if (elements.game && hudCache.gameMode !== appState.mode) {
      hudCache.gameMode = appState.mode;
      elements.game.setAttribute('data-mode', appState.mode);
    }

    setHidden(elements.legend, 'legend', !mode.arena);
    setText(elements.rulesMode, 'rulesMode', mode.name);

    for (var i = 0; i < elements.legendSnow.length; i++) {
      elements.legendSnow[i].hidden = arenaKind !== 'snow';
      elements.legendRiver[i].hidden = arenaKind !== 'river';
      elements.legendMine[i].hidden = arenaKind !== 'mine';
    }

    elements.rulesClassic.hidden = arenaKind !== 'classic';
    elements.rulesSnow.hidden = arenaKind !== 'snow';
    elements.rulesRiver.hidden = arenaKind !== 'river';
    elements.rulesMine.hidden = arenaKind !== 'mine';

    setToggle(canvas, 'isOver', 'is-over', over);

    updateAiHud(over);
  }

  /**
   * 档位按钮的选中态：菜单与游戏内两套一起更新（选中态样式挂在 aria-pressed 上）。
   *
   * **单拎出来是因为菜单界面也得能立刻变色**：菜单下渲染循环不跑（render() 直接返回），
   * 若只在 updateAiHud() 里同步，点档位后按钮要等进对局再退回菜单才更新
   * （实际档位已生效，界面却停在旧选中项）。
   */
  function syncLevelButtons() {
    var all = elements.levelButtons;

    if (!all) return;

    var level = ai.level;

    for (var i = 0; i < all.length; i++) {
      var on = all[i].getAttribute('data-ai-level') === level;

      if (all[i].getAttribute('aria-pressed') !== String(on)) {
        all[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  /** 电脑对手相关的界面：档位按钮的选中态、状态条、以及状态条上的文字。 */
  function updateAiHud(over) {
    var active = aiIsActive();
    var thinking = aiIsThinking();
    var level = ai.level;

    syncLevelButtons();

    if (!elements.aiStatus) return;

    var thinkingFlag = (thinking && !over) ? '1' : '0';
    var offFlag = active ? '0' : '1';

    if (hudCache.aiThinking !== thinkingFlag) {
      hudCache.aiThinking = thinkingFlag;
      elements.aiStatus.setAttribute('data-thinking', thinkingFlag);
    }

    if (hudCache.aiOff !== offFlag) {
      hudCache.aiOff = offFlag;
      elements.aiStatus.setAttribute('data-off', offFlag);
    }

    var text;

    if (!active) {
      text = '人人对战';
    } else if (over) {
      text = '对局结束';
    } else if (thinking) {
      text = '电脑（' + AI.nameOf(level) + '）思考中';
    } else if (state.currentPlayer === aiPlayer()) {
      text = '电脑（' + AI.nameOf(level) + '）执白';
    } else {
      text = '电脑（' + AI.nameOf(level) + '）· 轮到你';
    }

    setText(elements.aiText, 'aiText', text);
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

    // 轮电脑时人不许抢着下。电脑自己落子前会先 stopAi()，所以不会误伤。
    if (aiIsThinking() && state.currentPlayer === aiPlayer()) return;

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

    // 8. 交给电脑（若这一手之后轮到它）
    scheduleAi();
  }

  // ── 电脑对手的驱动 ──────────────────────────────────────────────────────
  //
  // 一局的节奏始终是「人下 → 电脑下」。电脑执白，人执黑，
  // 所以新开一局的第一手永远是人下的，电脑不会抢跑。
  //
  // 决策是同步的一次查表（core/ai.js 的 chooseMove，通常 1ms 以内），
  // 不需要分帧；这里只在落子前放一小段延迟，让人看清「轮到电脑了」。

  /** 让电脑停手：清掉待落子的计时（换人、重开、返回菜单时都要）。 */
  function stopAi() {
    ai.timer = 0;
    ai.deadline = 0;
  }

  /**
   * 该电脑下就起一个延迟计时，否则什么也不做。
   * 由「人落子之后」「重开之后」「切换档位之后」调用。
   */
  function scheduleAi() {
    if (!aiShouldMove()) {
      stopAi();
      return;
    }

    // 已经有计时在跑就别重置，否则每帧都会被推迟
    if (ai.deadline > 0) return;

    ai.timer = AI.thinkTimeOf(ai.level);
    ai.deadline = nowMs() + ai.timer;
  }

  /**
   * 每帧检查一次：到点就让电脑落子。
   *
   * 用**墙上时间**判定到点，而不是「每帧扣掉一个固定步长」——
   * 后者在浏览器节流 rAF（后台标签页、无头模式）时会慢得离谱：
   * 实测无头 Chrome 里 1.2 秒只跑了 1 帧，按帧计时要等十几秒才落子。
   */
  function aiFrame() {
    if (!isPlaying()) return;

    if (ai.deadline <= 0) {
      scheduleAi();
      if (ai.deadline <= 0) return;
    }

    ai.timer = Math.max(0, ai.deadline - nowMs());

    if (ai.timer > 0) return;   // 还在等：交给渲染循环继续排下一帧

    stopAi();

    var move = AI.chooseMove(state, ai.level);

    if (move && state.winner === T.WINNER_NONE) playMove(move.x, move.y);
  }

  /**
   * 切换对手档位。
   * - 'human' ：人人对战
   * - 'easy' | 'normal' | 'hard'：电脑执白，黑方仍是人
   */
  function setLevel(level) {
    var valid = level === 'human' || !!AI.LEVELS[level];
    ai.level = valid ? level : 'human';

    // 换档位时作废未落子的计时：不该用旧档位的节奏继续
    stopAi();

    // 选中态必须在这里同步：菜单界面下渲染循环不跑，
    // 若等 updateAiHud()（挂在 render() 里）来刷，按钮要等进对局再退回才变色。
    syncLevelButtons();

    if (!isPlaying()) return;

    scheduleAi();
    scheduleRender();
  }

  /**
   * 胜负揭晓：改用页面内的结果卡，不再用 window.alert 打断画面。
   * 稍作延迟，让五连辉光先亮起来。
   */
  function announceWin(player) {
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = window.setTimeout(function () {
      if (!isPlaying() || state.winner === T.WINNER_NONE) return;
      showVictory(player);
    }, 420);
  }

  /** 显示对局结果卡（胜负已分，落子流程本来就不会再走）。 */
  function showVictory(player) {
    if (!elements.victory) return;

    var stones = state.winningLine ? state.winningLine.length : T.WIN_COUNT;

    setText(elements.victoryTitle, 'vTitle', T.nameOf(player) + '连成五子');
    setText(elements.victorySub, 'vSub',
      '本局共 ' + B.countStones(state) + ' 手 · 连续 ' + stones + ' 子 · 比分 ' +
      score.black + ' : ' + score.white);

    elements.victory.hidden = false;
    hudCache.victory = false;

    if (elements.victoryAgain && elements.victoryAgain.focus) elements.victoryAgain.focus();
  }

  function hideVictory() {
    if (!elements.victory || elements.victory.hidden) return;

    elements.victory.hidden = true;
    hudCache.victory = true;
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

    hideVictory();
    stopAi();

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

    // 清掉上一局残留的动画痕迹（场景粒子、闪光、水波、爆炸、弹入、五连辉光）
    RenderScene.resetEffects();
    RenderArena.resetEffects();
    RenderBoard.resetEffects();

    // 电脑永远执白、人执黑，所以新局的第一手一定是人的
    scheduleAi();

    render();

    // reduced-motion 下循环不会自续，但这里若轮到电脑仍需把循环拉起来
    if (aiIsThinking()) scheduleRender();
  }

  // ── 屏幕切换（只有 menu 与 game 两个屏幕）───────────────────────────────

  /** 进入某个模式并开新局。 */
  function enterMode(modeId) {
    appState.mode = Modes.get(modeId).id;
    appState.screen = 'game';

    hideVictory();

    elements.menu.hidden = true;
    elements.game.hidden = false;
    elements.game.setAttribute('data-mode', appState.mode);
    hudCache.gameMode = appState.mode;

    resizeCanvas();     // 画布此时才可见，尺寸在这里确定
    restartGame();
  }

  /** 返回菜单：清空棋盘、清零比分、停止对局。 */
  function backToMenu() {
    window.clearTimeout(winNoticeTimer);
    winNoticeTimer = null;

    hideVictory();
    stopAi();

    appState.screen = 'menu';

    // 清空棋盘并停掉游戏状态
    hover = null;
    state = T.createGameState(T.DEFAULT_SIZE);
    state.arenaState = null;

    // 比分只在返回菜单时清零（「重开」保留比分）
    score.black = 0;
    score.white = 0;
    setText(elements.score, 'score', '0 : 0');

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
    // 电脑思考时不接受人的落子（playMove 里还有一道保险）
    if (aiIsThinking() && state.currentPlayer === aiPlayer()) return;

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

  /** 把一个「对手」按钮绑到 setLevel 上。 */
  function bindLevelButton(btn) {
    if (!btn) return;

    btn.setAttribute('data-ai-bound', '1');   // 便于排查「按钮没反应」：有这个标记就说明绑上了

    btn.addEventListener('click', function () {
      setLevel(btn.getAttribute('data-ai-level'));
    });
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

    // 对手档位：菜单与游戏内两套按钮，点了都只改一个地方（ai.level）。
    // 直接遍历 roles 现查现绑，避免再依赖一个中间集合。
    var levelRoles = [
      'btn-level-human', 'btn-level-easy', 'btn-level-normal', 'btn-level-hard',
      'gbtn-level-human', 'gbtn-level-easy', 'gbtn-level-normal', 'gbtn-level-hard'
    ];

    for (var r = 0; r < levelRoles.length; r++) {
      var btns = $all(levelRoles[r]);

      for (var b = 0; b < btns.length; b++) bindLevelButton(btns[b]);
    }

    if (elements.victoryAgain) {
      elements.victoryAgain.addEventListener('click', restartGame);
    }
    if (elements.victoryBack) {
      elements.victoryBack.addEventListener('click', backToMenu);
    }

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

    // ⚠ 顺序要紧：档位按钮必须在 bindControls() **之前**收集好，
    // 否则绑定循环遍历到 undefined，按钮点了没反应（踩过这个坑）。
    elements.levelButtons = $all('btn-level-human').concat(
      $all('btn-level-easy'),
      $all('btn-level-normal'),
      $all('btn-level-hard'),
      $all('gbtn-level-human'),
      $all('gbtn-level-easy'),
      $all('gbtn-level-normal'),
      $all('gbtn-level-hard')
    );

    elements.aiStatus = $('ai-status');
    elements.aiText = $('ai-text');

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

    // 胜负结果卡
    elements.victory = $('victory');
    elements.victoryTitle = $('victory-title');
    elements.victorySub = $('victory-sub');
    elements.victoryAgain = $('btn-again');
    elements.victoryBack = $('btn-victory-back');

    if (elements.victory) elements.victory.hidden = true;

    // 系统开启「减少动态效果」时不再连续重绘，只按事件重画
    reducedMotion = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // 启动时停在开始界面：先看到菜单，不自动开局
    state = T.createGameState(T.DEFAULT_SIZE);
    appState.screen = 'menu';

    elements.menu.hidden = false;
    elements.game.hidden = true;

    bindControls();

    // 让档位按钮的选中态从一开始就有显式值：
    // HTML 里只有默认档位那一个带 aria-pressed，其余按钮要等第一次同步才有属性。
    syncLevelButtons();
  }

  G.Main = {
    init: init,

    // 供菜单按钮与调试使用
    getAppState: function () { return appState; },
    enterMode: enterMode,
    backToMenu: backToMenu,

    // 电脑对手
    setLevel: setLevel,
    getLevel: function () { return ai.level; },
    isAiThinking: aiIsThinking,
    getAiTimer: function () { return ai.timer; },

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
