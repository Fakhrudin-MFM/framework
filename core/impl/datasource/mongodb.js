// jscs:disable requireCapitalizedComments

/**
 * Created by kras on 25.02.16.
 */
'use strict';

const DataSource = require('core/interfaces/DataSource');
const mongo = require('mongodb');
const client = mongo.MongoClient;
const LoggerProxy = require('core/impl/log/LoggerProxy');
const empty = require('core/empty');
const clone = require('clone');
const cuid = require('cuid');
const IonError = require('core/IonError');
const Errors = require('core/errors/data-source');
const Iterator = require('core/interfaces/Iterator');
const moment = require('moment');
const Operations = require('core/FunctionCodes');
const DsOperations = require('core/DataSourceFunctionCodes');

const AUTOINC_COLLECTION = '__autoinc';
const GEOFLD_COLLECTION = '__geofields';

const allowInPrefilter = ['$text', '$geoIntersects', '$geoWithin', '$geometry', '$regex', '$options',
  '$where', '$or', '$eq', '$ne', '$lt', '$lte', '$gt', '$gte', '$exist', '$in', '$nin', '$exists'];
const excludeFromRedactfilter = ['$text', '$geoIntersects', '$geoWithin', '$regex', '$options', '$where', '$or'];
const excludeFromPostfilter = ['$text', '$geoIntersects', '$geoWithin', '$where', '$strLenCP'];
const IGNORE = '____$$$ignore$$$___$$$me$$$___';

const QUERY_OPERS = {
  [Operations.EQUAL]: '$eq',
  [Operations.NOT_EQUAL]: '$ne',
  [Operations.EMPTY]: '$empty',
  [Operations.NOT_EMPTY]: '$exists',
  [Operations.LIKE]: '$regex',
  [Operations.LESS]: '$lt',
  [Operations.GREATER]: '$gt',
  [Operations.LESS_OR_EQUAL]: '$lte',
  [Operations.GREATER_OR_EQUAL]: '$gte',
  [Operations.IN]: '$in',
  [DsOperations.JOIN_EXISTS]: '$joinExists',
  [DsOperations.JOIN_NOT_EXISTS]: '$joinNotExists',
  [DsOperations.JOIN_SIZE]: '$joinSize',
  [Operations.FULL_TEXT_MATCH]: '$text',
  [Operations.GEO_WITHIN]: '$geoWithin',
  [Operations.GEO_INTERSECTS]: '$geoIntersects'
};

const FUNC_OPERS = {
  [Operations.AND]: '$and',
  [Operations.OR]: '$or',
  [Operations.NOT]: '$not',
  [Operations.DATE]: '$date',
  [Operations.DATE_ADD]: '$dateAdd',
  [Operations.DATE_DIFF]: '$dateDiff',
  [Operations.DATE_STR]: '$dateToStr',
  [Operations.DATE_YEAR]: '$year',
  [Operations.DATE_MONTH]: '$month',
  [Operations.DATE_DAY]: '$dayOfMonth',
  [Operations.DATE_HOUR]: '$hour',
  [Operations.DATE_MINUTE]: '$minute',
  [Operations.DATE_SECOND]: '$second',
  [Operations.ADD]: '$add',
  [Operations.SUB]: '$subtract',
  [Operations.MUL]: '$multiply',
  [Operations.DIV]: '$divide',
  [Operations.ROUND]: '$round',
  [Operations.CONCAT]: '$concat',
  [Operations.SUBSTR]: '$substr',
  [Operations.MOD]: '$mod',
  [Operations.ABS]: '$abs',
  [Operations.MIN]: '$min',
  [Operations.MAX]: '$max',
  [Operations.AVG]: '$avg',
  [Operations.SUM]: '$sum',
  [Operations.COUNT]: '$sum',
  [Operations.IFNULL]: '$ifNull',
  [Operations.IF]: '$cond',
  [Operations.CASE]: '$case',
  [Operations.LITERAL]: '$literal',
  [Operations.SIZE]: '$strLenCP',
  [Operations.FORMAT]: '$dateToString'
};

// jshint maxstatements: 150, maxcomplexity: 60, maxdepth: 10, maxparams: 8

/**
 * @param {{ uri: String, options: Object }} config
 * @constructor
 */
