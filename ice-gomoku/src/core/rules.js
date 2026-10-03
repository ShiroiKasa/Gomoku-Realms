/**
 * 五子奇境 · 五连判定
 *
 * 规则：横、竖、两条斜线，任意方向连成 5 子即胜。
 * 本模块只读棋盘数据，不修改任何状态。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;
  var B = G.Board;

  // 四个需要检查的方向：横、竖、撇、捺
  var DIRECTIONS = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 }
  ];

  /**
   * 从 (x, y) 沿 (dx, dy) 方向统计同色连子。
   * 返回值含棋子坐标，便于渲染层高亮整条五连。
   */
  function collectDirection(board, x, y, dx, dy, player) {
    var stones = [];
    var cx = x + dx;
    var cy = y + dy;

    while (B.isInside(board, cx, cy) && B.getCell(board, cx, cy) === player) {
      stones.push({ x: cx, y: cy });
      cx += dx;
      cy += dy;
    }

    return stones;
  }

  /**
   * 以最后一手为中心判断是否形成五连。
   *
   * 只检查经过 (lastX, lastY) 的四个方向即可：任何新的五连都必然包含刚落下的这一子。
   *
   * @param {object} board
   * @param {number} lastX
   * @param {number} lastY
   * @param {number} player
   * @returns {{winner: number, line: Array<{x:number,y:number}>}|null} 未成五连返回 null
   */
  function checkFrom(board, lastX, lastY, player) {
    if (!T.isCell(player) || player === T.EMPTY) return null;
    if (!B.isInside(board, lastX, lastY)) return null;
    if (B.getCell(board, lastX, lastY) !== player) return null;

    for (var i = 0; i < DIRECTIONS.length; i++) {
      var dir = DIRECTIONS[i];

      var forward = collectDirection(board, lastX, lastY, dir.dx, dir.dy, player);
      var backward = collectDirection(board, lastX, lastY, -dir.dx, -dir.dy, player);

      // 反向结果需倒序，才能拼成一条自起点到终点的连续线
      var line = backward.reverse().concat([{ x: lastX, y: lastY }], forward);

      if (line.length >= T.WIN_COUNT) {
        return {
          winner: player,
          // 超过五连（长连）时只取包含最后一手的那五子
          line: line.slice(0, T.WIN_COUNT)
        };
      }
    }

    return null;
  }

  /**
   * 全盘扫描是否已有五连。用于重开后的自检等场景，正常对局中不必调用。
   * @returns {{winner: number, line: Array<{x:number,y:number}>}|null}
   */
  function checkBoard(board) {
    for (var y = 0; y < board.size; y++) {
      for (var x = 0; x < board.size; x++) {
        var player = B.getCell(board, x, y);
        if (player === T.EMPTY) continue;

        var result = checkFrom(board, x, y, player);
        if (result) return result;
      }
    }

    return null;
  }

  G.Rules = {
    DIRECTIONS: DIRECTIONS,
    checkFrom: checkFrom,
    checkBoard: checkBoard
  };
})();
