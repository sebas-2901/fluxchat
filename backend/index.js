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
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Error handler specifically for JSON parsing
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON received:', req.rawBody); // Log the raw body
    return res.status(400).send({ error: 'Invalid JSON syntax' });
  }
  next();
});

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

// Update user (name only)
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  db.run('UPDATE users SET name = ? WHERE id = ?', [name, id], function(err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ id, name });
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
      // Ensure reactions is valid JSON
      const parsedRows = rows.map(r => ({
        ...r,
        reactions: r.reactions ? JSON.parse(r.reactions) : {}
      }));
      res.json(parsedRows);
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
    const { to, content, type = 'text', tempId } = msg;

    // Reject invalid type or large content if needed
    if (type !== 'text' && type !== 'image') return;
    
    // Size limit for base64 images (e.g. 5MB)
    if (content.length > 5 * 1024 * 1024) return;

    const timestamp = Date.now();
    
    db.run(
      'INSERT INTO messages (from_id,to_id,content,timestamp,type,reactions) VALUES (?,?,?,?,?,?)', 
      [socket.userId, to, content, timestamp, type, '{}'],
      function(err) {
        if (err) return console.error(err);
        
        const messageId = this.lastID;
        const out = {
            id: messageId,
            from_id: socket.userId,
            to_id: to,
            content,
            timestamp,
            type,
            reactions: {}
        };

        // Emit to recipient (no tempId needed)
        const recipientSocket = socketsByUser.get(String(to));
        if (recipientSocket) {
            recipientSocket.emit('private_message', out);
        }
        
        // Emit back to sender with tempId to replace optimistic message
        socket.emit('private_message_sent', { ...out, tempId });
      }
    );
  });

  socket.on('reaction', ({ msgId, emoji }) => {
    if (!msgId || !emoji) return;
    
    db.get('SELECT * FROM messages WHERE id = ?', [msgId], (err, row) => {
        if (err || !row) return;

        let reactions = {};
        try { reactions = JSON.parse(row.reactions || '{}'); } catch(e) {}
        
        // Toggle reaction or set it
        if (reactions[socket.userId] === emoji) {
            delete reactions[socket.userId];
        } else {
            reactions[socket.userId] = emoji;
        }
        
        const jsonReactions = JSON.stringify(reactions);
        
        db.run('UPDATE messages SET reactions = ? WHERE id = ?', [jsonReactions, msgId], (errUpdate) => {
            if (errUpdate) return;
            
            // Notify both parties involved in the message conversation
            // We can infer sender/receiver from 'row'
            const user1Socket = socketsByUser.get(String(row.from_id));
            const user2Socket = socketsByUser.get(String(row.to_id));
            
            const eventData = { msgId, reactions };
            
            if (user1Socket) user1Socket.emit('reaction_update', { msgId, reactions });
            if (user2Socket) user2Socket.emit('reaction_update', { msgId, reactions });
        });
    });
  });

  socket.on('disconnect', () => {
    socketsByUser.delete(String(socket.userId));
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('Backend listening on', PORT));
