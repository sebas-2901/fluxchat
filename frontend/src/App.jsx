import { useState, useEffect, useRef } from 'react'
import io from 'socket.io-client'
import EmojiPicker from 'emoji-picker-react'

// --- Components ---

function Loader() {
  return (
    <div className="flex items-center justify-center p-4">
      <div className="relative w-12 h-12">
        <div className="absolute top-0 left-0 w-full h-full border-4 border-slate-700 rounded-full"></div>
        <div className="absolute top-0 left-0 w-full h-full border-4 border-violet-500 rounded-full border-t-transparent animate-spin"></div>
      </div>
    </div>
  )
}

function CustomAlert({ type, message, onClose }) {
  if (!message) return null;
  const isSuccess = type === 'success';
  
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4 transform transition-all scale-100 animate-slide-up">
        <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl ${isSuccess ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
          <i className={`fa-solid ${isSuccess ? 'fa-check' : 'fa-xmark'}`}></i>
        </div>
        <h3 className="text-xl font-bold text-center mb-2 text-white">{isSuccess ? '¡Éxito!' : 'Oops...'}</h3>
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

function App() {
  const [view, setView] = useState('login'); // login, register, chat, profile
  const [user, setUser] = useState(null); // { id, name, email, token }
  const [users, setUsers] = useState([]); // Array of users
  const [selectedUser, setSelectedUser] = useState(null); // User to chat with
  const [messages, setMessages] = useState([]); // Current conversation messages
  const [inputMsg, setInputMsg] = useState('');
  
  // UI States
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [messageHoverId, setMessageHoverId] = useState(null);
  const [activeReactionMessageId, setActiveReactionMessageId] = useState(null);
  
  const [alert, setAlert] = useState({ show: false, type: 'success', message: '' });

  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  // Helper to show alert
  const showAlert = (type, message) => {
    setAlert({ show: true, type, message });
  };
  const closeAlert = () => setAlert(prev => ({ ...prev, show: false }));

  // Restore session and handle browser history
  useEffect(() => {
    // 1. Restore user from local storage
    const storedUser = localStorage.getItem('fluxchat_user');
    let initialUser = null;
    if (storedUser) {
      initialUser = JSON.parse(storedUser);
      setUser(initialUser);
    }

    // 2. Handle initial view based on URL hash
    const hash = window.location.hash.replace('#', '');
    if (initialUser && (hash === 'chat' || hash === 'profile')) {
       setView(hash);
    } else {
       // If not logged in, force login even if hash exists
       setView('login');
       window.history.replaceState({ view: 'login' }, '', '/');
    }

    // 3. Listen for popstate
    const handlePopState = (event) => {
      // We need to access the *current* user state here, but creating a closure
      // over 'user' in useEffect is tricky. Reliance on localStorage is safer for the check.
      const isLogged = !!localStorage.getItem('fluxchat_user');
      
      if (event.state && event.state.view) {
        if (!isLogged && (event.state.view === 'chat' || event.state.view === 'profile')) {
            setView('login');
        } else {
            setView(event.state.view);
        }
      } else {
        setView('login');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const changeView = (newView) => {
    setView(newView);
    window.history.pushState({ view: newView }, '', newView === 'login' ? '/' : `/#${newView}`);
  };

  // Scroll to bottom of chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(() => { scrollToBottom() }, [messages, view]);

  // Initialize socket on login
  useEffect(() => {
    if (user?.token) {
      const newSocket = io({ auth: { token: user.token } });
      socketRef.current = newSocket;
      
      newSocket.on('private_message', (msg) => {
        setMessages(prev => {
            if (msg.from_id === user.id) return prev;
            return [...prev, msg];
        });
      });
      
      newSocket.on('private_message_sent', (msg) => {
          setMessages(prev => prev.map(m => 
             // Replace optimistic message using tempId
            (msg.tempId && m.id === msg.tempId) ? msg : m
          ));
      });
      
      newSocket.on('reaction_update', ({ msgId, reactions }) => {
        setMessages(prev => prev.map(m => 
            m.id === msgId ? { ...m, reactions } : m
        ));
      });

      return () => newSocket.disconnect();
    }
  }, [user]);

  // Fetch users when entering chat
  useEffect(() => {
    if ((view === 'chat' || view === 'profile') && user) {
        fetch('/api/users')
            .then(res => res.json())
            .then(data => {
                setUsers(data.filter(u => u.id !== user.id));
            })
            .catch(err => console.error(err));
    }
  }, [view, user]);

  // Fetch conversation
  useEffect(() => {
    if (selectedUser && user) {
        setLoading(true);
        setMessages([]);
        fetch(`/api/messages/${user.id}/${selectedUser.id}`)
            .then(res => res.json())
            .then(data => {
                setMessages(data);
                setLoading(false);
            })
            .catch(err => {
                console.error(err);
                setLoading(false);
            });
    }
  }, [selectedUser, user]);

  const handleRegister = async (e) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      // Simulate loop feel
      await new Promise(r => setTimeout(r, 800)); 
      
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const data = await res.json();
      setLoading(false);
      
      if (res.ok) {
        setUser(data);
        localStorage.setItem('fluxchat_user', JSON.stringify(data)); // Save session
        showAlert('success', '¡Cuenta creada correctamente! Bienvenido a FluxChat.');
        setTimeout(() => { closeAlert(); changeView('chat'); }, 2000);
      } else {
        const msg = data.error === 'exists'
          ? 'Este correo ya está registrado. Intenta iniciar sesión.'
          : (data.error || 'Error al registrarse');
        showAlert('error', msg);
      }
    } catch (err) {
      setLoading(false);
      showAlert('error', 'Error de conexión');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
        await new Promise(r => setTimeout(r, 800));
        
        console.log('Sending JSON:', JSON.stringify({ email, password })); // Debug Log
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        setLoading(false);
        
        if (res.ok) {
            setUser(data);
            localStorage.setItem('fluxchat_user', JSON.stringify(data)); // Save session
            changeView('chat');
        } else {
            showAlert('error', data.error || 'Credenciales inválidas');
        }
    } catch(err) {
        setLoading(false);
        showAlert('error', 'Error de conexión');
    }
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
        await new Promise(r => setTimeout(r, 600));
        
        const res = await fetch(`/api/users/${user.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }) // 'name' state already holds the new name if edited in Profile view
        });
        const data = await res.json();
        setLoading(false);
        
        if (res.ok) {
            const updatedUser = { ...user, name: data.name };
            setUser(updatedUser);
            localStorage.setItem('fluxchat_user', JSON.stringify(updatedUser));
            showAlert('success', 'Nombre actualizado correctamente');
        } else {
            showAlert('error', 'No se pudo actualizar el perfil');
        }
    } catch(err) {
        setLoading(false);
        showAlert('error', 'Error de conexión');
    }
  };

  const handleEmojiClick = ({ emoji }) => {
    setInputMsg(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showAlert('error', 'El archivo es demasiado grande (máx 5MB)'); return; }
    
    const reader = new FileReader();
    reader.onload = () => {
        const base64 = reader.result;
        const tempId = `temp-${Date.now()}`;
        const tempMsg = { id: tempId, from_id: user.id, to_id: selectedUser.id, content: base64, timestamp: Date.now(), type: 'image', reactions: {} };
        setMessages(prev => [...prev, tempMsg]);
        socketRef.current.emit('private_message', { to: selectedUser.id, content: base64, type: 'image', tempId });
    };
    reader.readAsDataURL(file);
    e.target.value = null;
  };

  const handleReaction = (msgId, emoji) => {
    if (!socketRef.current) return;
    socketRef.current.emit('reaction', { msgId, emoji });
    setActiveReactionMessageId(null);
  };

  const sendMessage = () => {
    if (!inputMsg.trim() || !selectedUser || !socketRef.current) return;
    
    // Add unique temp ID
    const tempId = `temp-${Date.now()}`;
    const tempMsg = {
        id: tempId,
        from_id: user.id,
        to_id: selectedUser.id,
        content: inputMsg,
        timestamp: Date.now(),
        type: 'text',
        reactions: {}
    };
    
    setMessages(prev => [...prev, tempMsg]);
    
    // Send tempId to server so it can return it
    socketRef.current.emit('private_message', {
        to: selectedUser.id,
        content: inputMsg,
        type: 'text',
        tempId: tempId
    });
    
    setInputMsg('');
  };

  // Filter users based on search
  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const currentChatMessages = messages.filter(m => 
    (m.from_id === user?.id && m.to_id === selectedUser?.id) ||
    (m.from_id === selectedUser?.id && m.to_id === user?.id)
  );

  // --- Views ---

  const renderAuth = () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0f172a] overflow-hidden">
      {/* Background blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-violet-600/20 rounded-full blur-[120px] animate-pulse-glow"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-600/20 rounded-full blur-[120px] animate-pulse-glow" style={{animationDelay: '1.5s'}}></div>

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
                            onChange={e => setName(e.target.value)}
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
                    onChange={e => setEmail(e.target.value)}
                    required
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold mb-1.5 text-slate-400 uppercase tracking-wider ml-1">Contraseña</label>
              <div className="relative">
                <i className="fa-solid fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
                <input 
                    className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-950/50 border border-slate-700/50 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none transition-all text-sm font-medium placeholder-slate-600" 
                    type="password" 
                    placeholder="••••••••" 
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                />
              </div>
            </div>
            
            <button 
                type="submit" 
                disabled={loading}
                className="w-full py-3.5 bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold rounded-xl hover:shadow-lg hover:shadow-violet-500/25 transition-all transform hover:scale-[1.01] active:opacity-90 disabled:opacity-70 disabled:cursor-wait mt-4"
            >
                {loading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : (view === 'login' ? 'Iniciar Sesión' : 'Crear Cuenta')}
            </button>
            
            <p className="text-center text-sm text-slate-400 mt-6">
              {view === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'} 
              <button 
                type="button" 
                onClick={() => {
                    changeView(view === 'login' ? 'register' : 'login');
                    setName(''); setEmail(''); setPassword('');
                }} 
                className="text-violet-400 hover:text-violet-300 font-bold ml-1.5 transition"
              >
                {view === 'login' ? 'Regístrate' : 'Inicia Sesión'}
              </button>
            </p>
        </form>
      </div>
    </div>
  );

  const renderSidebar = () => (
    <aside className="w-80 bg-[#1e293b] border-r border-slate-700/50 flex flex-col shrink-0">
        <div className="h-20 flex items-center justify-between px-6 shrink-0 bg-[#0f172a]/30 backdrop-blur-sm border-b border-slate-700/50">
            <div className="flex items-center gap-3 font-extrabold text-xl tracking-tight text-white">
            <div className="w-9 h-9 bg-gradient-to-br from-violet-600 to-indigo-600 text-white rounded-lg flex items-center justify-center text-sm shadow-md shadow-violet-500/20">
                <i className="fa-solid fa-bolt"></i>
            </div>
            FluxChat
            </div>
        </div>
        
        <div className="p-5 shrink-0">
            <div className="relative group">
            <i className="fa-solid fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-violet-400 transition"></i>
            <input 
                className="w-full bg-slate-900/50 border border-slate-700 focus:border-violet-500/50 rounded-xl pl-10 pr-4 py-2.5 text-sm outline-none text-white placeholder-slate-500 transition-all shadow-inner focus:bg-slate-900" 
                placeholder="Buscar usuarios..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
            />
            </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-4">
            <div className="text-xs font-bold text-slate-500 px-3 py-2 uppercase tracking-wider mb-1">Contactos</div>
            {loading && !searchQuery ? (
                <div className="flex justify-center py-4"><i className="fa-solid fa-circle-notch fa-spin text-slate-600"></i></div>
            ) : filteredUsers.length > 0 ? (
                filteredUsers.map(u => (
                    <div 
                        key={u.id} 
                        onClick={() => { setSelectedUser(u); changeView('chat'); }}
                        className={`p-3 rounded-xl cursor-pointer flex items-center gap-3.5 transition-all group ${selectedUser?.id === u.id && view === 'chat' ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/20' : 'hover:bg-slate-700/50 text-slate-300'}`}
                    >
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 ${selectedUser?.id === u.id && view === 'chat' ? 'bg-white/20 border-white/20' : 'bg-slate-800 border-slate-700'}`}>
                            {u.name.substring(0,2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold truncate">{u.name}</div>
                            <div className={`text-xs truncate ${selectedUser?.id === u.id && view === 'chat' ? 'text-violet-200' : 'text-slate-500 group-hover:text-slate-400'}`}>{u.email}</div>
                        </div>
                   </div>
                ))
            ) : (
                <div className="text-center py-8 text-slate-600 text-sm italic">
                    {searchQuery ? 'No se encontraron usuarios.' : 'No hay nadie más aquí...'}
                </div>
            )}
        </div>

        <div className="p-4 border-t border-slate-700/50 flex items-center gap-3 shrink-0 bg-[#162032]">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center font-bold text-sm text-white shadow-lg">
            {user?.name?.substring(0,2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate text-white">{user?.name}</div>
            <div className="text-xs text-emerald-500 flex items-center gap-1.5 font-medium"><span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span> En línea</div>
            </div>
            <button 
                onClick={() => {
                    setName(user.name); // Pre-fill name for editing
                    changeView('profile');
                    setSelectedUser(null);
                }}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition"
            >
                <i className="fa-solid fa-gear"></i>
            </button>
        </div>
    </aside>
  );

  const renderProfile = () => (
    <main className="flex-1 flex flex-col bg-[#0f172a] relative overflow-hidden items-center justify-center p-6">
        <div className="absolute inset-0 opacity-[0.02]" style={{backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '32px 32px'}}></div>
        
        <div className="w-full max-w-lg bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl p-8 relative z-10 animate-fade-in">
            <button onClick={() => changeView('chat')} className="absolute top-6 right-6 text-slate-400 hover:text-white transition">
                <i className="fa-solid fa-xmark text-xl"></i>
            </button>
            
            <div className="text-center mb-8">
                <div className="w-24 h-24 mx-auto bg-gradient-to-br from-emerald-500 to-teal-500 rounded-full flex items-center justify-center text-3xl font-bold text-white shadow-2xl shadow-emerald-500/20 mb-4 ring-4 ring-slate-900">
                    {user?.name?.substring(0,2).toUpperCase()}
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
                            value={name} // Uses the shared name state
                            onChange={e => setName(e.target.value)}
                            placeholder="Escribe tu nombre"
                            required
                        />
                        <button type="button" className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"><i className="fa-solid fa-pen"></i></button>
                    </div>
                </div>
                
                <button 
                    type="submit" 
                    disabled={loading || name === user.name}
                    className="w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl hover:bg-slate-200 transition-all transform active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                >
                    {loading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : 'Guardar Cambios'}
                </button>
            </form>
        </div>
    </main>
  );

  if (view === 'login' || view === 'register') return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans antialiased text-sm">
      {alert.show && <CustomAlert type={alert.type} message={alert.message} onClose={closeAlert} />}
      {renderAuth()}
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-[#0f172a] text-white font-sans antialiased text-sm overflow-hidden">
      {alert.show && <CustomAlert type={alert.type} message={alert.message} onClose={closeAlert} />}
      
      {renderSidebar()}
      
      {view === 'profile' ? renderProfile() : (
        <main className="flex-1 flex flex-col bg-[#0f172a] relative">
            <div className="absolute inset-0 opacity-[0.03]" style={{backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '32px 32px'}}></div>
            
            {selectedUser ? (
                <>
                <header className="h-20 border-b border-slate-700/50 flex items-center justify-between px-8 bg-[#0f172a]/80 backdrop-blur z-20 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-sm font-bold text-white shadow-lg border border-white/10">
                            {selectedUser.name.substring(0,2).toUpperCase()}
                        </div>
                        <div>
                        <h3 className="text-base font-bold text-white">{selectedUser.name}</h3>
                        <span className="flex items-center gap-2 text-xs text-emerald-400 font-medium"><span className="w-1.5 h-1.5 bg-emerald-400 rounded-full inline-block animate-pulse"></span> En línea</span>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition"><i className="fa-solid fa-phone"></i></button>
                        <button className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition"><i className="fa-solid fa-video"></i></button>
                    </div>
                </header>

                <div className="flex-1 overflow-y-auto p-8 space-y-6 z-10 custom-scrollbar relative">
                    {loading && messages.length === 0 ? (
                        <div className="h-full flex items-center justify-center opacity-50"><i className="fa-solid fa-circle-notch fa-spin text-3xl text-violet-500"></i></div>
                    ) : currentChatMessages.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-500 pb-20 animate-fade-in">
                            <div className="w-20 h-20 rounded-full bg-slate-800/50 flex items-center justify-center text-3xl mb-6 border border-slate-700/50">
                                <i className="fa-regular fa-hand-spock text-violet-400"></i>
                            </div>
                            <p className="text-lg">Saluda a <strong className="text-white">{selectedUser.name}</strong></p>
                            <p className="text-sm mt-2 opacity-60">Comienza a escribir para romper el hielo</p>
                        </div>
                    ) : (
                        currentChatMessages.map((msg, i) => {
                            const isMe = msg.from_id === user.id;
                            const isLast = i === currentChatMessages.length - 1;
                            const reactions = msg.reactions || {};
                            const hasReactions = Object.keys(reactions).length > 0;
                            
                            return (
                                <div key={i} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${isLast ? 'animate-slide-up' : ''} mb-4 group relative`}>
                                    {/* Message Bubble */}
                                    <div className={`max-w-[70%] relative ${isMe ? 'rounded-2xl rounded-tr-sm' : 'rounded-2xl rounded-tl-sm'} shadow-md transition-all hover:shadow-lg`}>
                                        
                                        {/* Content */}
                                        <div className={`px-5 py-3 text-sm leading-relaxed break-words overflow-hidden rounded-inherit ${
                                            isMe 
                                            ? 'bg-gradient-to-br from-violet-600 to-indigo-600 text-white' 
                                            : 'bg-slate-800 border border-slate-700/50 text-slate-200'
                                        }`}>
                                            {msg.type === 'image' ? (
                                                <div className="space-y-2">
                                                    <img src={msg.content} alt="Compartido" className="max-w-full rounded-lg max-h-[300px] object-cover bg-black/20" />
                                                    {!isMe && (
                                                        <a href={msg.content} download={`fluxchat_image_${Date.now()}.png`} className="flex items-center gap-2 text-xs opacity-70 hover:opacity-100 transition p-1">
                                                            <i className="fa-solid fa-download"></i> Descargar
                                                        </a>
                                                    )}
                                                </div>
                                            ) : (
                                                msg.content
                                            )}
                                        </div>

                                        {/* Reaction Button (Show on hover) */}
                                        <div className={`absolute top-1/2 -translate-y-1/2 ${isMe ? '-left-10' : '-right-10'} opacity-0 group-hover:opacity-100 transition-opacity`}>
                                            <div className="relative">
                                                <button 
                                                    onClick={() => setActiveReactionMessageId(activeReactionMessageId === msg.id ? null : msg.id)}
                                                    className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 hover:text-yellow-400 hover:scale-110 transition shadow-lg"
                                                >
                                                    <i className="fa-regular fa-face-smile"></i>
                                                </button>
                                                {/* Quick Reaction Menu */}
                                                {activeReactionMessageId === msg.id && (
                                                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 p-2 rounded-full flex gap-1 shadow-xl z-50 animate-fade-in">
                                                        {['👍','❤️','😂','😮','😢','😡'].map(emoji => (
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

                                        {/* Reactions Display */}
                                        {hasReactions && (
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
                                </div>
                            );
                        })
                    )}
                    <div ref={messagesEndRef} />
                </div>

                <div className="p-6 border-t border-slate-700/50 shrink-0 z-20 bg-[#0f172a] relative">
                    {/* Emoji Picker Popover */}
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
                        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                    >
                        <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} className={`transition p-2 rounded-lg hover:bg-slate-800 ${showEmojiPicker ? 'text-violet-400 bg-slate-800' : 'text-slate-500 hover:text-violet-400'}`}>
                            <i className="fa-regular fa-smile text-lg"></i>
                        </button>
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="text-slate-500 hover:text-violet-400 transition p-2 rounded-lg hover:bg-slate-800">
                            <i className="fa-solid fa-paperclip text-lg"></i>
                        </button>
                        <input 
                            className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-slate-500 font-medium ml-2" 
                            placeholder="Escribe un mensaje..." 
                            value={inputMsg}
                            onChange={e => setInputMsg(e.target.value)}
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
                    <p className="text-slate-400 max-w-xs mx-auto leading-relaxed">Selecciona un usuario de la lista izquierda para iniciar una conversación encriptada.</p>
                </div>
            )}
        </main>
      )}
    </div>
  )
}

export default App

