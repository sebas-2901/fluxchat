const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`);
});

module.exports = db;
