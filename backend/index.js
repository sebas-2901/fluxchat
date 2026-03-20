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
const onlineUsers = new Set();
const lastSeenByUser = new Map();
const MIN_GROUP_MEMBERS = 3;

function getUserSockets(userId) {
  return socketsByUser.get(String(userId)) || new Set();
}

function addUserSocket(userId, socket) {
  const key = String(userId);
  if (!socketsByUser.has(key)) {
    socketsByUser.set(key, new Set());
  }

  const userSockets = socketsByUser.get(key);
  const wasOnline = userSockets.size > 0;
  userSockets.add(socket);

  if (!wasOnline) {
    onlineUsers.add(key);
    return true;
  }

  return false;
}

function removeUserSocket(userId, socket) {
  const key = String(userId);
  const userSockets = socketsByUser.get(key);
  if (!userSockets) return false;

  userSockets.delete(socket);
  if (userSockets.size > 0) return false;

  socketsByUser.delete(key);
  onlineUsers.delete(key);
  return true;
}

function emitPresenceUpdate(userId, isOnline) {
  io.emit('presence_update', {
    userId: Number(userId),
    isOnline,
    lastSeen: isOnline ? null : lastSeenByUser.get(String(userId)) || Date.now()
  });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

function groupRoom(groupId) {
  return `group:${groupId}`;
}

function getGroupMembers(groupId, cb) {
  db.all(
    `SELECT gm.group_id, gm.user_id, gm.role, gm.joined_at, u.name, u.email
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ?
     ORDER BY gm.joined_at ASC`,
    [groupId],
    cb
  );
}

function emitGroupMembersUpdated(groupId) {
  getGroupMembers(groupId, (err, members) => {
    if (err) return;
    io.to(groupRoom(groupId)).emit('group_members_updated', { groupId, members });
  });
}

function isGroupAdmin(groupId, userId, cb) {
  db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId],
    (err, row) => {
      if (err || !row) return cb(false);
      cb(row.role === 'admin');
    }
  );
}

// List groups for authenticated user
app.get('/api/groups', requireAuth, (req, res) => {
  db.all(
    `SELECT g.id, g.name, g.created_by, g.created_at,
            gm.role AS my_role,
            (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count
     FROM chat_groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ?
     ORDER BY g.created_at DESC`,
    [req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'db' });
      res.json(rows);
    }
  );
});

// Create group. Creator is admin by default.
app.post('/api/groups', requireAuth, (req, res) => {
  const { name, memberIds = [] } = req.body;
  if (!name || !Array.isArray(memberIds)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const normalizedMemberIds = [...new Set(memberIds.map(Number).filter(Boolean))].filter(
    (id) => id !== req.userId
  );
  const allMemberIds = [req.userId, ...normalizedMemberIds];

  if (allMemberIds.length < MIN_GROUP_MEMBERS) {
    return res.status(400).json({ error: 'min_members', min: MIN_GROUP_MEMBERS });
  }

  const placeholders = allMemberIds.map(() => '?').join(',');
  db.all(
    `SELECT id FROM users WHERE id IN (${placeholders})`,
    allMemberIds,
    (usersErr, usersRows) => {
      if (usersErr) return res.status(500).json({ error: 'db' });
      if (!usersRows || usersRows.length !== allMemberIds.length) {
        return res.status(400).json({ error: 'invalid_users' });
      }

      const createdAt = Date.now();
      db.run(
        'INSERT INTO chat_groups (name, created_by, created_at) VALUES (?,?,?)',
        [String(name).trim(), req.userId, createdAt],
        function (groupErr) {
          if (groupErr) return res.status(500).json({ error: 'db' });
          const groupId = this.lastID;

          db.run(
            'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
            [groupId, req.userId, 'admin', createdAt],
            (ownerErr) => {
              if (ownerErr) return res.status(500).json({ error: 'db' });

              if (normalizedMemberIds.length === 0) {
                return res.json({ id: groupId, name, created_by: req.userId, created_at: createdAt });
              }

              let pending = normalizedMemberIds.length;
              let hasInsertError = false;
              normalizedMemberIds.forEach((memberId) => {
                db.run(
                  'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
                  [groupId, memberId, 'member', createdAt],
                  (memberErr) => {
                    if (hasInsertError) return;
                    if (memberErr) {
                      hasInsertError = true;
                      return res.status(500).json({ error: 'db' });
                    }
                    pending -= 1;
                    if (pending === 0) {
                      normalizedMemberIds.forEach((memberIdToJoin) => {
                        getUserSockets(memberIdToJoin).forEach((memberSocket) => {
                          memberSocket.join(groupRoom(groupId));
                        });
                      });
                      getUserSockets(req.userId).forEach((ownerSocket) => {
                        ownerSocket.join(groupRoom(groupId));
                      });

                      io.to(groupRoom(groupId)).emit('group_updated', { groupId });
                      emitGroupMembersUpdated(groupId);

                      return res.json({ id: groupId, name, created_by: req.userId, created_at: createdAt });
                    }
                  }
                );
              });
            }
          );
        }
      );
    }
  );
});

// Get group members (only group members can view)
app.get('/api/groups/:groupId/members', requireAuth, (req, res) => {
  const { groupId } = req.params;
  db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, req.userId],
    (memberErr, memberRow) => {
      if (memberErr) return res.status(500).json({ error: 'db' });
      if (!memberRow) return res.status(403).json({ error: 'forbidden' });

      getGroupMembers(groupId, (err, rows) => {
        if (err) return res.status(500).json({ error: 'db' });
        res.json(rows);
      });
    }
  );
});

