'use strict';

var stringify = require('json-stringify-safe');
var parsers = require('./parsers');
var zlib = require('zlib');
var utils = require('./utils');
var uuid = require('node-uuid');
var transports = require('./transports');
var nodeUtil = require('util'); // nodeUtil to avoid confusion with "utils"
var events = require('events');
var domain = require('domain');

module.exports.version = require('../package.json').version;

var extend = utils.extend;

var Client = function Client(dsn, options) {
  if (arguments.length === 0) {
    // no arguments, use default from environment
    dsn = process.env.SENTRY_DSN;
    options = {};
  }
  if (typeof dsn === 'object') {
    // They must only be passing through options
    options = dsn;
    dsn = process.env.SENTRY_DSN;
  }
  options = options || {};

  this.raw_dsn = dsn;
  this.dsn = utils.parseDSN(dsn);
  this.name = options.name || process.env.SENTRY_NAME || require('os').hostname();
  this.root = options.root || process.cwd();
  this.transport = options.transport || transports[this.dsn.protocol];
  this.release = options.release || process.env.SENTRY_RELEASE || '';
  this.environment = options.environment || process.env.SENTRY_ENVIRONMENT || '';

  this.loggerName = options.logger || '';
  this.dataCallback = options.dataCallback;

  if (this.dsn.protocol === 'https') {
    // In case we want to provide our own SSL certificates / keys
    this.ca = options.ca || null;
  }

  // enabled if a dsn is set
  this._enabled = !!this.dsn;

  var globalContext = this._globalContext = {};
  if (options.tags) {
    globalContext.tags = options.tags;
  }
  if (options.extra) {
    globalContext.extra = options.extra;
  }

  this.on('error', function (e) {}); // noop
};
nodeUtil.inherits(Client, events.EventEmitter);
var proto = Client.prototype;

module.exports.Client = Client;

module.exports.config = function (dsn, options) {
  return new Client(dsn, options);
};

proto.getIdent =
  proto.get_ident = function getIdent(result) {
    return result.id;
  };

proto.process = function process(kwargs) {
  kwargs.modules = utils.getModules();
  kwargs.server_name = kwargs.server_name || this.name;

  if (typeof process.version !== 'undefined') {
    kwargs.extra.node = process.version;
  }

  kwargs.environment = kwargs.environment || this.environment;
  kwargs.extra = extend({}, this._globalContext.extra, kwargs.extra);
  kwargs.tags = extend({}, this._globalContext.tags, kwargs.tags);

  kwargs.logger = kwargs.logger || this.loggerName;
  kwargs.event_id = uuid().replace(/-/g, '');
  kwargs.timestamp = new Date().toISOString().split('.')[0];
  kwargs.project = this.dsn.project_id;
  kwargs.platform = 'node';

  if (this._globalContext.user) {
    kwargs.user = this._globalContext.user || kwargs.user;
  }

  // Only include release information if it is set
  if (this.release) {
    kwargs.release = this.release;
  }

  var ident = {
    id: kwargs.event_id
  };

  if (this.dataCallback) {
    kwargs = this.dataCallback(kwargs);
  }

  // this will happen asynchronously. We don't care about its response.
  this._enabled && this.send(kwargs, ident);

  return ident;
};

proto.send = function send(kwargs, ident) {
  var self = this;

  var skwargs = stringify(kwargs);

  zlib.deflate(skwargs, function (err, buff) {
    var message = buff.toString('base64'),
        timestamp = new Date().getTime(),
        headers = {
          'X-Sentry-Auth': utils.getAuthHeader(timestamp, self.dsn.public_key, self.dsn.private_key),
          'Content-Type': 'application/octet-stream',
          'Content-Length': message.length
        };

    self.transport.send(self, message, headers, ident);
  });
};

proto.captureMessage = function captureMessage(message, kwargs, cb) {
  if (!cb && typeof kwargs === 'function') {
    cb = kwargs;
    kwargs = {};
  } else {
    kwargs = kwargs || {};
  }
  var result = this.process(parsers.parseText(message, kwargs));
  cb && cb(result);
  return result;
};

