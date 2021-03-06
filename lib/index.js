var debug_log = require('debug')('express-mysql-session:log')
var debug_error = require('debug')('express-mysql-session:error')
var MySQLConnectionManager = require('mysql-connection-manager')
var mysql = require('mysql');
var session = require('express-session')

var retryInProgress = false;
var defaultOptions = {
  checkExpirationInterval: 900000,// How frequently expired sessions will be cleared; milliseconds.
  expiration: 86400000,// The maximum age of a valid session; milliseconds.
  autoReconnect: true,// Whether or not to re-establish a database connection after a disconnect.
  reconnectDelay: [
    500,// Time between each attempt in the first group of reconnection attempts; milliseconds.
    1000,// Time between each attempt in the second group of reconnection attempts; milliseconds.
    5000,// Time between each attempt in the third group of reconnection attempts; milliseconds.
    30000,// Time between each attempt in the fourth group of reconnection attempts; milliseconds.
    300000// Time between each attempt in the fifth group of reconnection attempts; milliseconds.
  ],
  reconnectDelayGroupSize: 5,// Number of reconnection attempts per reconnect delay value.
  maxReconnectAttempts: 25,// Maximum number of reconnection attempts. Set to 0 for unlimited.
  useConnectionPooling: false,// Whether or not to use connection pooling.
  keepAlive: true,// Whether or not to send keep-alive pings on the database connection.
  keepAliveInterval: 30000,// How frequently keep-alive pings will be sent; milliseconds.
  createDatabaseTable: true,// Whether or not to create the sessions database table, if one does not already exist.
}
var sessionStoreInstance = null;
var SessionStore = module.exports = function (options, connection, cb) {
  sessionStoreInstance = that = this;
  debug_log('Creating session store')

  this.options = options || {}

  this.setDefaultOptions()

  if (this.options.debug) {
    console.warn('The \'debug\' option has been removed.')
    console.warn('This module now uses the debug module to output logs and error messages.')
    console.warn('Run your app with `DEBUG=express-mysql-session* node your-app.js` to have all logs and errors outputted to the console.')
  }

  if (typeof connection == 'function') {
    cb = connection
    connection = null
  }

  if (this.options.dbClusterConnection && !connection && !retryInProgress) {
    retryInProgress = true;
    startClusterReconnectionLoop(that, options, cb);
    return;
  }

  this.manager = new MySQLConnectionManager(options, connection || null)

  this.connection = this.manager.connection

  if (!this.manager.connection || this.manager.connection.state === 'disconnected') {
    cb(new Error('Connection failed, retrying...'));
    startReconnectionLoop(this, options, connection);
    return;
  }

  if (!this.options.createDatabaseTable)
    return cb && cb()

  this.createDatabaseTable(cb)

}

function startClusterReconnectionLoop(obj, options, cb){
  var clusterConfig = {
    removeNodeErrorCount: 1, // Remove the node immediately when connection fails.
    defaultSelector: 'ORDER'
  };
  var pool = mysql.createPoolCluster(clusterConfig);
  for (var i = 0; i < options.dbClusterConnection.length; i++) {
    var nodeConfig = {
      host: options.dbClusterConnection[i].host,
      user: options.dbClusterConnection[i].username,
      password: options.dbClusterConnection[i].password,
      database: options.dbClusterConnection[i].dbName
    };
  }

  pool.add(nodeConfig);

  pool.getConnection(function (err, connection) {
    obj.manager = new MySQLConnectionManager(options, connection || null);
    obj.connection = obj.manager.connection;

    if (err) {
      cb(new Error('Connection failed, retrying...'));
      console.error('connection failed, starting retrying loop');
      setTimeout(function(){
        console.info('timeout reached, retying...');
        startClusterReconnectionLoop(obj, options, cb);
      }, 2000);
      return;
    }
    console.info('connection successful');
    retryInProgress = false;
    if (!obj.options.createDatabaseTable)
      return cb && cb();

    obj.createDatabaseTable(cb);
  });
}
function startReconnectionLoop(obj, options, connection){
  console.log('starting reconnection loop');
  setTimeout(function(){
    console.log('timeout, trying to reconnect');
    obj.manager = new MySQLConnectionManager(options, connection || null);
    if (!obj.manager.connection || obj.manager.connection.state === 'disconnected'){
      console.log('connection failed, retrying...');
      startReconnectionLoop(obj, options, connection);
      return;
    }
    console.log('connection success!');
  },2000);
}

SessionStore.prototype = new session.Store()
SessionStore.prototype.constructor = SessionStore

SessionStore.prototype.setDefaultOptions = function () {

  debug_log('Setting default options')

  for (var name in defaultOptions)
    if (typeof this.options[name] == 'undefined')
      this.options[name] = defaultOptions[name]

}