// Get group messages (only group members can view)
app.get('/api/groups/:groupId/messages', requireAuth, (req, res) => {
  const { groupId } = req.params;
  db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, req.userId],
    (memberErr, memberRow) => {
      if (memberErr) return res.status(500).json({ error: 'db' });
      if (!memberRow) return res.status(403).json({ error: 'forbidden' });

      db.all(
        `SELECT gm.*, u.name AS from_name
         FROM group_messages gm
         JOIN users u ON u.id = gm.from_id
         WHERE gm.group_id = ?
         ORDER BY gm.timestamp ASC`,
        [groupId],
        (err, rows) => {
          if (err) return res.status(500).json({ error: 'db' });
          const parsedRows = rows.map((r) => ({
            ...r,
            reactions: r.reactions ? JSON.parse(r.reactions) : {}
          }));
          res.json(parsedRows);
        }
      );
    }
  );
});

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
  const justConnected = addUserSocket(socket.userId, socket);

  socket.emit('presence_snapshot', {
    onlineUserIds: Array.from(onlineUsers).map((id) => Number(id)),
    lastSeenByUser: Object.fromEntries(Array.from(lastSeenByUser.entries()))
  });

  if (justConnected) {
    emitPresenceUpdate(socket.userId, true);
  }

  db.all('SELECT group_id FROM group_members WHERE user_id = ?', [socket.userId], (groupsErr, groupRows) => {
    if (groupsErr || !groupRows) return;
    groupRows.forEach((row) => {
      socket.join(groupRoom(row.group_id));
    });
  });

  socket.on('private_message', (msg) => {
    const { to, content, type = 'text', tempId } = msg;

    // Reject invalid type or large content if needed
    if (type !== 'text' && type !== 'image') return;
    
    // Size limit for base64 images (e.g. 5MB)
    if (content.length > 5 * 1024 * 1024) return;

    const timestamp = Date.now();
    
    db.run(
      'INSERT INTO messages (from_id,to_id,content,timestamp,type,reactions,read_at) VALUES (?,?,?,?,?,?,?)', 
      [socket.userId, to, content, timestamp, type, '{}', null],
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
          reactions: {},
          read_at: null
        };

        // Emit to recipient (no tempId needed)
        const recipientSockets = getUserSockets(to);
        recipientSockets.forEach((recipientSocket) => {
          recipientSocket.emit('private_message', out);
        });
        
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
            const user1Sockets = getUserSockets(row.from_id);
            const user2Sockets = getUserSockets(row.to_id);

            user1Sockets.forEach((userSocket) => userSocket.emit('reaction_update', { msgId, reactions }));
            user2Sockets.forEach((userSocket) => userSocket.emit('reaction_update', { msgId, reactions }));
        });
    });
  });

  socket.on('typing_private', ({ to, isTyping }) => {
    if (!to) return;
    const recipientSockets = getUserSockets(to);
    recipientSockets.forEach((recipientSocket) => {
      recipientSocket.emit('typing_private', { from: socket.userId, isTyping: !!isTyping });
    });
  });

  socket.on('mark_read', ({ withUserId }, ack) => {
    if (!withUserId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }

    db.all(
      'SELECT id FROM messages WHERE from_id = ? AND to_id = ? AND read_at IS NULL',
      [withUserId, socket.userId],
      (selectErr, rows) => {
        if (selectErr) {
          if (typeof ack === 'function') ack({ ok: false, error: 'db' });
          return;
        }

        const messageIds = (rows || []).map((row) => row.id);
        if (messageIds.length === 0) {
          if (typeof ack === 'function') ack({ ok: true, updated: 0 });
          return;
        }

        const readAt = Date.now();
        const placeholders = messageIds.map(() => '?').join(',');
        db.run(
          `UPDATE messages SET read_at = ? WHERE id IN (${placeholders})`,
          [readAt, ...messageIds],
          (updateErr) => {
            if (updateErr) {
              if (typeof ack === 'function') ack({ ok: false, error: 'db' });
              return;
            }

            const payload = {
              readerId: socket.userId,
              senderId: Number(withUserId),
              messageIds,
              readAt
            };

            socket.emit('messages_read', payload);
            const senderSockets = getUserSockets(withUserId);
            senderSockets.forEach((senderSocket) => {
              senderSocket.emit('messages_read', payload);
            });

            if (typeof ack === 'function') ack({ ok: true, updated: messageIds.length, readAt });
          }
        );
      }
    );
  });

  socket.on('group_message', (msg, ack) => {
    const { groupId, content, type = 'text', tempId } = msg || {};
    if (!groupId || !content) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }
    if (type !== 'text' && type !== 'image') {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_type' });
      return;
    }
    if (String(content).length > 5 * 1024 * 1024) {
      if (typeof ack === 'function') ack({ ok: false, error: 'too_large' });
      return;
    }

    db.get(
      'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, socket.userId],
      (memberErr, memberRow) => {
        if (memberErr || !memberRow) {
          if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
          return;
        }

        const timestamp = Date.now();
        db.run(
          'INSERT INTO group_messages (group_id, from_id, content, timestamp, type, reactions) VALUES (?,?,?,?,?,?)',
          [groupId, socket.userId, content, timestamp, type, '{}'],
          function (insertErr) {
            if (insertErr) {
              if (typeof ack === 'function') ack({ ok: false, error: 'db' });
              return;
            }

            db.get('SELECT name FROM users WHERE id = ?', [socket.userId], (nameErr, userRow) => {
              if (nameErr || !userRow) {
                if (typeof ack === 'function') ack({ ok: false, error: 'db' });
                return;
              }

              const out = {
                id: this.lastID,
                group_id: Number(groupId),
                from_id: socket.userId,
                from_name: userRow.name,
                content,
                timestamp,
                type,
                reactions: {}
              };

              socket.emit('group_message_sent', { ...out, tempId });
              socket.to(groupRoom(groupId)).emit('group_message', out);
              if (typeof ack === 'function') ack({ ok: true });
            });
          }
        );
      }
    );
  });

  socket.on('group_add_member', ({ groupId, userId }, ack) => {
    if (!groupId || !userId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }

    isGroupAdmin(groupId, socket.userId, (admin) => {
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }

      db.get('SELECT id FROM users WHERE id = ?', [userId], (userErr, userRow) => {
        if (userErr || !userRow) {
          if (typeof ack === 'function') ack({ ok: false, error: 'invalid_user' });
          return;
        }

        db.get(
          'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          (existsErr, existsRow) => {
            if (existsErr) {
              if (typeof ack === 'function') ack({ ok: false, error: 'db' });
              return;
            }
            if (existsRow) {
              if (typeof ack === 'function') ack({ ok: false, error: 'already_member' });
              return;
            }

            db.run(
              'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
              [groupId, userId, 'member', Date.now()],
              (insertErr) => {
                if (insertErr) {
                  if (typeof ack === 'function') ack({ ok: false, error: 'db' });
                  return;
                }

                getUserSockets(userId).forEach((newMemberSocket) => {
                  newMemberSocket.join(groupRoom(groupId));
                });

                io.to(groupRoom(groupId)).emit('group_updated', { groupId });
                emitGroupMembersUpdated(groupId);
                if (typeof ack === 'function') ack({ ok: true });
              }
            );
          }
        );
      });
    });
  });

  socket.on('group_remove_member', ({ groupId, userId }, ack) => {
    if (!groupId || !userId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }

    isGroupAdmin(groupId, socket.userId, (admin) => {
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }

      db.get('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?', [groupId], (countErr, row) => {
        if (countErr || !row) {
          if (typeof ack === 'function') ack({ ok: false, error: 'db' });
          return;
        }
        if (row.count <= MIN_GROUP_MEMBERS) {
          if (typeof ack === 'function') ack({ ok: false, error: 'min_members', min: MIN_GROUP_MEMBERS });
          return;
        }

        db.run(
          'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, userId],
          function (deleteErr) {
            if (deleteErr) {
              if (typeof ack === 'function') ack({ ok: false, error: 'db' });
              return;
            }
            if (this.changes === 0) {
              if (typeof ack === 'function') ack({ ok: false, error: 'not_member' });
              return;
            }

            getUserSockets(userId).forEach((removedSocket) => {
              removedSocket.leave(groupRoom(groupId));
              removedSocket.emit('group_removed', { groupId });
            });

            io.to(groupRoom(groupId)).emit('group_updated', { groupId });
            emitGroupMembersUpdated(groupId);
            if (typeof ack === 'function') ack({ ok: true });
          }
        );
      });
    });
  });

  socket.on('group_set_admin', ({ groupId, userId, isAdmin }, ack) => {
    if (!groupId || !userId || typeof isAdmin !== 'boolean') {
      if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
      return;
    }

    isGroupAdmin(groupId, socket.userId, (admin) => {
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }

      db.run(
        'UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?',
        [isAdmin ? 'admin' : 'member', groupId, userId],
        function (updateErr) {
          if (updateErr) {
            if (typeof ack === 'function') ack({ ok: false, error: 'db' });
            return;
          }
          if (this.changes === 0) {
            if (typeof ack === 'function') ack({ ok: false, error: 'not_member' });
            return;
          }

          io.to(groupRoom(groupId)).emit('group_updated', { groupId });
          emitGroupMembersUpdated(groupId);
          if (typeof ack === 'function') ack({ ok: true });
        }
      );
    });
  });

  socket.on('disconnect', () => {
    const wentOffline = removeUserSocket(socket.userId, socket);
    if (wentOffline) {
      lastSeenByUser.set(String(socket.userId), Date.now());
      emitPresenceUpdate(socket.userId, false);
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('Backend listening on', PORT));