function MongoDs(config) {

  var _this = this;

  /**
   * @type {Db}
   */
  this.db = null;

  this.isOpen = false;

  this.busy = false;

  var log = config.logger || new LoggerProxy();

  var excludeNullsFor = {};

  function wrapError(err, oper, coll) {
    if (err.name === 'MongoError') {
      if (err.code === 11000 || err.code === 11001) {
        try {
          let p = err.message.match(/\s+index:\s+([^\s_]+)_\d+\s+dup key:\s*{\s*:\s*([^}]*)\s*}/i);
          if (!p) {
            p = err.message.match(/\s+index:\s+([\w_]+)\s+dup key:\s*{\s*:\s*([^}]*)\s*}/i);
          }
          let key = [];
          let keyMatch = p && p[1] || '';
          if (keyMatch) {
            keyMatch = keyMatch.split('_');
            keyMatch.forEach(k => {
              k = k.trim();
              if (!/^\d+$/i.test(k)) {
                key.push(k);
              }
            });
          }
          let value = [];
          let valueMatch = p && p[2] || null;
          if (valueMatch) {
            let vm = valueMatch.match(/"(\S*)"/ig);
            if (vm) {
              vm.forEach(v => value.push(v.trim().replace(/^"/, '').replace(/"$/, '')));
            } else {
              vm = valueMatch.match(/(\S*)/ig);
              if (vm) {
                vm.forEach(v => value.push(v));
              }
            }
          }
          let params = {key: key, table: coll, value};
          return new IonError(Errors.UNIQUENESS_VIOLATION, params, err);
        } catch (e) {
          return new IonError(Errors.OPER_FAILED, {oper: oper, table: coll}, e);
        }
      }
    }
    return new IonError(Errors.OPER_FAILED, {oper: oper, table: coll}, err);
  }

  /**
   * @returns {Promise}
   */
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (_this.db && _this.isOpen) {
        return resolve(_this.db);
      } else if (_this.db && _this.busy) {
        _this.db.once('isOpen', function () {
          resolve(_this.db);
        });
      } else {
        _this.busy = true;
        client.connect(config.uri, config.options, function (err, db) {
          if (err) {
            reject(err);
          }
          try {
            _this.db = db;
            _this.busy = false;
            _this.isOpen = true;
            log.info('Получено соединение с базой: ' + db.s.databaseName);
            _this._ensureIndex(AUTOINC_COLLECTION, {__type: 1}, {unique: true})
                .then(
                  function () {
                    return _this._ensureIndex(GEOFLD_COLLECTION, {__type: 1}, {unique: true});
                  }
                )
                .then(
                  function () {
                    resolve(_this.db);
                    _this.db.emit('isOpen', _this.db);
                  }
                ).catch(reject);
          } catch (e) {
            _this.busy = false;
            _this.isOpen = false;
            reject(e);
          }
        });
      }
    });
  }

  this._connection = function () {
    if (this.isOpen) {
      return this.db;
    }
    return null;
  };

  this._open = function () {
    return openDb();
  };

  this._close = function () {
    return new Promise(function (resolve, reject) {
      if (_this.db && _this.isOpen) {
        _this.busy = true;
        _this.db.close(true, function (err) {
          _this.isOpen = false;
          _this.busy = false;
          if (err) {
            reject(wrapError(err));
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  };

  /**
   * @param {String} type
   * @returns {Promise}
   */
  function getCollection(type) {
    return openDb()
      .then(function () {
        // Здесь мы перехватываем автосоздание коллекций, чтобы вставить хук для создания индексов, например
        return new Promise(function (resolve, reject) {
          _this.db.collection(type, {strict: true}, function (err, c) {
            if (!c) {
              try {
                _this.db.createCollection(type)
                  .then(resolve)
                  .catch(e => reject(wrapError(err, 'create', type)));
              } catch (e) {
                return reject(e);
              }
            } else {
              if (err) {
                return reject(wrapError(err, 'open', type));
              }
              resolve(c);
            }
          });
        });
      });
  }

  function getAutoInc(type) {
    return getCollection(AUTOINC_COLLECTION).then(
      /**
       * @param {Collection} autoinc
       */
      function (autoinc) {
        return new Promise((resolve, reject) => {
          autoinc.find({__type: type})
            .limit(1)
            .next((err, counters) => {
              if (err) {
                return reject(err);
              }
              resolve({ai: autoinc, c: counters});
            });
        });
      }
    );
  }

  function autoInc(type, data) {
    return getAutoInc(type).then(
        /**
         * @param {{ai: Collection, c: {counters:{}, steps:{}}}} result
         */
        function (result) {
          if (result && result.c && result.c.counters) {
            let inc = {};
            let act = false;
            let counters = result.c.counters;
            for (let nm in counters) {
              if (counters.hasOwnProperty(nm)) {
                inc['counters.' + nm] =
                  result.c.steps && result.c.steps.hasOwnProperty(nm) ? result.c.steps[nm] : 1;
                act = true;
              }
            }

            if (act) {
              return new Promise((resolve, reject) => {
                result.ai.findOneAndUpdate(
                  {__type: type},
                  {$inc: inc},
                  {returnOriginal: false, upsert: false},
                  function (err, result) {
                    if (err) {
                      return reject(err);
                    }
                    for (let nm in result.value.counters) {
                      if (result.value.counters.hasOwnProperty(nm)) {
                        data[nm] = result.value.counters[nm];
                      }
                    }
                    resolve(data);
                  });
              });
            }
          }
          return Promise.resolve(data);
        }
      );
  }

  function excludeNulls(data, excludes) {
    var nm;
    var unsets = {};
    for (nm in data) {
      if (data.hasOwnProperty(nm)) {
        if (data[nm] === null && excludes.hasOwnProperty(nm)) {
          delete data[nm];
          unsets[nm] = true;
        }
      }
    }
    return {data: data, unset: unsets};
  }

  /**
   * @param {Collection} c
   * @returns {Promise}
   */
  function cleanNulls(c, type, data) {
    if (excludeNullsFor.hasOwnProperty(type)) {
      return Promise.resolve(excludeNulls(data, excludeNullsFor[type]));
    }
    return new Promise(
      function (resolve, reject) {
        c.indexes(function (err, indexes) {
          if (err) {
            return reject(err);
          }
          let excludes = {};
          for (let i = 0; i < indexes.length; i++) {
            if (indexes[i].unique && indexes[i].sparse) {
              for (let nm in indexes[i].key) {
                if (indexes[i].key.hasOwnProperty(nm)) {
                  excludes[nm] = true;
                }
              }
            }
          }

          excludeNullsFor[type] = excludes;
          resolve(excludeNulls(data, excludeNullsFor[type]));
        });
      }
    );
  }

  function prepareGeoJSON(data) {
    for (let nm in data) {
      if (data.hasOwnProperty(nm)) {
        if (typeof data[nm] === 'object' && data[nm] && data[nm].type && (data[nm].geometry || data[nm].features)) {
          switch (data[nm].type) {
            case 'Feature': {
              let tmp = clone(data[nm], true);
              delete tmp.geometry;
              data[nm] = data[nm].geometry;
              data['__geo__' + nm + '_f'] = tmp;
            }
              break;
            case 'FeatureCollection': {
              let tmp = {
                type: 'GeometryCollection',
                geometries: []
              };
              let tmp2 = clone(data[nm], true);

              for (let i = 0; i < tmp2.features.length; i++) {
                tmp.geometries.push(tmp2.features[i].geometry);
                delete tmp2.features[i].geometry;
              }
              data[nm] = tmp;
              data['__geo__' + nm + '_f'] = tmp2;
            }
              break;
          }
        }
      }
    }
    return data;
  }

  this._insert = function (type, data, opts) {
    let options = opts || {};
    return getCollection(type).then(
      function (c) {
        return autoInc(type, data)
            .then(
              function (data) {
                return cleanNulls(c, type, prepareGeoJSON(data));
              }
            ).then(
              function (data) {
                return new Promise(function (resolve, reject) {
                  c.insertOne(clone(data.data), function (err, result) {
                    if (err) {
                      reject(wrapError(err, 'insert', type));
                    } else if (result.insertedId) {
                      if (options.skipResult) {
                        return resolve(null);
                      }
                      _this._get(type, {[Operations.EQUAL]: ['$_id', result.insertedId]}, {}).then(resolve).catch(reject);
                    } else {
                      reject(new IonError(Errors.OPER_FAILED, {oper: 'insert', table: type}));
                    }
                  });
                });
              }
            );
      }
    );
  };

  function adjustAutoInc(type, data) {
    if (!data) {
      return Promise.resolve();
    }
    return getAutoInc(type).then(
        /**
         * @param {{ai: Collection, c: {counters:{}, steps:{}}}} result
         */
        function (result) {
          let act = false;
          let up = {};
          if (result && result.c && result.c.counters) {
            let counters = result.c.counters;
            for (let nm in counters) {
              if (counters.hasOwnProperty(nm)) {
                if (data && data.hasOwnProperty(nm) && counters[nm] < data[nm]) {
                  up['counters.' + nm] = data[nm];
                  act = true;
                }
              }
            }
          }
          if (!act) {
            return Promise.resolve(data);
          }
          return new Promise((resolve, reject) => {
            result.ai.findOneAndUpdate(
              {__type: type},
              {$set: up},
              {returnOriginal: false, upsert: false},
              function (err) {
                return err ? reject(err) : resolve(data);
              }
            );
          });
        }
      );
  }

  function fDate(args) {
    let v = '';
    if (args.length > 0) {
      v = args[0];
    }

    if (!v) {
      v = new Date();
    } else if (v === 'today') {
      v = new Date();
      v.setHours(0, 0, 0);
    } else {
      v = moment(v).toDate();
    }
    return v;
  }

  function fDateAdd(args) {
    let base = args[0];
    let unit = 'd';
    if (args.length > 2) {
      unit = args[2];
    }
    let interval = args[1];
    switch (unit) {
      case 'ms': interval = interval;break;
      case 's': interval = {$multiply: [interval, 1000]};break;
      case 'min': interval = {$multiply: [interval, 60000]};break;
      case 'h': interval = {$multiply: [interval, 3600000]};break;
      case 'd': interval = {$multiply: [interval, 86400000]};break;
      case 'm': interval = {$multiply: [interval, 2626200000]};break;
      case 'y': interval = {$multiply: [interval, 31514400000]};break;
      default: throw 'Передан некорректный тип интервала дат!';
    }
    return {$add: [base, interval]};
  }

  function fDateDiff(args) {
    let d1 = args[0];
    let d2 = args[1];
    let unit = 'd';
    if (args.length > 2) {
      unit = args[2];
    }

    let floor = false;
    if (args.length > 3) {
      floor = args[3];
    }

    let result = null;
    switch (unit) {
      case 'm':  {
        result = {
            $subtract: [
              {$add: [
                {$multiply: [
                  {$subtract: [
                    {$year: d1},
                    1
                  ]},
                  12
                ]},
                {$subtract: [{$month: d1}, 1]},
                {$divide: [{$dayOfMonth: d1}, 31]}
              ]},
              {$add: [
                {$multiply: [
                  {$subtract: [
                    {$year: d2},
                    1
                  ]},
                  12
                ]},
                {$subtract: [{$month: d2}, 1]},
                {$divide: [{$dayOfMonth: d2}, 31]}
              ]}]
          };
      }break;
      case 'y':result = {
          $subtract: [
            {$add: [
              {$subtract: [
                {$year: d1},
                1
              ]},
              {$divide: [{$dayOdYear: d1}, 365]}
            ]},
            {$add: [
              {$subtract: [
                {$year: d2},
                1
              ]},
              {$divide: [{$dayOdYear: d2}, 365]}
            ]}]
        };break;
      case 'ms': result = {$subtract: [d1, d2]};break;
      case 's': result = {$divide: [{$subtract: [d1, d2]}, 1000]};break;
      case 'min': result = {$divide: [{$subtract: [d1, d2]}, 60000]};break;
      case 'h': result = {$divide: [{$subtract: [d1, d2]}, 3600000]};break;
      case 'd': result = {$divide: [{$subtract: [d1, d2]}, 86400000]};break;
      default: throw 'Передан некорректный тип интервала дат!';
    }

    if (floor) {
      return {$floor: result};
    }
    return result;
  }

  function argsToSides(args) {
    let attr = null;
    let right;
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === 'string' && args[i].length > 1 && args[i][0] === '$' && !attr) {
        attr = args[i].substr(1);
      } else {
        right = args[i];
      }
      if (attr && typeof right !== 'undefined') {
        break;
      }
    }
    return {attr, right};
  }

  function parseCondition(c) {
    if (Array.isArray(c)) {
      let result = [];
      c.forEach((c1) => {result.push(parseCondition(c1));});
      return result;
    }
    if (c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof mongo.ObjectID)) {
      for (let oper in c) {
        if (c.hasOwnProperty(oper)) {
          if (QUERY_OPERS.hasOwnProperty(oper)) {
            let o = QUERY_OPERS[oper];
            switch (o) {
              case '$joinSize':
              case '$joinExists':
              case '$joinNotExists':
                return {
                  [o]: {
                    table: c[oper][0],
                    left: c[oper][1],
                    right: c[oper][2],
                    filter: parseCondition(c[oper][3]),
                    many: c[oper][4]
                  }
                };
              case '$text':
                return {$text: c[oper][0]};
              case '$geoWithin':
              case '$geoIntersects': {
                let {attr, right} = argsToSides(c[oper]);
                if (attr && right) {
                  return {[attr]: {[o]: {$geometry: right}}};
                }
                return {[o]: parseCondition(c[oper])};
              }break;
              default: {
                let args = parseCondition(c[oper]);
                let {attr, right} = argsToSides(args);
                if (!attr) {
                  return {[o]: args};
                }

                if (attr && right) {
                  if (attr[0] === '$' && right[0] === '$') {
                    if (attr.indexOf('.') >= 0) {
                      let tmp = attr;
                      attr = right;
                      right = tmp;
                    }
                  }
                }

                switch (o) {
                  case '$regex':
                    if (typeof right !== 'undefined') {
                      return {[attr]: {$regex: right, $options: 'i'}};
                    }break;
                  case '$empty':
                    return {[attr]: {$empty: true}};
                  case '$exists':
                    return {[attr]: {$empty: false}};
                }
                if (typeof right !== 'undefined') {
                  if (o === QUERY_OPERS[Operations.EQUAL]) {
                    return {[attr]: right};
                  }
                  return {[attr]: {[o]: right}};
                }
                return {[o]: args};
              }
            }
          } else if (FUNC_OPERS.hasOwnProperty(oper)) {
            if (oper === Operations.AND) {
              let conds = parseCondition(c[oper]);
              let processed = {};
              for (let i = 0; i < conds.length; i++) {
                let c = conds[i];
                let loper;
                for (loper in c) {
                  if (c.hasOwnProperty(loper)) {
                    break;
                  }
                }

                let oper2;
                if (loper) {
                  for (oper2 in c[loper]) {
                    if (c[loper].hasOwnProperty(oper2)) {
                      break;
                    }
                  }
                }
                if (loper && loper[0] !== '$' &&
                  oper2 === QUERY_OPERS[Operations.EQUAL] && !processed.hasOwnProperty(loper)
                ) {
                  processed[loper] = c[loper][oper2];
                } else {
                  processed = false;
                  break;
                }
              }
              if (processed) {
                return processed;
              }
            }
            switch (oper) {
              case Operations.SIZE: {
                let args = parseCondition(c[oper]);
                return {$strLenCP: args[0]};
              }
            }
            return {[FUNC_OPERS[oper]]: parseCondition(c[oper])};
          }
        }
      }
      return IGNORE;
    }
    return c;
  }

  function prepareDateFormat(format) {
    return format
      .replace('d', '%w')
      .replace('DDDD', '%j')
      .replace('DD', '%d')
      .replace('MM', '%m')
      .replace('YYYY', '%Y')
      .replace('HH', '%H')
      .replace('mm', '%M')
      .replace('ss', '%S')
      .replace('SSS', '%L')
      .replace('WW', '%V');
  }

  function parseExpression(e, attributes, joinedSources, explicitJoins, joins, counter) {
    if (Array.isArray(e)) {
      let result = [];
      e.forEach((e1)=> {result.push(parseExpression(e1, attributes, joinedSources, explicitJoins, joins, counter));});
      return result;
    }
    if (e && typeof e === 'object' && !(e instanceof Date)) {
      for (let oper in e) {
        if (e.hasOwnProperty(oper)) {
          let o = QUERY_OPERS[oper] || FUNC_OPERS[oper];
          if (o) {
            if (oper === Operations.NOT_EMPTY) {
              return {$ne: [{$type: parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter)[0]}, 'null']};
            } else if (oper === Operations.NOT_EMPTY) {
              return {$eq: [{$type: parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter)[0]}, 'null']};
            } else if (oper === Operations.DATE) {
              return fDate(e[oper]);
            } else if (oper === Operations.DATE_ADD) {
              return fDateAdd(parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter));
            } else if (oper === Operations.DATE_DIFF) {
              return fDateDiff(parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter));
            } else if (oper === Operations.SIZE) {
              let args = parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter);
              return {$strLenCP: args[0]};
            } else if (oper === Operations.FORMAT) {
              let args = parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter);
              return {$dateToString: {date: args[0], format: prepareDateFormat(args[1])}};
            } else if (oper === Operations.CASE) {
              let args = parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter);
              let result = {$switch: {
                branches: []
              }};
              for (let i = 0; i < args.length; i++) {
                if (i === args.length - 1 && args.length % 2 === 1) {
                  result.$switch.default = args[i];
                } else if ((i + 1) % 2 === 1) {
                  result.$switch.branches.push({case: args[i]});
                } else {
                  result.$switch.branches[result.$switch.branches.length - 1].then = args[i];
                }
              }
              return result;
            } else if (
              oper === DsOperations.JOIN_EXISTS ||
              oper === DsOperations.JOIN_NOT_EXISTS ||
              oper === DsOperations.JOIN_SIZE
            ) {
              let f = parseCondition(e[oper][3]);
              if (f) {
                prepareConditions(f);
              }
              let join = {
                table: e[oper][0],
                left: e[oper][1],
                right: e[oper][2],
                filter: f,
                many: e[oper][4]
              };

              let jid = joinId(join);
              let j;
              if (explicitJoins.hasOwnProperty(jid)) {
                j = explicitJoins[jid];
              } else {
                j = join;
                j.alias = '__j' + counter.v;
                counter.v++;
              }

              let jsrc = {};
              let pj = processJoin(attributes, jsrc, explicitJoins, null, counter);
              pj(j);

              for (let ja in jsrc) {
                if (jsrc.hasOwnProperty(ja)) {
                  joins.push(jsrc[ja]);
                }
              }
              switch (oper) {
                case DsOperations.JOIN_EXISTS: return {$gt: ['$' + j.alias + '_size', 0]};
                case DsOperations.JOIN_NOT_EXISTS: return {$eq: ['$' + j.alias + '_size', 0]};
                case DsOperations.JOIN_SIZE: return '$' + j.alias + '_size';
              }
            } else {
              return {[o]: parseExpression(e[oper], attributes, joinedSources, explicitJoins, joins, counter)};
            }
          }
        }
      }
      return IGNORE;
    }
    return e;
  }

  function prepareConditions(conditions, part, parent, nottop, part2, parent2) {
    if (Array.isArray(conditions)) {
      for (let i = 0; i < conditions.length; i++) {
        prepareConditions(conditions[i], i, conditions, false, part, parent);
      }
    } else if (
        typeof conditions === 'object' && conditions &&
        !(conditions instanceof Date) && !(conditions instanceof mongo.ObjectID)
    ) {
      for (let nm in conditions) {
        if (conditions.hasOwnProperty(nm)) {
          if (nm === '_id' && typeof conditions._id === 'string') {
            conditions._id = new mongo.ObjectID(conditions._id);
          } else if (nm === '$not' && nottop !== true) {
            let tmp = prepareConditions(conditions[nm], nm, conditions, true, part, parent);
            conditions.$nor = Array.isArray(tmp) ? tmp : [tmp];
            delete conditions[nm];
          } else if (nm === '$empty') {
            if (parent && part) {
              let tmp = conditions[nm] ? '$or' : '$nor';
              delete parent[part];
              parent[tmp] = [];
              let tmp2 = {};
              tmp2[part] = {$eq: ''};
              parent[tmp].push(tmp2);
              tmp2 = {};
              tmp2[part] = {$eq: null};
              parent[tmp].push(tmp2);
              tmp2 = {};
              tmp2[part] = {$exists: false};
              parent[tmp].push(tmp2);
            }
          } else if (nm === '$date') {
            parent[part] = fDate(conditions[nm]);
            break;
          } else if (nm === '$dateAdd') {
            parent[part] = fDateAdd(conditions[nm]);
            break;
          } else if (nm === '$dateDiff') {
            parent[part] = fDateDiff(conditions[nm]);
            break;
          } else if (nm === '$joinExists' || nm === '$joinNotExists' || nm === '$joinSize') {
            if (conditions[nm].filter) {
              prepareConditions(conditions[nm].filter, 'filter', conditions[nm], false, part, parent);
            }
          } else {
            prepareConditions(conditions[nm], nm, conditions, true, part, parent);
          }
        }
      }
    }
    return conditions;
  }

  function adjustSetKeys(conditions, data) {
    if (Array.isArray(conditions)) {
      for (let i = 0; i < conditions.length; i++) {
        adjustSetKeys(conditions[i], data);
      }
    }
    if (conditions && typeof conditions === 'object' &&
      !(conditions instanceof Date) && !(conditions instanceof mongo.ObjectID)) {
      for (let oper in conditions) {
        if (conditions.hasOwnProperty(oper) && oper === Operations.EQUAL) {
          let args = conditions[oper];
          for (let i = 0; i < args.length; i++) {
            if (args[i] && typeof args[i] === 'string' && args[i][0] === '$') {
              let an = args[i].substr(1);
              if (data.hasOwnProperty(an)) {
                conditions[oper] = [args[i], data[an]];
                break;
              }
            }
          }
          break;
        }
      }
    }
  }

  /**
   * @param {String} type
   * @param {{}} conditions
   * @param {{}} data
   * @param {{}} options
   * @param {Boolean} options.upsert
   * @param {Boolean} options.bulk
   * @param {Boolean} options.skipResult
   * @returns {Promise}
     */
  function doUpdate(type, conditions, data, options) {
    let hasData = false;
    if (data) {
      for (let nm in data) {
        if (data.hasOwnProperty(nm) &&
          typeof data[nm] !== 'undefined' &&
          typeof data[nm] !== 'function'
        ) {
          hasData = nm;
          break;
        }
      }
    }

    if (!hasData) {
      if (options.skipResult) {
        return Promise.resolve();
      }
      return _this._get(type, conditions, {});
    }

    return getCollection(type).then(
      function (c) {
        return cleanNulls(c, type, prepareGeoJSON(data))
          .then(
            function (data) {
              return new Promise(function (resolve, reject) {
                let updates = {};
                if (!empty(data.data)) {
                  updates.$set = data.data;
                }
                if (!empty(data.unset)) {
                  updates.$unset = data.unset;
                }
                let pconditions = parseCondition(conditions);
                prepareConditions(pconditions);
                if (!options.bulk) {
                  c.updateOne(
                    pconditions,
                    updates,
                    {upsert: options.upsert || false},
                    function (err) {
                      if (err) {
                        return reject(wrapError(err, options.upsert ? 'upsert' : 'update', type));
                      }
                      let p;
                      if (options.skipResult) {
                        p = options.upsert ? adjustAutoInc(type, updates.$set) : Promise.resolve();
                      } else {
                        if (updates.$set) {
                          adjustSetKeys(conditions, updates.$set);
                        }
                        p = _this._get(type, conditions, {}).then(function (r) {
                          return options.upsert ? adjustAutoInc(type, r) : Promise.resolve(r);
                        });
                      }
                      p.then(resolve).catch(reject);
                    });
                } else {
                  c.updateMany(pconditions, updates,
                    function (err, result) {
                      if (err) {
                        return reject(wrapError(err, 'update', type));
                      }
                      if (options.skipResult) {
                        return resolve(result.matchedCount);
                      }
                      _this._iterator(type, {filter: conditions}).then(resolve).catch(reject);
                    });
                }
              });
            }
          );
      });
  }

  this._update = function (type, conditions, data, options) {
    return doUpdate(type, conditions, data, {bulk: options.bulk, skipResult: options.skipResult});
  };

  this._upsert = function (type, conditions, data, options) {
    return doUpdate(type, conditions, data, {upsert: true, skipResult: options.skipResult});
  };

  this._delete = function (type, conditions) {
    return getCollection(type).then(
      function (c) {
        return new Promise(function (resolve, reject) {
          conditions = parseCondition(conditions);
          prepareConditions(conditions);
          c.deleteMany(conditions,
            function (err, result) {
              if (err) {
                return reject(wrapError(err, 'delete', type));
              }
              resolve(result.deletedCount);
            });
        });
      }
    );
  };

  function addPrefix(nm, prefix, sep) {
    sep = sep || '.';
    if (nm.substr(0, nm.indexOf('.')) === prefix) {
      return nm;
    }
    return (prefix ? prefix + sep : '') + nm;
  }

  function wind(attributes) {
    var tmp, tmp2, i;
    tmp = {};
    tmp2 = {_id: false};
    for (i = 0; i < attributes.length; i++) {
      tmp[attributes[i]] = '$' + attributes[i];
      tmp2[attributes[i]] = '$_id.' + attributes[i];
    }
    return [{$group: {_id: tmp}}, {$project: tmp2}];
  }

  function clean(attributes) {
    var tmp = {};
    var i;
    for (i = 0; i < attributes.length; i++) {
      tmp[attributes[i]] = 1;
    }
    return {$project: tmp};
  }

  function joinId(join, context) {
    return (context ? context + ':' : '') + join.table + ':' + join.left + ':' +
      join.right + ':' + (join.many ? 'm' : '1') + (join.alias ? ':' + join.alias : '');
  }

  /**
   * @param {Array} attributes
   * @param {Array} joins
   * @param {Array} result
   */
  function processJoins(attributes, joins, result, prefix) {
    if (joins.length) {
      if (!attributes || !attributes.length) {
        throw new Error('Не передан список атрибутов необходимый для выполнения объединений.');
      }
      joins.forEach(function (join) {
        var tmp;
        var left = (prefix ? prefix + '.' : '') + join.left;
        if (join.many) {
          left = '__uw_' + join.left;
          tmp = clean(attributes);
          tmp.$project[left] = '$' + (prefix ? prefix + '.' : '') + join.left;
          attributes.push(left);
          result.push(tmp);
          result.push({$unwind: {path: '$' + left, preserveNullAndEmptyArrays: true}});
        }

        tmp = {
          from: join.table,
          localField: left,
          foreignField: join.right,
          as: join.alias
        };
        result.push({$lookup: tmp});
        attributes.push(join.alias);

        tmp = clean(attributes);
        tmp.$project[join.alias + '_size'] = {$size: '$' + join.alias};
        attributes.push(join.alias + '_size');
        result.push(tmp);

        if (!join.onlySize || Array.isArray(join.join)) {
          result.push({$unwind: {path: '$' + join.alias, preserveNullAndEmptyArrays: true}});
        }
        /*
        if (Array.isArray(join.join)) {
          processJoins(attributes, join.join, result, join.alias);
        }
        */
      });
    }
  }

  function processJoin(attributes, joinedSources, lookups, leftPrefix, counter, joins) {
    counter = counter || {v: 0};
    return function (join) {
      leftPrefix = leftPrefix || '';
      if (!leftPrefix && attributes.indexOf(join.left) < 0 && join.left.indexOf('.') < 0) {
        attributes.push(join.left);
      }
      if (!join.alias) {
        join.alias = '__j' + counter.v;
        counter.v++;
      }
      if (leftPrefix && (join.left.indexOf('.') < 0 || join.left.substr(0, join.left.indexOf('.')) !== leftPrefix)) {
        join.left = leftPrefix + '.' + join.left;
      }
      let jid = joinId(join, leftPrefix);
      if (!lookups.hasOwnProperty(jid)) {
        lookups[jid] = join;
        if (Array.isArray(joins)) {
          joins.push(join);
        }
        joinedSources[join.alias] = join;
      }
      if (Array.isArray(join.join)) {
        join.join.forEach(processJoin(attributes, joinedSources, lookups, join.alias, counter, joins));
      }
    };
  }

  /**
   * @param {Array} attributes
   * @param {{}} find
   * @param {Object[]} joins
   * @param {{}} explicitJoins
   * @param {{v:Number}} counter
   * @returns {*}
   */
  function producePrefilter(attributes, find, joins, explicitJoins, analise, counter, prefix) {
    counter = counter || {v: 0};
    if (Array.isArray(find)) {
      let result = [];
      for (let i = 0; i < find.length; i++) {
        let tmp = producePrefilter(attributes, find[i], joins, explicitJoins, analise, counter, prefix);
        if (tmp !== null) {
          result.push(tmp);
        }
      }
      return result.length ? result : null;
    } else if (typeof find === 'object' && find && !(find instanceof Date) && !(find instanceof mongo.ObjectID)) {
      let result;
      let jsrc = {};
      let pj = processJoin(attributes, jsrc, explicitJoins, prefix, counter);
      for (let name in find) {
        if (find.hasOwnProperty(name)) {
          if (name === '$joinExists' || name === '$joinNotExists' || name === '$joinSize') {
            analise.needPostFilter = true;
            let jid = joinId(find[name]);
            let j;
            if (explicitJoins.hasOwnProperty(jid)) {
              j = explicitJoins[jid];
            } else {
              j = clone(find[name]);
              delete j.filter;
              j.alias = '__j' + counter.v;
              counter.v++;
            }

            find[name].alias = j.alias;
            pj(find[name]);

            for (let ja in jsrc) {
              if (jsrc.hasOwnProperty(ja)) {
                joins.push(jsrc[ja]);
              }
            }

            if (find[name].filter) {
              producePrefilter(attributes, find[name].filter, joins, explicitJoins, analise, counter, j.alias);
            }
            result = name === '$joinSize' ? IGNORE : true;
            break;
          } else {
            let jalias = prefix;
            if (name.indexOf('.') > 0) {
              analise.needPostFilter = true;
              jalias = name.substr(0, name.indexOf('.'));
              let i = 0;
              for (i = 0; i < joins.length; i++) {
                if (joins[i].alias === jalias) {
                  break;
                }
              }
              if (i < joins.length) {
                attributes.push(jalias);
                result = IGNORE;
                break;
              }
            }

            let tmp = producePrefilter(attributes, find[name], joins, explicitJoins, analise, counter, jalias);
            if (name === '$or') {
              if (Array.isArray(tmp)) {
                for (let i = 0; i < tmp.length; i++) {
                  if (tmp[i] === true || tmp[i] === IGNORE) {
                    result = IGNORE;
                    break;
                  }
                }
                if (!result && tmp.length) {
                  result = tmp.length > 1 ? {$or: tmp} : tmp[0];
                }
              } else {
                result = IGNORE;
                break;
              }
            } else if (name === '$and' || name === '$nor') {
              if (Array.isArray(tmp)) {
                result = [];
                for (let i = 0; i < tmp.length; i++) {
                  if (tmp[i] !== true && tmp[i] !== IGNORE) {
                    result.push(tmp[i]);
                  }
                }
                if (name === '$and') {
                  result = result.length ? (result.length > 1 ? {$and: result} : result[0]) : IGNORE;
                } else {
                  result = result.length ? {$nor: result} : IGNORE;
                }
                break;
              } else {
                result = IGNORE;
                break;
              }
            } else {
              if (name === '$not') {
                if (Array.isArray(tmp)) {
                  let tmp2 = [];
                  for (let i = 0; i < tmp.length; i++) {
                    if (tmp[i] !== true && tmp[i] !== IGNORE) {
                      tmp2.push(tmp[i]);
                    }
                  }
                  tmp = tmp2.length ? tmp2 : IGNORE;
                }
                if (tmp === IGNORE) {
                  result = IGNORE;
                  break;
                } else {
                  result = {};
                  result.$nor = tmp;
                }
              } else {
                if (
                  name[0] === '$' &&
                  Array.isArray(tmp) &&
                  !(name === '$and' || name === '$or' || name === 'not' || name === 'nor' || name === '$in')
                ) {
                  result = IGNORE;
                  break;
                }

                if (tmp === IGNORE) {
                  result = IGNORE;
                  break;
                } else if (typeof tmp === 'string' && tmp[0] === '$') {
                  let an = (tmp.indexOf('.') > 0 ? tmp.substring(0, tmp.indexOf('.')) : tmp).substr(1);
                  if (tmp.indexOf('.') > 0) {
                    analise.needPostFilter = true;
                  }
                  if (attributes.indexOf(an) < 0) {
                    attributes.push(an);
                  }
                  result = IGNORE;
                  break;
                } else if (name[0] === '$') {
                  if (allowInPrefilter.indexOf(name) < 0) {
                    result = IGNORE;
                    analise.needRedact = true;
                    break;
                  } else {
                    result = result || {};
                    result[name] = tmp;
                  }
                } else {
                  result = result || {};
                  if (attributes.indexOf(name) < 0) {
                    attributes.push(name);
                  }
                  result[name] = tmp;
                }
              }
            }
          }
        }
      }
      if (result !== undefined) {
        return result;
      }
    }
    return find;
  }

  function joinPostFilter(join, explicitJoins, prefix, oper) {
    let jid = joinId(join, prefix);
    let j = explicitJoins[jid];

    if (prefix) {
      j.left = addPrefix(j.left, prefix);
    }
    let f = null;
    if (join.filter || join.join) {
      f = null;
      if (join.filter) {
        f = producePostfilter(join.filter, explicitJoins, join.alias);
        if (f !== null) {
          if (QUERY_OPERS[DsOperations.JOIN_NOT_EXISTS]) {
            f = {$nor: f};
          }
        }
      }

      if (Array.isArray(join.join)) {
        let and = [];
        for (let i = 0; i < join.join.length; i++) {
          let tmp = joinPostFilter(join.join[i], explicitJoins, join.alias, QUERY_OPERS[DsOperations.JOIN_EXISTS]);
          if (tmp) {
            and.push(tmp);
          }
        }
        if (and.length) {
          if (f) {
            and.push(f);
          }
          f = {$and: and};
        }
      }
    } else {
      if (oper === QUERY_OPERS[DsOperations.JOIN_SIZE]) {
        return '$' + j.alias + '_size';
      } else {
        f = {};
        f[j.alias + '_size'] = 0;
        j.passSize = true;
        if (oper === QUERY_OPERS[DsOperations.JOIN_EXISTS]) {
          f[j.alias + '_size'] = {$ne: 0};
        }
      }
    }
    return f;
  }

  /**
   * @param {{}} find
   * @param {{}} explicitJoins
   * @param {String} [prefix]
   * @returns {*}
   */
  function producePostfilter(find, explicitJoins, prefix) {
    if (Array.isArray(find)) {
      let result = [];
      for (let i = 0; i < find.length; i++) {
        let tmp = producePostfilter(find[i], explicitJoins, prefix);
        if (tmp) {
          result.push(tmp);
        }
      }
      return result.length ? result : undefined;
    } else if (typeof find === 'object' && find !== null && !(find instanceof Date) && !(find instanceof mongo.ObjectID)) {
      let result;
      for (let name in find) {
        if (find.hasOwnProperty(name)) {
          if (name === '$joinExists' || name === '$joinNotExists' || name === '$joinSize') {
            return joinPostFilter(find[name], explicitJoins, prefix, name);
          } else if (excludeFromPostfilter.indexOf(name) >= 0) {
            return undefined;
          } else {
            let tmp = producePostfilter(find[name], explicitJoins, prefix);
            if (tmp !== undefined) {
              result = result || {};
              if (name[0] !== '$') {
                result[prefix && name.indexOf('.') < 0 ? addPrefix(name, prefix) : name] = tmp;
              } else {
                if (!Array.isArray(tmp) || name === '$and' || name === '$or' || name === '$not' || name === '$nor') {
                  result[name] = tmp;
                } else {
                  let {attr, right} = argsToSides(tmp);
                  if (!attr) {
                    return undefined;
                  }

                  if (attr && right) {
                    if (attr[0] === '$' && right[0] === '$') {
                      if (attr.indexOf('.') >= 0) {
                        let tmp = attr;
                        attr = right;
                        right = tmp;
                      }
                    }
                  }

                  result[attr] = {[name]: right};
                }
              }
            }
          }
        }
      }
      return result;
    }
    return find;
  }

  /**
   * @param {{}} find
   * @param {{}} explicitJoins
   * @param {String} [prefix]
   * @returns {*}
   */
  function produceRedactFilter(find, explicitJoins, prefix, includeNulls) {
    if (Array.isArray(find)) {
      let result = [];
      for (let i = 0; i < find.length; i++) {
        let tmp = produceRedactFilter(find[i], explicitJoins, prefix);
        if (tmp || includeNulls) {
          result.push(tmp);
        }
      }
      return result.length ? result : null;
    } else if (typeof find === 'object' && find !== null && !(find instanceof Date) && !(find instanceof mongo.ObjectID)) {
      let result = [];
      for (let name in find) {
        if (find.hasOwnProperty(name)) {
          if (name[0] === '$') {
            let tmp = produceRedactFilter(find[name], explicitJoins, prefix, true);
            if (tmp !== null) {
              let nm = name;
              if (name === '$nor' || name === '$or') {
                let skip = !(Array.isArray(tmp) && tmp.length);
                if (!skip) {
                  for (let i = 0; i < tmp.length; i++) {
                    if (tmp[i] === null) {
                      skip = true;
                      break;
                    }
                  }
                }
                if (skip) {
                  tmp = null;
                } else {
                  if (name === '$nor') {
                    nm = '$not';
                    if (tmp.length > 1) {
                      tmp = {$or: tmp};
                    }
                  }
                }
              } else if (name === '$and') {
                let skip = !(Array.isArray(tmp) && tmp.length);
                let tmp2 = [];
                if (!skip) {
                  for (let i = 0; i < tmp.length; i++) {
                    if (tmp[i]) {
                      tmp2.push(tmp[i]);
                    }
                  }
                }
                if (skip || tmp2.length === 0) {
                  tmp = null;
                } else {
                  tmp = tmp2;
                }
              }
              if (tmp) {
                result.push({[nm]: tmp});
              }
            }
          } else {
            let nm = prefix ? addPrefix(name, prefix) : name;
            let loperand = '$' + nm;

            if (typeof find[name] === 'object' && find[name] !== null) {
              for (let oper in find[name]) {
                if (find[name].hasOwnProperty(oper)) {
                  if (excludeFromRedactfilter.indexOf(oper) < 0) {
                    if (oper === '$exists') {
                      if (find[name][oper]) {
                        result.push({$not: [{$eq: [{$type: '$' + nm}, 'missing']}]});
                      } else {
                        result.push({$eq: [{$type: '$' + nm}, 'missing']});
                      }
                    } else {
                      result.push({[oper]: [loperand, produceRedactFilter(find[name][oper], explicitJoins, prefix)]});
                    }
                  }
                }
              }
            } else {
              result.push({$eq: [loperand, find[name]]});
            }
          }
        }
      }
      if (result.length) {
        return result.length === 1 ? result[0] : {$and: result};
      }
      return null;
    }
    return find;
  }

  /**
   * @param {String} lexem
   * @param {String[]} attributes
   * @param {{}} joinedSources
   */
  function checkAttrLexem(lexem, attributes, joinedSources) {
    var tmp = lexem.indexOf('.') < 0 ? lexem : lexem.substr(0, lexem.indexOf('.'));
    if (tmp[0] === '$' && !joinedSources.hasOwnProperty(tmp)) {
      tmp = tmp.substr(1);
      if (attributes.indexOf(tmp) < 0) {
        attributes.push(tmp);
      }
    }
  }

  /**
   * @param {{}} expr
   * @param {String[]} attributes
   * @param {{}} joinedSources
   */
  function checkAttrExpr(expr, attributes, joinedSources) {
    if (typeof expr === 'string') {
      checkAttrLexem(expr, attributes, joinedSources);
    } else if (Array.isArray(expr)) {
      for (let i = 0; i < expr.length; i++) {
        checkAttrExpr(expr[i], attributes, joinedSources);
      }
    } else if (typeof expr === 'object') {
      for (let nm in expr) {
        if (expr.hasOwnProperty(nm)) {
          if (nm[0] !== '$') {
            checkAttrLexem('$' + nm, attributes, joinedSources);
          }
          checkAttrExpr(expr[nm], attributes, joinedSources);
        }
      }
    }
  }

  /**
   * @param {String} type
   * @param {{}} options
   * @param {{}} [options.filter]
   * @param {{}} [options.fields]
   * @param {{}} [options.aggregates]
   * @param {{}} [options.joins]
   * @param {{}} [options.sort]
   * @param {String} [options.to]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @param {Boolean} [options.distinct]
   * @param {String[]} [options.select]
   * @param {Array} [forcedStages]
   * @param {Boolean} [onlyCount]
   * @returns {Promise}
   */
  function checkAggregation(type, options, forcedStages, onlyCount) {
    forcedStages = forcedStages || [];
    let groupStages = [];
    let attributes = options.attributes || [];
    let joinedSources = {};
    let lookups = {};
    let result = [];
    let joins = [];
    let resultAttrs = [];
    let prefilter, postfilter, redactFilter, jl;
    let doGroup = false;
    let fetchFields = false;
    let analise = {
      needRedact: false,
      needPostFilter: false
    };

    let counter = {v: 0};

    try {
      if (Array.isArray(options.joins)) {
        options.joins.forEach(processJoin(attributes, joinedSources, lookups, null, null, joins));
      }

      if (options.fields || options.aggregates) {
        let expr = {$group: {}};
        expr.$group._id = null;
        let attrs = {_id: false};
        if (options.fields) {
          for (let tmp in options.fields) {
            if (options.fields.hasOwnProperty(tmp)) {
              if (!expr.$group._id) {
                expr.$group._id = {};
              }
              if (!isNaN(options.fields[tmp]) || typeof options.fields[tmp] === 'boolean') {
                expr.$group._id[tmp] = {$literal: options.fields[tmp]};
                doGroup = true;
              } else if (options.fields[tmp] && typeof options.fields[tmp] === 'object' && !(options.fields[tmp] instanceof Date)) {
                options.fields[tmp] = parseExpression(options.fields[tmp], attributes, joinedSources, lookups, joins, counter);
                checkAttrExpr(options.fields[tmp], attributes, joinedSources);
                expr.$group._id[tmp] = {$ifNull: [options.fields[tmp], null]};
                doGroup = true;
              } else if (options.fields[tmp] && typeof options.fields[tmp] === 'string' && options.fields[tmp][0] === '$') {
                checkAttrExpr(options.fields[tmp], attributes, joinedSources);
                expr.$group._id[tmp] = {$ifNull: [options.fields[tmp], null]};
                fetchFields = true;
                if (tmp !== options.fields[tmp].substr(1)) {
                  doGroup = true;
                }
              } else {
                expr.$group._id[tmp] = options.fields[tmp];
                doGroup = true;
              }
              attrs[tmp] = '$_id.' + tmp;
            }
          }
        }

        if (options.aggregates) {
          for (let alias in options.aggregates) {
            if (options.aggregates.hasOwnProperty(alias)) {
              for (let oper in options.aggregates[alias]) {
                if (options.aggregates[alias].hasOwnProperty(oper)) {
                  if (
                    oper === Operations.SUM || oper === Operations.AVG ||
                    oper === Operations.MIN || oper === Operations.MAX || oper === Operations.COUNT
                  ) {
                    if (oper === Operations.COUNT) {
                      expr.$group[alias] = {[FUNC_OPERS[oper]]: {$literal: 1}};
                    } else {
                      options.aggregates[alias][oper] =
                        parseExpression(options.aggregates[alias][oper], attributes, joinedSources, lookups, joins, counter);
                      checkAttrExpr(options.aggregates[alias][oper], attributes, joinedSources);
                      if (options.aggregates[alias][oper].length) {
                        expr.$group[alias] = {[FUNC_OPERS[oper]]: options.aggregates[alias][oper][0]};
                      }
                    }
                  }
                }
              }
              attrs[alias] = 1;
              doGroup = true;
            }
          }
        }

        if (doGroup || fetchFields) {
          groupStages.push(expr);
          groupStages.push({$project: attrs});
        }
      }

      resultAttrs = attributes.slice(0);

      if (options.filter) {
        jl = joins.length;
        prefilter = producePrefilter(attributes, options.filter, joins, lookups, analise, counter);
        if (analise.needRedact || analise.needPostFilter) {
          postfilter = producePostfilter(options.filter, lookups);
          redactFilter = produceRedactFilter(postfilter, lookups);
          postfilter = producePrefilter([], postfilter, [], [], {});
        }
      }

      if (prefilter && typeof prefilter === 'object' &&
        (joins.length || options.to || forcedStages.length || analise.needRedact || analise.needPostFilter)) {
        result.push({$match: prefilter});
      }
    } catch (err) {
      return Promise.reject(wrapError(err, 'aggregate', type));
    }

    let p = null;
    if (joins.length) {
      p = getCollection(GEOFLD_COLLECTION).then(function (c) {
        return new Promise(function (resolve, reject) {
          c.find({__type: type}).limit(1).next(function (err, geoflds) {
            if (err) {
              return reject(err);
            }
            for (let fld in geoflds) {
              if (geoflds.hasOwnProperty(fld) && fld !== '__type' && fld !== '_id') {
                resultAttrs.push('__geo__' + fld + '_f');
              }
            }
            resolve();
          });
        });
      });
    } else {
      p = Promise.resolve();
    }

    return p.then(function () {
      if (joins.length || analise.needRedact || analise.needPostFilter) {
        if (joins.length) {
          processJoins(attributes, joins, result);
          if (postfilter && postfilter !== IGNORE) {
            result.push({$match: postfilter});
          }
        }
        if (redactFilter && redactFilter !== IGNORE) {
          result.push({$redact: {$cond: [redactFilter, '$$KEEP', '$$PRUNE']}});
        }
      }

      if (result.length && resultAttrs.length && options.distinct) {
        Array.prototype.push.apply(result, wind(resultAttrs));
      }

      if (forcedStages.length) {
        for (let i = 0; i < forcedStages.length; i++) {
          if (forcedStages[i] && typeof forcedStages[i] === 'object') {
            result.push(forcedStages[i]);
          }
        }
      }

      if (doGroup || result.length || (fetchFields && forcedStages.length)) {
        Array.prototype.push.apply(result, groupStages);
      }

      if (result.length || options.to) {
        if (options.countTotal || onlyCount) {
          let tmp = {};
          let tmp2 = {__total: '$__total'};
          for (let i = 0; i < resultAttrs.length; i++) {
            tmp[resultAttrs[i]] = '$' + resultAttrs[i];
            tmp2[resultAttrs[i]] = '$data.' + resultAttrs[i];
          }
          result.push({$group: {_id: tmp}});
          if (onlyCount) {
            result.push({$group: {_id: null, __total: {$sum: 1}}});
          } else {
            result.push({$group: {_id: null, __total: {$sum: 1}, data: {$addToSet: '$_id'}}});
            result.push({$unwind: {path: '$data', preserveNullAndEmptyArrays: true}});
            result.push({$project: tmp2});
          }
        }

        if (!onlyCount) {
          if (options.sort) {
            result.push({$sort: options.sort});
          }
        }

        let skip = parseInt(options.offset);
        if (skip) {
          result.push({$skip: skip});
        }

        let limit = parseInt(options.count);
        if (limit) {
          result.push({$limit: limit});
        }
      }

      if (options.to) {
        result.push({$out: options.to});
      }

      if (result.length) {
        return Promise.resolve(result);
      }

      return Promise.resolve(false);
    });
  }

  function mergeGeoJSON(data) {
    var tmp, tmp2, i;
    for (var nm in data) {
      if (data.hasOwnProperty(nm)) {
        tmp = data['__geo__' + nm + '_f'];
        if (tmp) {
          tmp2 = data[nm];
          delete data['__geo__' + nm + '_f'];
          switch (tmp.type) {
            case 'Feature': {
              tmp.geometry = tmp2;
              data[nm] = tmp;
            }
              break;
            case 'FeatureCollection': {
              for (i = 0; i < tmp2.geometries.length; i++) {
                tmp.features[i].geometry = tmp2.geometries[i];
              }
              data[nm] = tmp;
            }
              break;
          }
        }
      }
    }
    return data;
  }

  /**
   * @param {Collection} c
   * @param {{}} options
   * @param {{}} [options.filter]
   * @param {{}} [options.fields]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @param {Boolean} [options.distinct]
   * @param {String[]} [options.select]
   * @param {Object[]} aggregate
   * @param {Function} resolve
   * @param {Function} reject
   */
  function fetch(c, options, aggregate, resolve, reject) {
    let r;
    if (aggregate) {
      r = c.aggregate(aggregate, {cursor: {batchSize: options.batchSize || options.count || 1}, allowDiskUse: true});
    } else {
      if (options.distinct && options.select.length === 1) {
        return c.distinct(options.select[0], options.filter || {}, {}, function (err, data) {
          if (err) {
            return reject(err);
          }
          if (options.sort && options.sort[options.select[0]]) {
            let direction = options.sort[options.select[0]];
            data = data.sort(function compare(a, b) {
              if (a < b) {
                return -1 * direction;
              } else if (a > b) {
                return 1 * direction;
              }
              return 0;
            });
          }
          let res = [];
          let stPos = options.offset || 0;
          let endPos = options.count ? stPos + options.count : data.length;
          for (let i = stPos; i < endPos && i < data.length; i++) {
            let tmp = {};
            tmp[options.select[0]] = data[i];
            res.push(tmp);
          }
          resolve(res, options.countTotal ? data.length || 0 : null);
        });
      } else {
        r = c.find(options.filter || {});
      }

      if (options.sort) {
        r = r.sort(options.sort);
      }
    }

    if (options.offset) {
      r = r.skip(options.offset);
    }

    if (options.count) {
      r = r.limit(options.count);
    }

    r.batchSize(options.batchSize || options.count || 1);

    if (options.countTotal) {
      if (aggregate) {
        r.next(function (err, d) {
          let amount = null;
          if (d && d.__total) {
            amount = d.__total;
          }
          r.rewind();
          resolve(r, amount || 0);
        });
      } else {
        r.count(false, function (err, amount) {
          if (err) {
            r.close();
            return reject(err);
          }
          resolve(r, amount || 0);
        });
      }
    } else {
      resolve(r);
    }
  }

  function copyColl(src, dest) {
    let srcColl;
    return getCollection(src)
      .then((c) => {
        srcColl = c;
        return getCollection(dest);
      })
      .then((c3) => {
        return new Promise((resolve, reject) => {
          srcColl.find().toArray((err, docs) => {
            if (err) {
              return reject(err);
            }
            if (!docs.length) {
              return resolve();
            }
            c3.insertMany(docs, (err2) => err2 ? reject(err2) : resolve());
          });
        });
      })
      .then(() => new Promise((resolve, reject) => _this.db.dropCollection(src, (err) => err ? reject(err) : resolve())));
  }

  /**
   * @param {String} type
   * @param {{}} [options]
   * @param {{}} [options.filter]
   * @param {{}} [options.fields]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Boolean} [options.countTotal]
   * @param {Boolean} [options.distinct]
   * @param {String} [options.to]
   * @param {String} [options.append]
   * @returns {Promise}
   */
  this._fetch = function (type, options) {
    options = clone(options || {});
    let tmpApp = null;
    let c;
    return getCollection(type)
      .then((col) => {
        c = col;
        options.filter = parseCondition(options.filter);
        prepareConditions(options.filter);
        if (options.append) {
          tmpApp = 'tmp_' + cuid();
          options.to = tmpApp;
        }
        return checkAggregation(type, options);
      })
      .then((aggregation) => {
        return new Promise((resolve, reject) => {
          fetch(c, options, aggregation,
            function (r, amount) {
              if (tmpApp) {
                return copyColl(tmpApp, options.append)
                  .then(resolve)
                  .catch(err => reject(wrapError(err, 'fetch', type)));
              }

              return new Promise((resolve, reject) => {
                if (Array.isArray(r)) {
                  resolve(r);
                } else {
                  r.toArray(function (err, docs) {
                    r.close();
                    if (err) {
                      return reject(err);
                    }
                    resolve(docs);
                  });
                }
              }).then((docs) => {
                docs.forEach(mergeGeoJSON);
                if (amount !== null) {
                  docs.total = amount;
                }
                resolve(docs);
              }).catch(reject);
            },
            (e) => {reject(wrapError(e, 'fetch', type));}
          );
        });
      }
    );
  };

  function DsIterator(cursor, amount) {
    this._next = function () {
      return new Promise(function (resolve, reject) {
        cursor.hasNext(function (err, r) {
          if (err) {
            return reject(err);
          }
          if (!r) {
            return resolve(null);
          }
          cursor.next(function (err, r) {
            if (err) {
              return reject(err);
            }
            if (r) {
              return resolve(mergeGeoJSON(r));
            }
            resolve(null);
          });
        });
      });
    };

    this._count = function () {
      return amount;
    };
  }

  DsIterator.prototype = new Iterator();

  /**
   * @param {String} type
   * @param {{}} [options]
   * @param {{}} [options.filter]
   * @param {{}} [options.fields]
   * @param {{}} [options.sort]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Number} [options.batchSize]
   * @returns {Promise}
   */
  this._iterator = function (type, options) {
    options = clone(options) || {};
    var c;
    return getCollection(type).then(
      function (col) {
        c = col;
        options.filter = parseCondition(options.filter);
        prepareConditions(options.filter);
        return checkAggregation(type, options);
      }).then(function (aggregation) {
        return new Promise(function (resolve, reject) {
          try {
            options.batchSize = options.batchSize || 1;
            fetch(c, options, aggregation,
              function (r, amount) {
                resolve(new DsIterator(r, amount));
              },
              function (e) {reject(wrapError(e, 'iterate', type));}
            );
          } catch (err) {
            reject(err);
          }
        });
      }
    );
  };

  /**
   * @param {String} type
   * @param {{expressions: {}}} options
   * @param {{}} [options.filter]
   * @param {{}} [options.fields]
   * @param {{}} [options.aggregates]
   * @param {String} [options.to]
   * @returns {Promise}
   */
  this._aggregate = function (type, options) {
    options = clone(options || {});
    options.filter = parseCondition(options.filter);
    let c;
    let tmpApp = null;
    return getCollection(type)
      .then((col) => {
        c = col;
        let plan = [false];

        if (options.filter) {
          prepareConditions(options.filter);
        }

        if (options.append) {
          tmpApp = 'tmp_' + cuid();
          options.to = tmpApp;
        }
        return checkAggregation(type, options, plan);
      })
      .then((plan) => {
        return new Promise((resolve, reject) => {
          try {
            c.aggregate(plan || [], {allowDiskUse: true}, (err, result) => {
              if (err) {
                return reject(wrapError(err, 'aggregate', type));
              }
              if (tmpApp) {
                copyColl(tmpApp, options.append)
                  .then(resolve)
                  .catch(err => reject(wrapError(err, 'aggregate', type)));
                return;
              }
              resolve(result);
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
  };

  this._count = function (type, options) {
    let c;
    options = clone(options || {});

    return getCollection(type)
      .then((col) => {
        c = col;
        options.filter = parseCondition(options.filter);
        prepareConditions(options.filter);
        return checkAggregation(type, options, [], true);
      })
      .then((agreg) => {
        return new Promise((resolve, reject) => {
          if (agreg) {
            c.aggregate(agreg, (err, result) => {
              if (err) {
                return reject(wrapError(err, 'count', type));
              }
              let cnt = 0;
              if (result.length) {
                cnt = result[0].__total;
              }
              resolve(cnt);
            });
          } else {
            let opts = {};
            if (options.offset) {
              opts.skip = options.offset;
            }
            if (options.count) {
              opts.limit = options.count;
            }
            c.count(options.filter || {}, opts, function (err, cnt) {
              if (err) {
                return reject(wrapError(err, 'count', type));
              }
              resolve(cnt);
            });
          }
        });
      }
    );
  };

  /**
   * @param {String} type
   * @param {{}} conditions
   * @param {{fields: {}}} options
   * @returns {Promise.<{}>}
   * @private
   */
  this._get = function (type, conditions, options) {
    let c;
    let opts = {filter: parseCondition(conditions), fields: options.fields || {}};
    return getCollection(type)
      .then((col) => {
        c = col;
        prepareConditions(opts.filter);
        return checkAggregation(type, opts);
      })
      .then((aggregation) => {
        if (aggregation) {
          return new Promise((resolve, reject) => {
            fetch(c, opts, aggregation,
              (r, amount) => {
                let p;
                if (Array.isArray(r)) {
                  p = Promise.resolve(r);
                } else {
                  p = new Promise((resolve, reject) => {
                    r.toArray(function (err, docs) {
                      r.close();
                      if (err) {
                        return reject(err);
                      }
                      resolve(docs);
                    });
                  });
                }
                p.then((docs) => {
                  docs.forEach(mergeGeoJSON);
                  resolve(docs.length ? docs[0] : null);
                }).catch(reject);
              },
              (e) => {
                reject(wrapError(e, 'get', type));
              }
            );
          });
        } else {
          return new Promise((resolve, reject) => {
            try {
              c.find(opts.filter).limit(1).next((err, result) => {
                if (err) {
                  return reject(wrapError(err, 'get', type));
                }
                resolve(mergeGeoJSON(result));
              });
            } catch (err) {
              throw wrapError(err, 'get', type);
            }
          });
        }
      });
  };

  /**
   * @param {String} type
   * @param {{}} properties
   * @param {{unique: Boolean}} [options]
   * @returns {Promise}
   */
  this._ensureIndex = function (type, properties, options) {
    return getCollection(type).then(
      function (c) {
        return new Promise(function (resolve) {
          c.createIndex(properties, options || {}, function () {
            resolve(c);
          });
        });
      });
  };

  /**
   * @param {String} type
   * @param {{}} properties
   * @returns {Promise}
   */
  this._ensureAutoincrement = function (type, properties) {
    var data = {};
    var steps = {};
    var act = false;
    if (properties) {
      for (var nm in properties) {
        if (properties.hasOwnProperty(nm)) {
          data[nm] = 0;
          steps[nm] = properties[nm];
          act = true;
        }
      }

      if (act) {
        return new Promise(function (resolve, reject) {
          getCollection(AUTOINC_COLLECTION).then(
            function (c) {
              c.findOne({__type: type}, function (err, r) {
                if (err) {
                  return reject(err);
                }

                if (r && r.counters) {
                  for (var nm in r.counters) {
                    if (r.counters.hasOwnProperty(nm) && data.hasOwnProperty(nm)) {
                      data[nm] = r.counters[nm];
                    }
                  }
                }

                c.updateOne(
                  {__type: type},
                  {$set: {counters: data, steps: steps}},
                  {upsert: true},
                  function (err) {
                    if (err) {
                      return reject(err);
                    }
                    resolve();
                  }
                );
              });
            }
          ).catch(e => reject(e));
        });
      }
    }
    return Promise.resolve();
  };
}

// Util.inherits(MongoDs, DataSource); //jscs:ignore requireSpaceAfterLineComment

MongoDs.prototype = new DataSource();

module.exports = MongoDs;
