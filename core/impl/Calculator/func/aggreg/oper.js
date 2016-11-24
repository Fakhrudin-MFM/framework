/**
 * Created by kras on 03.11.16.
 */
'use strict';
const ac = require('../util').argCalcPromise;

module.exports = function (collFunc, af) {
  /**
   * @param {DataRepository} dataRepo
   * @returns {Function}
   */
  return function (dataRepo) {
    return function (args) {
      return function () {
        var _this = this;
        return new Promise(function (resolve, reject) {
          ac(_this, args, 3).then(function (args) {
            if (args.length > 1) {
              if (Array.isArray(args[0])) {
                resolve(
                  collFunc(
                    args[0],
                    String(args[1]),
                    args.length > 2 && typeof args[2] === 'function' ? args[2] : null
                  )
                );
              } else if (typeof args[0] === 'string') {
                var opts = args.length > 2 && typeof args[2] === 'object' ? {filter: args[2]} : {};
                var oper = {};
                oper[af] = args[1];
                opts.expressions = {result: oper};
                dataRepo.aggregate(args[0], opts).then(function (data) {
                  resolve(data.result);
                }).catch(reject);
              } else {
                reject(new Error('Не указан источник данных агрегации!'));
              }
            } else {
              reject(new Error('Не указан агрегируемый атрибут!'));
            }
          }).catch(reject);
        });
      };
    };
  };
};
