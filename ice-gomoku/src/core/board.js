/**
 * 五子奇境 · 棋盘数据与落子逻辑
 *
 * 职责边界：
 *  - 本模块只关心「格子」与「落子」；
 *  - 不判胜负（见 core/rules.js），不碰 DOM，不做绘制；
 *  - 不知道任何场地概念（冰锥 / 溪流 / 雷区）。
 *
 * 坐标系：x 为列（0..size-1，自左向右），y 为行（0..size-1，自上向下）。
 * 内部用一维 Uint8Array 存放，index = y * size + x。
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});
  var T = G.Types;

  /**
   * 二维坐标 → 一维下标。
   * 调用前必须已确认坐标合法。
   */
  function indexOf(board, x, y) {
    return y * board.size + x;
  }

  /** 坐标是否落在棋盘内。 */
  function isInside(board, x, y) {
    return x >= 0 && y >= 0 && x < board.size && y < board.size;
  }

  /** 该点是否为合法且空置的交叉点。 */
  function isEmpty(board, x, y) {
    if (!isInside(board, x, y)) return false;
    return board.cells[indexOf(board, x, y)] === T.EMPTY;
  }

  /** 读取棋子值；越界抛错，避免悄悄产生 undefined。 */
  function getCell(board, x, y) {
    if (!isInside(board, x, y)) {
      throw new RangeError('getCell 越界：(' + x + ', ' + y + ')');
    }
    return board.cells[indexOf(board, x, y)];
  }

  /** 直接写入棋子值（仅限 0 | 1 | 2）。 */
  function setCell(board, x, y, value) {
    if (!isInside(board, x, y)) {
      throw new RangeError('setCell 越界：(' + x + ', ' + y + ')');
    }
    if (!T.isCell(value)) {
      throw new TypeError('setCell 只接受 0 | 1 | 2，收到：' + value);
    }
    board.cells[indexOf(board, x, y)] = value;
  }

  /**
   * 落子。会自行校验，非法则原样返回 false、不做任何修改。
   * @param {object} board
   * @param {number} x
   * @param {number} y
   * @param {number} player BLACK | WHITE
   * @returns {boolean} 是否落下
   */
  function place(board, x, y, player) {
    if (!T.isCell(player) || player === T.EMPTY) return false;
    if (!isEmpty(board, x, y)) return false;

    setCell(board, x, y, player);
    return true;
  }

  /** 清空全部格子，保留尺寸与对象本身。 */
  function clear(board) {
    board.cells.fill(T.EMPTY);
    return board;
  }

  /** 当前已落子数（由棋盘数据直接统计）。 */
  function countStones(board) {
    var total = 0;
    for (var i = 0; i < board.cells.length; i++) {
      if (board.cells[i] !== T.EMPTY) total++;
    }
    return total;
  }

  /**
   * 棋盘是否已下满。
   * @param {object} board
   * @param {number} [moveCount] 已有手数时传入可避免重复统计
   */
  function isFull(board, moveCount) {
    var used = typeof moveCount === 'number' ? moveCount : countStones(board);
    return used >= board.size * board.size;
  }

  /** 生成星位坐标，供绘制层使用。 */
  function starPoints(board) {
    var points = [];
    var step = T.STAR_SPACING;

    // 15 路盘：起点 3，依次 3、7、11，三点各成一组共 9 个星位（含天元）
    for (var y = step - 1; y < board.size; y += step) {
      for (var x = step - 1; x < board.size; x += step) {
        points.push({ x: x, y: y });
      }
    }

    return points;
  }

  G.Board = {
    create: function (size) {
      var n = size || T.DEFAULT_SIZE;
      return {
        size: n,
        cells: new Uint8Array(n * n)
      };
    },

    indexOf: indexOf,
    isInside: isInside,
    isEmpty: isEmpty,
    getCell: getCell,
    setCell: setCell,
    place: place,
    clear: clear,
    countStones: countStones,
    isFull: isFull,
    starPoints: starPoints
  };
})();
