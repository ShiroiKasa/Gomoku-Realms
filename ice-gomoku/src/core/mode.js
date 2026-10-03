/**
 * 五子奇境 · 模式配置
 *
 * 就这么一张表，两个模式。刻意不做插件系统、不做注册表、不做动态加载——
 * 场地机制只有「无」和「雪山洞穴」两种，直接查表即可。
 *
 *   arena: null    → 该模式没有场地机制（arenaState 保持 null）
 *   arena: 'snow'  → 启用雪山洞穴（冰锥预警 + 冰块）
 *   arena: 'river' → 启用山谷溪流（水位上涨 + 河流扩展 + 冲走棋子）
 *   arena: 'mine'  → 启用危险雷区（倒计时 + 3×3 爆炸 + 连锁引爆）
 */
(function () {
  'use strict';

  var G = window.Gomoku || (window.Gomoku = {});

  var Modes = {
    classic: {
      id: 'classic',
      name: '经典五子棋',
      arena: null        // 无场地机制
    },

    snow: {
      id: 'snow',
      name: '雪山洞穴',
      arena: 'snow'      // 启用冰锥机制
    },

    river: {
      id: 'river',
      name: '山谷溪流',
      arena: 'river'     // 启用河流机制
    },

    mine: {
      id: 'mine',
      name: '危险雷区',
      arena: 'mine'      // 启用雷区机制
    },

    DEFAULT: 'classic',

    /**
     * 取模式配置；传入未知 id 时回退到默认模式。
     * @param {string} id
     * @returns {object}
     */
    get: function (id) {
      return Modes[id] || Modes[Modes.DEFAULT];
    }
  };

  G.Modes = Modes;
})();
