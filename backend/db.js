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
  )`, (err) => {
    if (!err) {
      // Attempt to add new columns for existing databases
      try {
        db.run(`ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'`, () => {});
        db.run(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`, () => {});
        db.run(`ALTER TABLE messages ADD COLUMN read_at INTEGER`, () => {});
      } catch (e) {
        // Find a way to handle this gracefully if columns exist (SQLite throws error but we can ignore duplicate column error here)
      }
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(created_by) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY(group_id) REFERENCES chat_groups(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    from_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    reactions TEXT DEFAULT '{}',
    FOREIGN KEY(group_id) REFERENCES chat_groups(id),
    FOREIGN KEY(from_id) REFERENCES users(id)
  )`);
});

module.exports = db;
