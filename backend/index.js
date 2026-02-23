const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const SECRET = 'dev_secret_change_this';

const app = express();
app.use(cors());
app.use(express.json());

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'missing' });
  const hash = await bcrypt.hash(password, 10);
  db.run(
    'INSERT INTO users (name,email,password) VALUES (?,?,?)',
    [name, email, hash],
    function (err) {
      if (err) return res.status(400).json({ error: 'exists' });
      const id = this.lastID;
      const token = jwt.sign({ id }, SECRET);
      res.json({ id, name, email, token });
    }
  );
});

// Login (or create if not exists)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing' });
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) return res.status(500).json({ error: 'db' });
    if (!row) return res.status(404).json({ error: 'not_found' });
    const ok = await bcrypt.compare(password, row.password);
    if (!ok) return res.status(401).json({ error: 'invalid' });
    const token = jwt.sign({ id: row.id }, SECRET);
    res.json({ id: row.id, name: row.name, email: row.email, token });
  });
});

// List users
app.get('/api/users', (req, res) => {
  db.all('SELECT id, name, email FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'db' });
    res.json(rows);
  });
});

// Get messages between current user and other
app.get('/api/messages/:userA/:userB', (req, res) => {
  const { userA, userB } = req.params;
  db.all(
    `SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY timestamp ASC`,
    [userA, userB, userB, userA],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db' });
      res.json(rows);
    }
  );
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const socketsByUser = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('auth error'));
  try {
    const payload = jwt.verify(token, SECRET);
    socket.userId = payload.id;
    next();
  } catch (e) {
    next(new Error('auth error'));
  }
});

io.on('connection', (socket) => {
  socketsByUser.set(String(socket.userId), socket);
  socket.on('private_message', (msg) => {
    const { to, content } = msg;
    const timestamp = Date.now();
    db.run('INSERT INTO messages (from_id,to_id,content,timestamp) VALUES (?,?,?,?)', [
      socket.userId,
      to,
      content,
      timestamp,
    ]);

    const out = {
      from_id: socket.userId,
      to_id: to,
      content,
      timestamp,
    };

    // emit to recipient if online
    const sock = socketsByUser.get(String(to));
    if (sock) sock.emit('private_message', out);
    // also emit back to sender to confirm
    socket.emit('private_message', out);
  });

  socket.on('disconnect', () => {
    socketsByUser.delete(String(socket.userId));
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('Backend listening on', PORT));
