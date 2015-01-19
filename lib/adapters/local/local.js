'use strict';

var utils = require('../../utils');
var upsert = require('pouchdb-upsert');
var callbackify = utils.callbackify;
var collate = require('pouchdb-collate');

var abstractMapper = require('./abstract-mapper');
var planQuery = require('./query-planner');
var localUtils = require('./local-utils');
//var getKey = localUtils.getKey;
var getValue = localUtils.getValue;
var getSize = localUtils.getSize;

function putIfNotExists(db, doc) {
  return upsert.putIfNotExists.call(db, doc);
}

function massageIndexDef(indexDef) {
  indexDef.fields = indexDef.fields.map(function (field) {
    if (typeof field === 'string') {
      var obj = {};
      obj[field] = 'asc';
      return obj;
    }
    return field;
  });
  return indexDef;
}

function indexToSignature(index) {
  // remove '_design/'
  return index.ddoc.substring(8) + '/' + index.name;
}

function filterInclusiveStart(rows, targetValue) {
  for (var i = 0, len = rows.length; i < len; i++) {
    var row = rows[i];
    if (collate.collate(row.key, targetValue) > 0) {
      if (i > 0) {
        return rows.slice(i);
      } else {
        return rows;
      }
    }
  }
  return rows;
}

function reverseOptions(opts) {
  var newOpts = utils.clone(opts);
  delete newOpts.startkey;
  delete newOpts.endkey;
  delete newOpts.inclusive_start;
  delete newOpts.inclusive_end;

  if ('endkey' in opts) {
    newOpts.startkey = opts.endkey;
  }
  if ('startkey' in opts) {
    newOpts.endkey = opts.startkey;
  }
  if ('inclusive_start' in opts) {
    newOpts.inclusive_end = opts.inclusive_start;
  }
  if ('inclusive_end' in opts) {
    newOpts.inclusive_start = opts.inclusive_end;
  }
  return newOpts;
}

function createIndex(db, requestDef) {

  var originalIndexDef = utils.clone(requestDef.index);
  requestDef.index = massageIndexDef(requestDef.index);

  var md5 = utils.MD5(JSON.stringify(requestDef));

  var views = {};

  var viewName = requestDef.name || ('idx-' + md5);

  views[viewName] = {
    map: {
      fields: utils.mergeObjects(requestDef.index.fields)
    },
    reduce: '_count',
    options: {
      def: originalIndexDef
    }
  };

  return putIfNotExists(db, {
    _id: '_design/idx-' + md5,
    views: views,
    language: 'query'
  }).then(function (res) {
    // kick off a build
    // TODO: abstract-pouchdb-mapreduce should support auto-updating
    var signature = 'idx-' + md5 + '/' + viewName;
    return abstractMapper.query.call(db, signature, {
        limit: 0,
        stale: 'update_after',
        reduce: false
    }).then(function () {
      return {result: res.updated ? 'created' : 'exists'};
    });
  });
}

function find(db, requestDef) {

  if (typeof requestDef.selector !== 'object') {
    throw new Error('you must provide a selector when you find()');
  }

  return getIndexes(db).then(function (getIndexesRes) {

    var queryPlan = planQuery(requestDef.selector, getIndexesRes.indexes);

    var indexToUse = queryPlan.index;
    if (!indexToUse) {
      throw new Error('couldn\'t find any index to use');
    }

    var opts = utils.extend(true, {
      include_docs: true,
      reduce: false
    }, queryPlan.queryOpts);

    if (requestDef.sort && requestDef.sort.length === 1 &&
        getSize(requestDef.sort[0]) === 1 &&
        getValue(requestDef.sort[0]) === 'desc') {
      opts.descending = true;
      opts = reverseOptions(opts);
    }

    console.log(opts);

    return Promise.resolve().then(function () {
      if (indexToUse.name === '_all_docs') {
        return db.allDocs(opts);
      } else {
        var signature = indexToSignature(indexToUse);
        return abstractMapper.query.call(db, signature, opts);
      }
    }).then(function (res) {

      if (opts.inclusive_start === false) {
        // may have to manually filter the first one,
        // since couchdb has no true inclusive_start option
        res.rows = filterInclusiveStart(res.rows, opts.startkey);
      }

      return {
        docs: res.rows.map(function (row) {
          var doc = row.doc;
          if (requestDef.fields) {
            return utils.pick(doc, requestDef.fields);
          }
          return doc;
        })
      };
    });
  });
}

function getIndexes(db) {
  return db.allDocs({
    startkey: '_design/idx-',
    endkey: '_design/idx-\uffff',
    include_docs: true
  }).then(function (allDocsRes) {
    var res = {
      indexes: [{
        ddoc: null,
        name: '_all_docs',
        type: 'special',
        def: {
          fields: [{_id: 'asc'}]
        }
      }]
    };

    res.indexes = utils.flatten(res.indexes, allDocsRes.rows.map(function (row) {
      var viewNames = Object.keys(row.doc.views);

      return viewNames.map(function (viewName) {
        var view = row.doc.views[viewName];
        return {
          ddoc: row.id,
          name: viewName,
          type: 'json',
          def: massageIndexDef(view.options.def)
        };
      });
    }));

    return res;
  });
}

function deleteIndex(db, index) {

  var docId = index.ddoc;

  return db.get(docId).then(function (doc) {
    return db.remove(doc);
  }).then(function () {
    return abstractMapper.viewCleanup.apply(db);
  }).then(function () {
    return {ok: true};
  });
}

exports.createIndex = callbackify(createIndex);
exports.find = callbackify(find);
exports.getIndexes = callbackify(getIndexes);
exports.deleteIndex = callbackify(deleteIndex);