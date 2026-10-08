// _common/db.js - 云数据库集合句柄（惰性初始化，兼容服务号/小程序不同入口）
const cloud = require('wx-server-sdk');
const { DB_COLLECTIONS } = require('./consts');

let _db = null;
let _cmd = null;

function ensureDb() {
  if (!_db) {
    try {
      _db = cloud.database({ env: cloud.DYNAMIC_CURRENT_ENV });
    } catch (e) {
      _db = cloud.database();
    }
    _cmd = _db.command;
  }
  return _db;
}

function db() {
  return ensureDb();
}

function col(name) {
  return ensureDb().collection(name);
}

function cmd() {
  ensureDb();
  return _cmd;
}

module.exports = {
  db,
  col,
  cmd: cmd,
  COLL: {
    users: () => col(DB_COLLECTIONS.users),
    copywritings: () => col(DB_COLLECTIONS.copywritings),
    tasks: () => col(DB_COLLECTIONS.tasks),
    orders: () => col(DB_COLLECTIONS.orders),
    creditLogs: () => col(DB_COLLECTIONS.creditLogs),
    events: () => col(DB_COLLECTIONS.events),
    config: () => col(DB_COLLECTIONS.config),
  },
};