SessionStore.prototype.createDatabaseTable = function (cb) {

  debug_log('Creating sessions database table')

  var fs = require('fs')
  var self = this

  fs.readFile(__dirname + '/../schema.sql', 'utf-8', function (error, sql) {

    self.connection.query(sql, function (error) {

      if (error) {
        if (self.options.debug) {
          debug_error('Failed to create sessions database table.')
          debug_error(error)
        }

        return cb && cb(error)
      }

      self.setExpirationInterval()

      cb && cb()

    })

  })

}

// For backwards compatibility.
SessionStore.prototype.sync = function () {

  console.warn('The sync() method has been deprecated. Use createDatabaseTable() instead.')

  this.createDatabaseTable.apply(this, arguments)

}

SessionStore.prototype.get = function (session_id, cb) {
  var that  = this;
  debug_log('Getting session: ' + session_id)

  var sql = 'SELECT `data` FROM `sessions` WHERE `session_id` = ? LIMIT 1'
  var params = [session_id]

  if (that.options.dbClusterConnection && !this.connection && !retryInProgress){
    retryInProgress = true;
    startClusterReconnectionLoop(that, that.options, cb);
  }
  this.connection.query(sql, params, function (error, rows) {

    if (error) {
      if (that.options.dbClusterConnection && !retryInProgress){
        retryInProgress = true;
        startClusterReconnectionLoop(that, that.options, cb);
      }
      return cb(error, null);
    }

    var session = !!rows[0] ? JSON.parse(rows[0].data) : null

    cb(null, session)

  })

}

SessionStore.prototype.set = function (session_id, data, cb) {

  debug_log('Setting session: ' + session_id)

  var sql = 'REPLACE INTO `sessions` SET ?'

  var expires

  if (data.cookie && data.cookie.expires)
    expires = data.cookie.expires
  else
    expires = new Date(Date.now() + this.options.expiration)

  // Use whole seconds here; not milliseconds.
  expires = Math.round(expires.getTime() / 1000)

  var dataStr = JSON.stringify(data)

  debug_log('Data: ' + dataStr)

  var params = {
    session_id: session_id,
    expires: expires,
    data: dataStr
  }

  var self = this

  this.connection.query(sql, params, function (error) {

    if (error)
      return cb && cb(error)

    cb && cb()

  })

}

SessionStore.prototype.destroy = function (session_id, cb) {

  debug_log('Destroying session: ' + session_id)

  var sql = 'DELETE FROM `sessions` WHERE `session_id` = ? LIMIT 1'
  var params = [session_id]

  var self = this

  this.connection.query(sql, params, function (error) {

    if (error) {
      if (self.options.debug) {
        debug_error('Failed to destroy session.')
        debug_error(error)
      }

      return cb && cb(error)
    }

    cb && cb()

  })

}

SessionStore.prototype.length = function (cb) {

  debug_log('Getting number of sessions')

  var sql = 'SELECT COUNT(*) FROM `sessions`'

  var self = this

  this.connection.query(sql, function (error, rows) {

    if (error) {
      if (self.options.debug) {
        debug_error('Failed to get number of sessions.')
        debug_error(error)
      }

      return cb && cb(error)
    }

    var count = !!rows[0] ? rows[0]['COUNT(*)'] : 0

    cb(null, count)

  })

}

SessionStore.prototype.clear = function (cb) {

  debug_log('Clearing all sessions')

  var sql = 'DELETE FROM `sessions`'

  this.connection.query(sql, function (error) {

    if (error)
      return cb && cb(error)

    cb && cb()

  })

}

SessionStore.prototype.clearExpiredSessions = function (cb) {

  debug_log('Clearing expired sessions')

  var sql = 'DELETE FROM `sessions` WHERE `expires` < ?'
  var params = [Math.round(Date.now() / 1000)]

  var self = this

  this.connection.query(sql, params, function (error) {

    if (error) {
      if (self.options.debug) {
        debug_error('Failed to clear expired sessions.')
        debug_error(error)
      }

      return cb && cb(error)
    }

    cb && cb()

  })

}

SessionStore.prototype.setExpirationInterval = function (interval) {

  debug_log('Setting expiration interval: ' + interval + 'ms')

  this.clearExpirationInterval()

  var self = this

  this._expirationInterval = setInterval(function () {

    self.clearExpiredSessions()

  }, interval || this.options.checkExpirationInterval)

}

SessionStore.prototype.clearExpirationInterval = function () {

  debug_log('Clearing expiration interval')

  clearInterval(this._expirationInterval)

}

SessionStore.prototype.closeStore = function (cb) {

  debug_log('Closing session store')

  this.clearExpirationInterval()

  if (this.manager)
    this.manager.endConnection(cb)

}