proto.captureException = function captureError(err, kwargs, cb) {
  if (!(err instanceof Error)) {
    // This handles when someone does:
    //   throw "something awesome";
    // We synthesize an Error here so we can extract a (rough) stack trace.
    err = new Error(err);
  }

  var self = this;
  if (!cb && typeof kwargs === 'function') {
    cb = kwargs;
    kwargs = {};
  } else {
    kwargs = kwargs || {};
  }
  parsers.parseError(err, kwargs, function (kw) {
    var result = self.process(kw);
    cb && cb(result);
  });
};
proto.captureError = proto.captureException; // legacy alias

proto.captureQuery = function captureQuery(query, engine, kwargs, cb) {
  if (!cb && typeof kwargs === 'function') {
    cb = kwargs;
    kwargs = {};
  } else {
    kwargs = kwargs || {};
  }
  var result = this.process(parsers.parseQuery(query, engine, kwargs));
  cb && cb(result);
  return result;
};

/* The onErr param here is sort of ugly and won't typically be used
 * but it lets us write the requestHandler middleware in terms of this function.
 * We could consider getting rid of it and just duplicating the domain
 * instantiation etc logic in the requestHandler middleware
 */
proto.context = function (ctx, cb, onErr) {
  if (!cb && typeof ctx === 'function') {
    cb = ctx;
    ctx = {};
  }
  var self = this;
  var ctxDomain = domain.create();
  ctxDomain.sentryContext = ctx;
  if (typeof onErr !== 'function') {
    onErr = function (err) {
      self.captureError(err, ctxDomain.sentryContext, function (results) {
        // sup, not really much to do here; maybe emit events from client?
      });
    };
  }
  ctxDomain.on('error', onErr);

  // should we nextTick this? need to determine whether it makes any difference
  process.nextTick(function () {
    ctxDomain.run(cb);
  });
  return ctxDomain;
};

/*
 * Set/clear a user to be sent along with the payload.
 *
 * @param {object} user An object representing user data [optional]
 * @return {Raven}
 */
proto.setUserContext = function setUserContext(user) {
  if (domain.active && domain.active.sentryContext) {
    domain.active.sentryContext.user = user;
  } else {
    this._globalContext.user = user;
  }
  return this;
};

/*
 * Merge extra attributes to be sent along with the payload.
 *
 * @param {object} extra An object representing extra data [optional]
 * @return {Raven}
 */
proto.setExtraContext = function setExtraContext(extra) {
  if (domain.active && domain.active.sentryContext) {
    domain.active.sentryContext.extra = extend({}, domain.active.sentryContext.extra, extra);
  } else {
    this._globalContext.extra = extend({}, this._globalContext.extra, extra);
  }
  return this;
};

/*
 * Merge tags to be sent along with the payload.
 *
 * @param {object} tags An object representing tags [optional]
 * @return {Raven}
 */
proto.setTagsContext = function setTagsContext(tags) {
  if (domain.active && domain.active.sentryContext) {
    domain.active.sentryContext.tags = extend({}, domain.active.sentryContext.tags, tags);
  } else {
    this._globalContext.tags = extend({}, this._globalContext.tags, tags);
  }
  return this;
};

proto.install = proto.patchGlobal = function patchGlobal(cb) {
  module.exports.patchGlobal(this, cb);
  return this;
};

module.exports.patchGlobal = function patchGlobal(client, cb) {
  // handle when the first argument is the callback, with no client specified
  if (typeof client === 'function') {
    cb = client;
    client = new Client();
    // first argument is a string DSN
  } else if (typeof client === 'string') {
    client = new Client(client);
  }
  // at the end, if we still don't have a Client, let's make one!
  !(client instanceof Client) && (client = new Client());

  var called = false;
  process.on('uncaughtException', function (err) {
    if (cb) { // bind event listeners only if a callback was supplied
      var onLogged = function onLogged() {
        called = false;
        cb(true, err);
      };

      var onError = function onError() {
        called = false;
        cb(false, err);
      };

      if (called) {
        client.removeListener('logged', onLogged);
        client.removeListener('error', onError);
        return cb(false, err);
      }

      client.once('logged', onLogged);
      client.once('error', onError);
    }

    called = true;

    return client.captureError(err, function (result) {
      nodeUtil.log('uncaughtException: ' + client.getIdent(result));
    });
  });
};