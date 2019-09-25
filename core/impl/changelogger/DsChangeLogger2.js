const clone = require('clone');
const F = require('core/FunctionCodes');

/**
 * @param {table: String, DataSource: dataSource, types: {}} options
 */
module.exports = (options) => {
  const self = this;

  this.logChange = (type, datas) => {
    if (!this.types()[type.toUpperCase()])
      throw new Error('Неверно указан тип записи журнала изменений!');
    const record = this.normalize(datas);
    record.timestamp = new Date();
    record.type = type;
    return options.dataSource.insert(options.table, record);
  };

  this.getChanges = (filters, sort, offset, count, countTotal) => {
    const opts = {
      sort, offset, count, countTotal
    };
    const and = [];
    const recordFilters = clone(filters);
    if (filters.since) {
      and.push({[F.GREATER_OR_EQUAL]: ['$timestamp', filters.since]});
      delete recordFilters.since;
    }
    if (filters.till) {
      and.push({[F.LESS]: ['$timestamp', filters.till]});
      delete recordFilters.till;
    }
    if (filters.type) {
      and.push({[F.EQUAL]: ['$type', filters.type]});
      delete recordFilters.type;
    }
    and.push(...this.filter(recordFilters));
    if (and.length)
      opts.filter = and.length > 1 ? {[F.AND]: and} : and[0];
    return options.dataSource.fetch(options.table, opts).then((changes) => {
      const result = [];
      changes.forEach(ch => result.push(self.record(ch)));
      result.total = changes.total;
      return result;
    });
  };

  this.types = () => options.types;

  this.normalize = datas => clone(datas);

  this.record = rec => rec;

  this.filter = (filters) => {
    let result = [];
    Object.keys(filters).forEach(f => result.push({[F.EQUAL]: [`$${f}`, filters[f]]}));
    return result;
  };
};
