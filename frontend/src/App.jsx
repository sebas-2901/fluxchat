import { useState, useEffect, useRef } from 'react'
import io from 'socket.io-client'
import EmojiPicker from 'emoji-picker-react'

function CustomAlert({ type, message, onClose }) {
  if (!message) return null
  const isSuccess = type === 'success'

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4 transform transition-all scale-100 animate-slide-up">
        <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl ${isSuccess ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
          <i className={`fa-solid ${isSuccess ? 'fa-check' : 'fa-xmark'}`}></i>
        </div>
        <h3 className="text-xl font-bold text-center mb-2 text-white">{isSuccess ? 'Exito!' : 'Oops...'}</h3>
        <p className="text-center text-slate-400 mb-6">{message}</p>
        <button
          onClick={onClose}
          className={`w-full py-3 rounded-xl font-semibold transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98] ${isSuccess ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white shadow-lg shadow-emerald-500/25' : 'bg-slate-800 hover:bg-slate-700 text-white'}`}
        >
          Entendido
        </button>
      </div>
    </div>
  )
}

const MIN_GROUP_MEMBERS = 3

function App() {
  const [view, setView] = useState('login')
  const [user, setUser] = useState(null)

  const [users, setUsers] = useState([])
  const [groups, setGroups] = useState([])

  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [messages, setMessages] = useState([])
  const [groupMembers, setGroupMembers] = useState([])

  const [inputMsg, setInputMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [socketConnected, setSocketConnected] = useState(false)
  const [presenceMap, setPresenceMap] = useState({})
  const [typingMap, setTypingMap] = useState({})
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [activeReactionMessageId, setActiveReactionMessageId] = useState(null)

  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [createGroupMemberIds, setCreateGroupMemberIds] = useState([])

  const [showManageGroupModal, setShowManageGroupModal] = useState(false)
  const [userToAddInGroup, setUserToAddInGroup] = useState('')

  const [alert, setAlert] = useState({ show: false, type: 'success', message: '' })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const socketRef = useRef(null)
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const typingTimeoutRef = useRef(null)
  const localTypingRef = useRef(false)

  const showAlert = (type, message) => setAlert({ show: true, type, message })
  const closeAlert = () => setAlert((prev) => ({ ...prev, show: false }))

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${user?.token || ''}`
  })

  const isGroupChat = !!selectedGroup
  const isPrivateChat = !!selectedUser && !selectedGroup

  const myRoleInSelectedGroup = selectedGroup?.my_role || 'member'
  const canManageGroup = isGroupChat && myRoleInSelectedGroup === 'admin'

  const changeView = (newView) => {
    setView(newView)
    window.history.pushState({ view: newView }, '', newView === 'login' ? '/' : `/#${newView}`)
  }

  const refreshGroups = async () => {
    if (!user?.token) return
    try {
      const res = await fetch('/api/groups', { headers: { Authorization: `Bearer ${user.token}` } })
      if (!res.ok) return
      const data = await res.json()
      setGroups(data)

      if (selectedGroup) {
        const stillExists = data.find((g) => g.id === selectedGroup.id)
        if (stillExists) {
          setSelectedGroup(stillExists)
        } else {
          setSelectedGroup(null)
          setMessages([])
        }
      }
    } catch (err) {
      console.error(err)
    }
  }

  const refreshGroupMembers = async (groupId) => {
    if (!user?.token || !groupId) return
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, { headers: { Authorization: `Bearer ${user.token}` } })
      if (!res.ok) return
      const data = await res.json()
      setGroupMembers(data)
    } catch (err) {
      console.error(err)
    }
  }

  const emitWithAck = (eventName, payload) => {
    return new Promise((resolve) => {
      if (!socketRef.current) return resolve({ ok: false, error: 'socket_disconnected' })
      socketRef.current.emit(eventName, payload, (response) => resolve(response || { ok: false, error: 'unknown' }))
    })
  }

  const isUserOnline = (userId) => !!presenceMap[userId]?.isOnline

  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return 'Desconectado'
    const date = new Date(Number(lastSeen))
    const now = Date.now()
    const diffMs = now - date.getTime()

    if (diffMs < 60 * 1000) return 'Visto hace un momento'
    if (diffMs < 60 * 60 * 1000) return `Visto hace ${Math.floor(diffMs / (60 * 1000))} min`

    return `Visto hoy ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  const selectedUserStatus = (() => {
    if (!selectedUser) return ''
    if (typingMap[selectedUser.id]) return 'Escribiendo...'
    if (isUserOnline(selectedUser.id)) return 'En linea'
    return formatLastSeen(presenceMap[selectedUser.id]?.lastSeen)
  })()

  const sendTypingState = (isTyping) => {
    if (!socketRef.current || !selectedUser) return
    if (localTypingRef.current === isTyping) return

    localTypingRef.current = isTyping
    socketRef.current.emit('typing_private', { to: selectedUser.id, isTyping })
  }

  const markConversationAsRead = async (withUserId) => {
    if (!withUserId || !socketRef.current) return
    await emitWithAck('mark_read', { withUserId })
  }

  useEffect(() => {
    const storedUser = localStorage.getItem('fluxchat_user')
    let initialUser = null
    if (storedUser) {
      initialUser = JSON.parse(storedUser)
      setUser(initialUser)
    }

    const hash = window.location.hash.replace('#', '')
    if (initialUser && (hash === 'chat' || hash === 'profile')) {
      setView(hash)
    } else {
      setView('login')
      window.history.replaceState({ view: 'login' }, '', '/')
    }

    const handlePopState = (event) => {
      const isLogged = !!localStorage.getItem('fluxchat_user')
      if (event.state && event.state.view) {
        if (!isLogged && (event.state.view === 'chat' || event.state.view === 'profile')) {
          setView('login')
        } else {
          setView(event.state.view)
        }
      } else {
        setView('login')
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, view])

  useEffect(() => {
    if (!user?.token) return

    const newSocket = io({ auth: { token: user.token } })
    socketRef.current = newSocket

    newSocket.on('connect', () => {
      setSocketConnected(true)
      setPresenceMap((prev) => ({
        ...prev,
        [user.id]: { isOnline: true, lastSeen: null }
      }))
    })

    newSocket.on('disconnect', () => {
      setSocketConnected(false)
    })

    newSocket.on('presence_snapshot', ({ onlineUserIds = [], lastSeenByUser = {} }) => {
      const nextMap = {}
      onlineUserIds.forEach((id) => {
        nextMap[id] = { isOnline: true, lastSeen: null }
      })
      nextMap[user.id] = { isOnline: true, lastSeen: null }
      Object.entries(lastSeenByUser).forEach(([id, lastSeen]) => {
        if (!nextMap[id]) {
          nextMap[id] = { isOnline: false, lastSeen }
        }
      })
      setPresenceMap(nextMap)
    })

    newSocket.on('presence_update', ({ userId, isOnline, lastSeen }) => {
      setPresenceMap((prev) => ({
        ...prev,
        [userId]: {
          isOnline: !!isOnline,
          lastSeen: isOnline ? null : lastSeen || Date.now()
        }
      }))
      if (!isOnline) {
        setTypingMap((prev) => ({ ...prev, [userId]: false }))
      }
    })

    newSocket.on('typing_private', ({ from, isTyping }) => {
      setTypingMap((prev) => ({ ...prev, [from]: !!isTyping }))
    })

    newSocket.on('private_message', (msg) => {
      if (!selectedUser) return
      const belongsToCurrentPrivateChat =
        (msg.from_id === selectedUser.id && msg.to_id === user.id) ||
        (msg.from_id === user.id && msg.to_id === selectedUser.id)
      if (!belongsToCurrentPrivateChat) return
      setMessages((prev) => [...prev, msg])

      if (msg.from_id === selectedUser.id && msg.to_id === user.id) {
        markConversationAsRead(selectedUser.id)
      }
    })

    newSocket.on('private_message_sent', (msg) => {
      setMessages((prev) => prev.map((m) => (msg.tempId && m.id === msg.tempId ? { ...msg } : m)))
    })

    newSocket.on('group_message', (msg) => {
      if (!selectedGroup || Number(msg.group_id) !== Number(selectedGroup.id)) return
      setMessages((prev) => [...prev, msg])
    })

    newSocket.on('group_message_sent', (msg) => {
      setMessages((prev) => prev.map((m) => (msg.tempId && m.id === msg.tempId ? { ...msg } : m)))
    })

    newSocket.on('group_members_updated', ({ groupId, members }) => {
      if (!selectedGroup || Number(groupId) !== Number(selectedGroup.id)) return
      setGroupMembers(members)
    })

    newSocket.on('group_updated', async ({ groupId }) => {
      await refreshGroups()
      if (selectedGroup && Number(groupId) === Number(selectedGroup.id)) {
        await refreshGroupMembers(groupId)
      }
    })

    newSocket.on('group_removed', async ({ groupId }) => {
      if (selectedGroup && Number(groupId) === Number(selectedGroup.id)) {
        setSelectedGroup(null)
        setMessages([])
        showAlert('error', 'Ya no formas parte de ese grupo')
      }
      await refreshGroups()
    })

    newSocket.on('reaction_update', ({ msgId, reactions }) => {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, reactions } : m)))
    })

    newSocket.on('messages_read', ({ messageIds, readAt }) => {
      const idSet = new Set(messageIds || [])
      if (idSet.size === 0) return
      setMessages((prev) =>
        prev.map((m) => {
          if (!idSet.has(m.id)) return m
          return { ...m, read_at: readAt }
        })
      )
    })

    return () => {
      clearTimeout(typingTimeoutRef.current)
      localTypingRef.current = false
      setSocketConnected(false)
      newSocket.disconnect()
    }
  }, [user?.token, selectedUser, selectedGroup])

  useEffect(() => {
    if ((view !== 'chat' && view !== 'profile') || !user) return

    fetch('/api/users')
      .then((res) => res.json())
      .then((data) => setUsers(data.filter((u) => u.id !== user.id)))
      .catch((err) => console.error(err))

    refreshGroups()
  }, [view, user])

  useEffect(() => {
    if (!selectedUser || !user || selectedGroup) return

    setLoading(true)
    setMessages([])
    fetch(`/api/messages/${user.id}/${selectedUser.id}`)
      .then((res) => res.json())
      .then((data) => {
        setMessages(data)
        setLoading(false)
        markConversationAsRead(selectedUser.id)
      })
      .catch((err) => {
        console.error(err)
        setLoading(false)
      })
  }, [selectedUser, user, selectedGroup])

  useEffect(() => {
    if (!selectedGroup || !user) return

    setLoading(true)
    setMessages([])
    fetch(`/api/groups/${selectedGroup.id}/messages`, {
      headers: { Authorization: `Bearer ${user.token}` }
    })
      .then((res) => {
        if (!res.ok) throw new Error('No autorizado')
        return res.json()
      })
      .then((data) => {
        setMessages(data)
        setLoading(false)
      })
      .catch((err) => {
        console.error(err)
        setLoading(false)
      })

    refreshGroupMembers(selectedGroup.id)
  }, [selectedGroup, user])

  useEffect(() => {
    clearTimeout(typingTimeoutRef.current)
    if (localTypingRef.current) {
      sendTypingState(false)
    }
  }, [selectedUser?.id, selectedGroup?.id])

  const handleRegister = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)

    try {
      await new Promise((r) => setTimeout(r, 800))
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      })
      const data = await res.json()
      setLoading(false)

      if (res.ok) {
        setUser(data)
        localStorage.setItem('fluxchat_user', JSON.stringify(data))
        showAlert('success', 'Cuenta creada correctamente! Bienvenido a FluxChat.')
        setTimeout(() => {
          closeAlert()
          changeView('chat')
        }, 2000)
      } else {
        const msg = data.error === 'exists' ? 'Este correo ya esta registrado. Intenta iniciar sesion.' : data.error || 'Error al registrarse'
        showAlert('error', msg)
      }
    } catch (err) {
      setLoading(false)
      showAlert('error', 'Error de conexion')
    }
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)

    try {
      await new Promise((r) => setTimeout(r, 800))
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      setLoading(false)

      if (res.ok) {
        setUser(data)
        localStorage.setItem('fluxchat_user', JSON.stringify(data))
        changeView('chat')
      } else {
        showAlert('error', data.error || 'Credenciales invalidas')
      }
    } catch (err) {
      setLoading(false)
      showAlert('error', 'Error de conexion')
    }
  }

  const handleUpdateProfile = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)

    try {
      await new Promise((r) => setTimeout(r, 600))
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      const data = await res.json()
      setLoading(false)

      if (res.ok) {
        const updatedUser = { ...user, name: data.name }
        setUser(updatedUser)
        localStorage.setItem('fluxchat_user', JSON.stringify(updatedUser))
        showAlert('success', 'Nombre actualizado correctamente')
      } else {
        showAlert('error', 'No se pudo actualizar el perfil')
      }
    } catch (err) {
      setLoading(false)
      showAlert('error', 'Error de conexion')
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('fluxchat_user')
    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = null
    }

    setUser(null)
    setSelectedUser(null)
    setSelectedGroup(null)
    setGroupMembers([])
    setMessages([])
    setView('login')
    window.history.replaceState({ view: 'login' }, '', '/')
  }

  const toggleCreateMember = (memberId) => {
    setCreateGroupMemberIds((prev) =>
      prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]
    )
  }

  const handleCreateGroup = async (e) => {
    e.preventDefault()
    if (!groupName.trim()) {
      showAlert('error', 'Escribe un nombre para el grupo')
      return
    }

    if (createGroupMemberIds.length + 1 < MIN_GROUP_MEMBERS) {
      showAlert('error', 'Debes seleccionar al menos 2 personas mas para crear el grupo')
      return
    }

    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          name: groupName,
          memberIds: createGroupMemberIds
        })
      })
      const data = await res.json()

      if (!res.ok) {
        if (data.error === 'min_members') {
          showAlert('error', 'Un grupo necesita minimo 3 personas')
        } else {
          showAlert('error', 'No se pudo crear el grupo')
        }
        return
      }

      setShowCreateGroupModal(false)
      setGroupName('')
      setCreateGroupMemberIds([])
      await refreshGroups()

      const createdGroup = { ...data, my_role: 'admin' }
      setSelectedUser(null)
      setSelectedGroup(createdGroup)
      setView('chat')
      showAlert('success', 'Grupo creado correctamente')
    } catch (err) {
      showAlert('error', 'No se pudo crear el grupo')
    }
  }

  const openManageGroup = async () => {
    if (!selectedGroup) return
    await refreshGroupMembers(selectedGroup.id)
    setUserToAddInGroup('')
    setShowManageGroupModal(true)
  }

  const handleAddMember = async () => {
    if (!selectedGroup || !userToAddInGroup) return
    const response = await emitWithAck('group_add_member', {
      groupId: selectedGroup.id,
      userId: Number(userToAddInGroup)
    })

    if (!response.ok) {
      showAlert('error', response.error === 'already_member' ? 'Esa persona ya esta en el grupo' : 'No se pudo agregar al miembro')
      return
    }

    await refreshGroups()
    await refreshGroupMembers(selectedGroup.id)
    setUserToAddInGroup('')
    showAlert('success', 'Miembro agregado')
  }

  const handleRemoveMember = async (memberId) => {
    if (!selectedGroup) return
    const response = await emitWithAck('group_remove_member', {
      groupId: selectedGroup.id,
      userId: memberId
    })

    if (!response.ok) {
      if (response.error === 'min_members') {
        showAlert('error', 'No puedes eliminar mas personas. El grupo debe tener minimo 3 integrantes.')
      } else {
        showAlert('error', 'No se pudo eliminar al miembro')
      }
      return
    }

    await refreshGroups()
    await refreshGroupMembers(selectedGroup.id)
    showAlert('success', 'Miembro eliminado')
  }

  const handleToggleAdmin = async (member) => {
    if (!selectedGroup) return
    const response = await emitWithAck('group_set_admin', {
      groupId: selectedGroup.id,
      userId: member.user_id,
      isAdmin: member.role !== 'admin'
    })

    if (!response.ok) {
      showAlert('error', 'No se pudo actualizar el rol')
      return
    }

    await refreshGroups()
    await refreshGroupMembers(selectedGroup.id)
    showAlert('success', 'Rol actualizado')
  }

  const handleEmojiClick = ({ emoji }) => {
    setInputMsg((prev) => prev + emoji)
    setShowEmojiPicker(false)
  }

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (!file) return

    if (file.size > 5 * 1024 * 1024) {
      showAlert('error', 'El archivo es demasiado grande (max 5MB)')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result
      const tempId = `temp-${Date.now()}`

      if (isGroupChat) {
        const tempMsg = {
          id: tempId,
          group_id: selectedGroup.id,
          from_id: user.id,
          from_name: user.name,
          content: base64,
          timestamp: Date.now(),
          type: 'image',
          reactions: {}
        }
        setMessages((prev) => [...prev, tempMsg])
        socketRef.current.emit('group_message', {
          groupId: selectedGroup.id,
          content: base64,
          type: 'image',
          tempId
        })
      } else if (isPrivateChat) {
        const tempMsg = {
          id: tempId,
          from_id: user.id,
          to_id: selectedUser.id,
          content: base64,
          timestamp: Date.now(),
          type: 'image',
          reactions: {}
        }
        setMessages((prev) => [...prev, tempMsg])
        socketRef.current.emit('private_message', { to: selectedUser.id, content: base64, type: 'image', tempId })
      }
    }

    reader.readAsDataURL(file)
    e.target.value = null
  }

  const handleReaction = (msgId, emoji) => {
    if (!socketRef.current || isGroupChat) return
    socketRef.current.emit('reaction', { msgId, emoji })
    setActiveReactionMessageId(null)
  }

  const sendMessage = () => {
    if (!inputMsg.trim() || !socketRef.current || (!selectedUser && !selectedGroup)) return

    const tempId = `temp-${Date.now()}`

    if (isGroupChat) {
      const tempMsg = {
        id: tempId,
        group_id: selectedGroup.id,
        from_id: user.id,
        from_name: user.name,
        content: inputMsg,
        timestamp: Date.now(),
        type: 'text',
        reactions: {}
      }

      setMessages((prev) => [...prev, tempMsg])
      socketRef.current.emit('group_message', {
        groupId: selectedGroup.id,
        content: inputMsg,
        type: 'text',
        tempId
      })
    } else {
      const tempMsg = {
        id: tempId,
        from_id: user.id,
        to_id: selectedUser.id,
        content: inputMsg,
        timestamp: Date.now(),
        type: 'text',
        reactions: {}
      }

      setMessages((prev) => [...prev, tempMsg])
      socketRef.current.emit('private_message', {
        to: selectedUser.id,
        content: inputMsg,
        type: 'text',
        tempId
      })
    }

    setInputMsg('')
    clearTimeout(typingTimeoutRef.current)
    sendTypingState(false)
  }

  const filteredUsers = users.filter((u) => u.name.toLowerCase().includes(searchQuery.toLowerCase()))
  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(searchQuery.toLowerCase()))

  const chatMessages = isGroupChat
    ? messages.filter((m) => Number(m.group_id) === Number(selectedGroup?.id))
    : messages.filter(
        (m) =>
          (m.from_id === user?.id && m.to_id === selectedUser?.id) ||
          (m.from_id === selectedUser?.id && m.to_id === user?.id)
      )

  const availableUsersToAdd = users.filter(
    (u) => !groupMembers.some((member) => Number(member.user_id) === Number(u.id))
  )

  const renderAuth = () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0f172a] overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-violet-600/20 rounded-full blur-[120px] animate-pulse-glow"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-600/20 rounded-full blur-[120px] animate-pulse-glow" style={{ animationDelay: '1.5s' }}></div>

      <div className="w-full max-w-md p-8 bg-slate-900/80 backdrop-blur-xl rounded-2xl border border-slate-700/50 shadow-2xl relative z-10 mx-4">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-gradient-to-br from-violet-600 to-indigo-600 text-white rounded-xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-violet-500/20 animate-float">
            <i className="fa-solid fa-bolt text-2xl"></i>
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">FluxChat</h1>
          <p className="text-slate-400 mt-2 font-medium">Conectate al futuro</p>
        </div>

        <form className="space-y-5" onSubmit={view === 'login' ? handleLogin : handleRegister}>
          {view === 'register' && (
            <div>
              <label className="block text-xs font-bold mb-1.5 text-slate-400 uppercase tracking-wider ml-1">Nombre</label>
              <div className="relative">
                <i className="fa-regular fa-user absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
                <input
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-950/50 border border-slate-700/50 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none transition-all text-sm font-medium placeholder-slate-600"
                  type="text"
                  placeholder="Tu nombre completo"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold mb-1.5 text-slate-400 uppercase tracking-wider ml-1">Email</label>
            <div className="relative">
              <i className="fa-regular fa-envelope absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
              <input
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-950/50 border border-slate-700/50 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none transition-all text-sm font-medium placeholder-slate-600"
                type="email"
                placeholder="nombre@ejemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold mb-1.5 text-slate-400 uppercase tracking-wider ml-1">Contrasena</label>
            <div className="relative">
              <i className="fa-solid fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
              <input
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-950/50 border border-slate-700/50 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none transition-all text-sm font-medium placeholder-slate-600"
                type="password"
                placeholder="********"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold rounded-xl hover:shadow-lg hover:shadow-violet-500/25 transition-all transform hover:scale-[1.01] active:opacity-90 disabled:opacity-70 disabled:cursor-wait mt-4"
          >
            {loading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : view === 'login' ? 'Iniciar Sesion' : 'Crear Cuenta'}
          </button>

          <p className="text-center text-sm text-slate-400 mt-6">
            {view === 'login' ? 'No tienes cuenta?' : 'Ya tienes cuenta?'}
            <button
              type="button"
              onClick={() => {
                changeView(view === 'login' ? 'register' : 'login')
                setName('')
                setEmail('')
                setPassword('')
              }}
              className="text-violet-400 hover:text-violet-300 font-bold ml-1.5 transition"
            >
              {view === 'login' ? 'Registrate' : 'Inicia Sesion'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )

  const renderSidebar = () => (
    <aside className="w-80 bg-[#1e293b] border-r border-slate-700/50 flex flex-col shrink-0">
      <div className="h-20 flex items-center justify-between px-6 shrink-0 bg-[#0f172a]/30 backdrop-blur-sm border-b border-slate-700/50">
        <div className="flex items-center gap-3 font-extrabold text-xl tracking-tight text-white">
          <div className="w-9 h-9 bg-gradient-to-br from-violet-600 to-indigo-600 text-white rounded-lg flex items-center justify-center text-sm shadow-md shadow-violet-500/20">
            <i className="fa-solid fa-bolt"></i>
          </div>
          FluxChat
        </div>
        <button
          onClick={() => setShowCreateGroupModal(true)}
          className="h-9 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition"
          title="Crear grupo"
        >
          <i className="fa-solid fa-user-group mr-1"></i> Nuevo
        </button>
      </div>

      <div className="p-5 shrink-0">
        <div className="relative group">
          <i className="fa-solid fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition"></i>
          <input
            className="w-full bg-slate-900/50 border border-slate-700 focus:border-violet-500/50 rounded-xl pl-10 pr-4 py-2.5 text-sm outline-none text-white placeholder-slate-500 transition-all shadow-inner focus:bg-slate-900"
            placeholder="Buscar personas o grupos..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 space-y-2 pb-4">
        <div className="text-xs font-bold text-slate-500 px-3 py-2 uppercase tracking-wider">Grupos</div>
        {filteredGroups.length === 0 ? (
          <div className="text-slate-600 text-sm px-3 italic">No tienes grupos</div>
        ) : (
          filteredGroups.map((g) => (
            <div
              key={g.id}
              onClick={() => {
                setSelectedGroup(g)
                setSelectedUser(null)
                setView('chat')
              }}
              className={`p-3 rounded-xl cursor-pointer flex items-center gap-3.5 transition-all group ${selectedGroup?.id === g.id && view === 'chat' ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/20' : 'hover:bg-slate-700/50 text-slate-300'}`}
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 ${selectedGroup?.id === g.id && view === 'chat' ? 'bg-white/20 border-white/20' : 'bg-slate-800 border-slate-700'}`}>
                <i className="fa-solid fa-user-group"></i>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{g.name}</div>
                <div className={`text-xs truncate ${selectedGroup?.id === g.id && view === 'chat' ? 'text-violet-200' : 'text-slate-500 group-hover:text-slate-400'}`}>
                  {g.member_count} miembros - {g.my_role === 'admin' ? 'Admin' : 'Miembro'}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="text-xs font-bold text-slate-500 px-3 py-2 uppercase tracking-wider mt-2">Contactos</div>
        {filteredUsers.length > 0 ? (
          filteredUsers.map((u) => (
            <div
              key={u.id}
              onClick={() => {
                setSelectedUser(u)
                setSelectedGroup(null)
                setView('chat')
              }}
              className={`p-3 rounded-xl cursor-pointer flex items-center gap-3.5 transition-all group ${selectedUser?.id === u.id && view === 'chat' ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/20' : 'hover:bg-slate-700/50 text-slate-300'}`}
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 ${selectedUser?.id === u.id && view === 'chat' ? 'bg-white/20 border-white/20' : 'bg-slate-800 border-slate-700'}`}>
                {u.name.substring(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{u.name}</div>
                <div className={`text-xs truncate flex items-center gap-1.5 ${selectedUser?.id === u.id && view === 'chat' ? 'text-violet-200' : 'text-slate-500 group-hover:text-slate-400'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${isUserOnline(u.id) ? 'bg-emerald-500' : 'bg-slate-500'}`}></span>
                  {isUserOnline(u.id) ? 'En linea' : 'Desconectado'}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center py-8 text-slate-600 text-sm italic">No se encontraron usuarios.</div>
        )}
      </div>

      <div className="p-4 border-t border-slate-700/50 flex items-center gap-3 shrink-0 bg-[#162032]">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center font-bold text-sm text-white shadow-lg">
          {user?.name?.substring(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold truncate text-white">{user?.name}</div>
          <div className={`text-xs flex items-center gap-1.5 font-medium ${isUserOnline(user?.id) ? 'text-emerald-500' : 'text-slate-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${socketConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`}></span>
            {socketConnected ? 'En linea' : 'Reconectando...'}
          </div>
        </div>
        <button
          onClick={() => {
            setName(user.name)
            changeView('profile')
          }}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition"
        >
          <i className="fa-solid fa-gear"></i>
        </button>
      </div>
    </aside>
  )

  const renderProfile = () => (
    <main className="flex-1 flex flex-col bg-[#0f172a] relative overflow-hidden items-center justify-center p-6">
      <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>

      <div className="w-full max-w-lg bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl p-8 relative z-10 animate-fade-in">
        <button onClick={() => changeView('chat')} className="absolute top-6 right-6 text-slate-400 hover:text-white transition">
          <i className="fa-solid fa-xmark text-xl"></i>
        </button>

        <div className="text-center mb-8">
          <div className="w-24 h-24 mx-auto bg-gradient-to-br from-emerald-500 to-teal-500 rounded-full flex items-center justify-center text-3xl font-bold text-white shadow-2xl shadow-emerald-500/20 mb-4 ring-4 ring-slate-900">
            {user?.name?.substring(0, 2).toUpperCase()}
          </div>
          <h2 className="text-2xl font-bold text-white">Tu Perfil</h2>
          <p className="text-slate-500">{user?.email}</p>
        </div>

        <form onSubmit={handleUpdateProfile} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2 text-slate-300">Nombre de Usuario</label>
            <div className="relative">
              <input
                className="w-full p-4 rounded-xl bg-slate-950 border border-slate-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition text-white placeholder-slate-600"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Escribe tu nombre"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || name === user.name}
            className="w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl hover:bg-slate-200 transition-all transform active:scale-95 disabled:opacity-50 disabled:active:scale-100"
          >
            {loading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : 'Guardar Cambios'}
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="w-full py-3.5 bg-rose-500/10 text-rose-400 font-bold rounded-xl hover:bg-rose-500/20 transition-all transform active:scale-95 flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-right-from-bracket"></i> Cerrar Sesion
          </button>
        </form>
      </div>
    </main>
  )

  if (view === 'login' || view === 'register') {
    return (
      <div className="min-h-screen bg-[#0f172a] text-white font-sans antialiased text-sm">
        {alert.show && <CustomAlert type={alert.type} message={alert.message} onClose={closeAlert} />}
        {renderAuth()}
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full bg-[#0f172a] text-white font-sans antialiased text-sm overflow-hidden">
      {alert.show && <CustomAlert type={alert.type} message={alert.message} onClose={closeAlert} />}

      {showCreateGroupModal && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
            <div className="p-5 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-bold">Crear grupo</h3>
              <button onClick={() => setShowCreateGroupModal(false)} className="text-slate-400 hover:text-white">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <form onSubmit={handleCreateGroup} className="p-5 space-y-4">
              <div>
                <label className="block text-sm text-slate-300 mb-1">Nombre del grupo</label>
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3 focus:border-violet-500 outline-none"
                  placeholder="Ej: Proyecto Marketing"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-300 mb-2">
                  Selecciona integrantes (minimo 2 ademas de ti)
                </label>
                <div className="max-h-56 overflow-y-auto bg-slate-950/60 rounded-xl border border-slate-700 p-2 space-y-1">
                  {users.map((u) => (
                    <label key={u.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={createGroupMemberIds.includes(u.id)}
                        onChange={() => toggleCreateMember(u.id)}
                        className="accent-violet-500"
                      />
                      <span className="text-sm font-semibold">{u.name}</span>
                      <span className="text-xs text-slate-500">{u.email}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="text-xs text-slate-500">Total actual: {createGroupMemberIds.length + 1} personas</div>

              <button type="submit" className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 font-bold transition">
                Crear grupo
              </button>
            </form>
          </div>
        </div>
      )}

      {showManageGroupModal && selectedGroup && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
            <div className="p-5 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-bold">Gestionar grupo: {selectedGroup.name}</h3>
              <button onClick={() => setShowManageGroupModal(false)} className="text-slate-400 hover:text-white">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
                <select
                  value={userToAddInGroup}
                  onChange={(e) => setUserToAddInGroup(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-4 py-3"
                >
                  <option value="">Selecciona persona para agregar</option>
                  {availableUsersToAdd.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
                <button onClick={handleAddMember} className="px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold">
                  Agregar
                </button>
              </div>

              <div className="max-h-72 overflow-y-auto border border-slate-700 rounded-xl">
                {groupMembers.map((member) => {
                  const isMe = Number(member.user_id) === Number(user.id)
                  const lockRemove = groupMembers.length <= MIN_GROUP_MEMBERS

                  return (
                    <div key={member.user_id} className="p-3 border-b border-slate-800 last:border-b-0 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs">
                        {member.name.substring(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{member.name} {isMe ? '(Tu)' : ''}</div>
                        <div className="text-xs text-slate-500">{member.email}</div>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full ${member.role === 'admin' ? 'bg-violet-600/20 text-violet-300' : 'bg-slate-700/50 text-slate-300'}`}>
                        {member.role === 'admin' ? 'Admin' : 'Miembro'}
                      </span>

                      {!isMe && (
                        <button
                          onClick={() => handleToggleAdmin(member)}
                          className="px-3 py-1.5 rounded-lg text-xs bg-slate-700 hover:bg-slate-600"
                        >
                          {member.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
                        </button>
                      )}

                      {!isMe && (
                        <button
                          onClick={() => handleRemoveMember(member.user_id)}
                          className={`px-3 py-1.5 rounded-lg text-xs ${lockRemove ? 'bg-slate-800 text-slate-500' : 'bg-rose-600 hover:bg-rose-500 text-white'}`}
                        >
                          Eliminar
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {renderSidebar()}

      {view === 'profile' ? (
        renderProfile()
      ) : (
        <main className="flex-1 flex flex-col bg-[#0f172a] relative">
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>

          {selectedUser || selectedGroup ? (
            <>
              <header className="h-20 border-b border-slate-700/50 flex items-center justify-between px-8 bg-[#0f172a]/80 backdrop-blur z-20 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-sm font-bold text-white shadow-lg border border-white/10">
                    {isGroupChat ? <i className="fa-solid fa-user-group"></i> : selectedUser.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">{isGroupChat ? selectedGroup.name : selectedUser.name}</h3>
                    <span className={`text-xs font-medium ${isGroupChat ? 'text-emerald-400' : typingMap[selectedUser?.id] ? 'text-violet-300' : isUserOnline(selectedUser?.id) ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {isGroupChat ? `${groupMembers.length || selectedGroup.member_count || 0} miembros` : selectedUserStatus}
                    </span>
                  </div>
                </div>

                {canManageGroup && (
                  <button onClick={openManageGroup} className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 text-sm font-semibold">
                    <i className="fa-solid fa-shield-halved mr-2"></i> Gestionar
                  </button>
                )}
              </header>

              <div className="flex-1 overflow-y-auto p-8 space-y-6 z-10 custom-scrollbar relative">
                {loading && messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center opacity-50">
                    <i className="fa-solid fa-circle-notch fa-spin text-3xl text-violet-500"></i>
                  </div>
                ) : chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 pb-20 animate-fade-in">
                    <div className="w-20 h-20 rounded-full bg-slate-800/50 flex items-center justify-center text-3xl mb-6 border border-slate-700/50">
                      <i className="fa-regular fa-hand-spock text-violet-400"></i>
                    </div>
                    <p className="text-lg">Comienza la conversacion</p>
                  </div>
                ) : (
                  chatMessages.map((msg, i) => {
                    const isMe = msg.from_id === user.id
                    const isLast = i === chatMessages.length - 1
                    const reactions = msg.reactions || {}
                    const hasReactions = Object.keys(reactions).length > 0
                    const showReadState = !isGroupChat && isMe
                    const readStateLabel = msg.read_at ? 'Leido' : 'No leido'
                    const timeLabel = new Date(Number(msg.timestamp || Date.now())).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })

                    return (
                      <div key={i} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${isLast ? 'animate-slide-up' : ''} mb-4 group relative`}>
                        <div className={`max-w-[74%] relative ${isMe ? 'rounded-2xl rounded-tr-sm' : 'rounded-2xl rounded-tl-sm'} shadow-md transition-all hover:shadow-lg`}>
                          <div className={`px-5 py-3 text-sm leading-relaxed break-words overflow-hidden rounded-inherit ${isMe ? 'bg-gradient-to-br from-violet-600 to-indigo-600 text-white' : 'bg-slate-800 border border-slate-700/50 text-slate-200'}`}>
                            {isGroupChat && !isMe && <div className="text-[11px] font-bold text-violet-300 mb-1">{msg.from_name || 'Usuario'}</div>}
                            {msg.type === 'image' ? (
                              <div className="space-y-2">
                                <img src={msg.content} alt="Compartido" className="max-w-full rounded-lg max-h-[300px] object-cover bg-black/20" />
                              </div>
                            ) : (
                              msg.content
                            )}
                          </div>

                          {!isGroupChat && (
                            <div className={`absolute top-1/2 -translate-y-1/2 ${isMe ? '-left-10' : '-right-10'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                              <div className="relative">
                                <button
                                  onClick={() => setActiveReactionMessageId(activeReactionMessageId === msg.id ? null : msg.id)}
                                  className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 hover:text-yellow-400 hover:scale-110 transition shadow-lg"
                                >
                                  <i className="fa-regular fa-face-smile"></i>
                                </button>
                                {activeReactionMessageId === msg.id && (
                                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 p-2 rounded-full flex gap-1 shadow-xl z-50 animate-fade-in">
                                    {['👍', '❤️', '😂', '😮', '😢', '😡'].map((emoji) => (
                                      <button
                                        key={emoji}
                                        onClick={() => handleReaction(msg.id, emoji)}
                                        className={`w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-700 text-lg transition ${reactions[user.id] === emoji ? 'bg-violet-600/30 ring-1 ring-violet-500' : ''}`}
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                    <div className="fixed inset-0 z-[-1]" onClick={() => setActiveReactionMessageId(null)}></div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {hasReactions && !isGroupChat && (
                            <div className={`absolute -bottom-3 ${isMe ? 'right-0' : 'left-0'} flex items-center gap-1`}>
                              <div className="flex -space-x-1 bg-slate-800/90 backdrop-blur border border-slate-700 px-1.5 py-0.5 rounded-full shadow-sm text-xs">
                                {[...new Set(Object.values(reactions))].slice(0, 3).map((emoji, idx) => (
                                  <span key={idx} className="hover:scale-125 transition cursor-default">{emoji}</span>
                                ))}
                                <span className="text-slate-400 text-[10px] ml-1 font-bold">{Object.keys(reactions).length}</span>
                              </div>
                            </div>
                          )}
                        </div>

                        {showReadState && (
                          <div className="mt-1 px-1 text-[10px] text-slate-400 text-right font-medium">
                            {timeLabel} - {readStateLabel}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-6 border-t border-slate-700/50 shrink-0 z-20 bg-[#0f172a] relative">
                {showEmojiPicker && (
                  <div className="absolute bottom-24 left-6 z-50">
                    <div onClick={() => setShowEmojiPicker(false)} className="fixed inset-0 z-40 bg-transparent" />
                    <div className="relative z-50 animate-fade-in shadow-2xl rounded-2xl overflow-hidden border border-slate-700/50">
                      <EmojiPicker onEmojiClick={handleEmojiClick} theme="dark" width={320} height={400} lazyLoadEmojis={true} />
                    </div>
                  </div>
                )}

                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />

                <form
                  className="flex items-center gap-3 bg-slate-900 p-2 pl-4 rounded-2xl border border-slate-700/50 focus-within:border-violet-500/50 focus-within:shadow-lg focus-within:shadow-violet-500/10 transition-all"
                  onSubmit={(e) => {
                    e.preventDefault()
                    sendMessage()
                  }}
                >
                  <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} className={`transition p-2 rounded-lg hover:bg-slate-800 ${showEmojiPicker ? 'text-violet-400 bg-slate-800' : 'text-slate-500 hover:text-violet-400'}`}>
                    <i className="fa-regular fa-smile text-lg"></i>
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="text-slate-500 hover:text-violet-400 transition p-2 rounded-lg hover:bg-slate-800">
                    <i className="fa-solid fa-paperclip text-lg"></i>
                  </button>
                  <input
                    className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-slate-500 font-medium ml-2"
                    placeholder={isGroupChat ? 'Mensaje al grupo...' : 'Escribe un mensaje...'}
                    value={inputMsg}
                    onChange={(e) => {
                      const value = e.target.value
                      setInputMsg(value)

                      if (!isPrivateChat) return

                      if (!value.trim()) {
                        clearTimeout(typingTimeoutRef.current)
                        sendTypingState(false)
                        return
                      }

                      sendTypingState(true)
                      clearTimeout(typingTimeoutRef.current)
                      typingTimeoutRef.current = setTimeout(() => {
                        sendTypingState(false)
                      }, 1200)
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!inputMsg.trim()}
                    className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center hover:bg-violet-500 transition-all disabled:opacity-50 disabled:grayscale transform active:scale-95 shadow-lg shadow-violet-600/30"
                  >
                    <i className="fa-solid fa-paper-plane text-xs"></i>
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 z-0 p-8 text-center animate-fade-in">
              <div className="w-24 h-24 bg-gradient-to-br from-slate-800 to-slate-900 rounded-3xl flex items-center justify-center mb-8 border border-slate-700/50 transform rotate-6 shadow-2xl">
                <i className="fa-solid fa-comments text-5xl text-violet-500/50"></i>
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">Tu bandeja de entrada</h2>
              <p className="text-slate-400 max-w-xs mx-auto leading-relaxed">Selecciona una persona o un grupo para empezar a chatear.</p>
            </div>
          )}
        </main>
      )}
    </div>
  )
}

export default App
