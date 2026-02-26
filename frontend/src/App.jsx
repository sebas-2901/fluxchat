import { useState, useEffect, useRef } from 'react'
import io from 'socket.io-client'

function App() {
  const [view, setView] = useState('login'); // login, register, chat
  const [user, setUser] = useState(null); // { id, name, email, token }
  const [users, setUsers] = useState([]); // Array of users
  const [selectedUser, setSelectedUser] = useState(null); // User to chat with
  const [messages, setMessages] = useState([]); // Current conversation messages
  const [inputMsg, setInputMsg] = useState('');
  
  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  
  const socketRef = useRef(null);

  // Initialize socket on login
  useEffect(() => {
    if (user?.token) {
      // Connect to the same host (relies on proxy in vite.config.js for /socket.io)
      const newSocket = io({
        auth: { token: user.token }
      });
      
      socketRef.current = newSocket;

      newSocket.on('private_message', (msg) => {
        setMessages(prev => [...prev, msg]);
      });

      return () => newSocket.disconnect();
    }
  }, [user]);

  // Fetch users when entering chat
  useEffect(() => {
    if (view === 'chat' && user) {
        fetch('/api/users')
            .then(res => res.json())
            .then(data => {
                // Filter out myself
                setUsers(data.filter(u => u.id !== user.id));
            })
            .catch(err => console.error(err));
    }
  }, [view, user]);

  // Fetch conversation when selecting user
  useEffect(() => {
    if (selectedUser && user) {
        setMessages([]);
        fetch(`/api/messages/${user.id}/${selectedUser.id}`)
            .then(res => res.json())
            .then(data => setMessages(data))
            .catch(err => console.error(err));
    }
  }, [selectedUser, user]);

  // Handle browser back button
  useEffect(() => {
    // Initial state
    window.history.replaceState({ view: 'login' }, '');

    const handlePopState = (event) => {
      if (event.state && event.state.view) {
        setView(event.state.view);
      } else {
        setView('login');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Update history when view changes
  const changeView = (newView) => {
    setView(newView);
    window.history.pushState({ view: newView }, '', newView === 'login' ? '/' : `/#${newView}`);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const data = await res.json();
      if (res.ok) {
        setUser(data);
        changeView('chat');
      } else {
        alert(data.error || 'Error registering');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (res.ok) {
            setUser(data);
            changeView('chat');
        } else {
            alert(data.error || 'Error logging in');
        }
    } catch(err) {
        console.error(err);
    }
  };

  const sendMessage = () => {
    if (!inputMsg.trim() || !selectedUser || !socketRef.current) return;
    
    socketRef.current.emit('private_message', {
        to: selectedUser.id,
        content: inputMsg
    });
    
    setInputMsg('');
  };

  const currentChatMessages = messages.filter(m => 
    (m.from_id === user?.id && m.to_id === selectedUser?.id) ||
    (m.from_id === selectedUser?.id && m.to_id === user?.id)
  );

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-white font-sans antialiased text-sm">
      {/* Auth Screen */}
      {(view === 'login' || view === 'register') && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 z-50">
          <div className="w-full max-w-md p-8 bg-zinc-900 rounded-xl border border-zinc-800 shadow-xl">
            <div className="text-center mb-8">
              <div className="w-12 h-12 bg-white text-black rounded-lg flex items-center justify-center mx-auto mb-4 text-xl font-bold">
                <i className="fa-solid fa-bolt"></i>
              </div>
              <h1 className="text-2xl font-bold">FluxChat</h1>
              <p className="text-zinc-500 mt-2">Bienvenido de nuevo</p>
            </div>

            {view === 'login' ? (
              <form className="space-y-4" onSubmit={handleLogin}>
                <div>
                  <label className="block text-xs font-medium mb-1 text-zinc-400 uppercase tracking-wider">Email</label>
                  <input 
                    className="w-full p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-white focus:ring-1 focus:ring-white outline-none transition" 
                    type="email" 
                    placeholder="name@example.com" 
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 text-zinc-400 uppercase tracking-wider">Password</label>
                  <input 
                    className="w-full p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-white focus:ring-1 focus:ring-white outline-none transition" 
                    type="password" 
                    placeholder="••••••••" 
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="w-full py-2.5 bg-white text-black font-semibold rounded-lg hover:bg-gray-200 transition mt-2">Iniciar Sesión</button>
                <p className="text-center text-sm text-zinc-500 mt-4">
                  ¿No tienes cuenta? <button type="button" onClick={() => changeView('register')} className="text-white hover:underline font-medium ml-1">Regístrate</button>
                </p>
              </form>
            ) : (
              <form className="space-y-4" onSubmit={handleRegister}>
                <div>
                    <label className="block text-xs font-medium mb-1 text-zinc-400 uppercase tracking-wider">Nombre</label>
                    <input 
                        className="w-full p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-white focus:ring-1 focus:ring-white outline-none transition" 
                        type="text" 
                        placeholder="Tu nombre"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        required
                    />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 text-zinc-400 uppercase tracking-wider">Email</label>
                  <input 
                    className="w-full p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-white focus:ring-1 focus:ring-white outline-none transition" 
                    type="email" 
                    placeholder="name@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 text-zinc-400 uppercase tracking-wider">Password</label>
                  <input 
                    className="w-full p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 focus:border-white focus:ring-1 focus:ring-white outline-none transition" 
                    type="password" 
                    placeholder="••••••••" 
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="w-full py-2.5 bg-white text-black font-semibold rounded-lg hover:bg-gray-200 transition mt-2">Crear Cuenta</button>
                <p className="text-center text-sm text-zinc-500 mt-4">
                  ¿Ya tienes cuenta? <button type="button" onClick={() => changeView('login')} className="text-white hover:underline font-medium ml-1">Inicia Sesión</button>
                </p>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Chat Interface */}
      {view === 'chat' && (
        <div className="flex w-full h-full">
          {/* Sidebar */}
          <aside className="w-80 bg-zinc-900 border-r border-zinc-800 flex flex-col">
            <div className="h-16 border-b border-zinc-800 flex items-center justify-between px-4 shrink-0">
              <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
                <div className="w-7 h-7 bg-white text-black rounded-lg flex items-center justify-center text-sm">
                  <i className="fa-solid fa-bolt"></i>
                </div>
                FluxChat
              </div>
              <button className="p-2 text-zinc-400 hover:text-white transition"><i className="fa-regular fa-pen-to-square"></i></button>
            </div>
            
            <div className="p-4 shrink-0">
              <div className="relative group">
                <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-white transition text-xs"></i>
                <input className="w-full bg-zinc-800/50 border border-transparent focus:border-zinc-700 rounded-lg px-9 py-2 text-sm outline-none text-white placeholder-zinc-500 transition" placeholder="Buscar..." />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2">
              <div className="text-xs font-bold text-zinc-500 px-3 py-2 uppercase tracking-wider">Usuarios Disponibles</div>
              <div className="space-y-1">
                {users.map(u => (
                    <div 
                        key={u.id} 
                        onClick={() => setSelectedUser(u)}
                        className={`p-2 mx-1 rounded-lg cursor-pointer flex items-center gap-3 transition ${selectedUser?.id === u.id ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-800/50 text-zinc-300'}`}
                    >
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 flex items-center justify-center text-xs font-bold border border-zinc-700">
                            {u.name.substring(0,2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{u.name}</div>
                            <div className="text-xs text-zinc-500 truncate">{u.email}</div>
                        </div>
                    </div>
                ))}
                {users.length === 0 && <div className="px-4 py-8 text-center text-zinc-600 text-sm">No hay otros usuarios...</div>}
              </div>
            </div>

            <div className="p-4 border-t border-zinc-800 flex items-center gap-3 shrink-0 bg-zinc-900">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-xs ring-2 ring-zinc-900">
                {user?.name?.substring(0,2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{user?.name}</div>
                <div className="text-xs text-green-500 flex items-center gap-1.5"><span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span> En línea</div>
              </div>
              <button className="text-zinc-400 hover:text-white transition p-2"><i className="fa-solid fa-gear"></i></button>
            </div>
          </aside>

          {/* Main Chat */}
          <main className="flex-1 flex flex-col bg-zinc-950 relative overflow-hidden">
            {/* Background Pattern */}
            <div className="absolute inset-0 opacity-[0.03]" style={{backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '24px 24px'}}></div>

            {selectedUser ? (
                <>
                <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/80 backdrop-blur z-10 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 flex items-center justify-center text-xs font-bold border border-zinc-700">
                        {selectedUser.name.substring(0,2).toUpperCase()}
                    </div>
                    <div>
                    <h3 className="text-sm font-bold">{selectedUser.name}</h3>
                    <span className="flex items-center gap-1.5 text-xs text-zinc-500"><span className="w-1.5 h-1.5 bg-green-500 rounded-full inline-block"></span> En línea</span>
                    </div>
                </div>
                <div className="flex gap-1">
                    <button className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition"><i className="fa-solid fa-phone"></i></button>
                    <button className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition"><i className="fa-solid fa-video"></i></button>
                    <button className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition"><i className="fa-solid fa-circle-info"></i></button>
                </div>
                </header>

                <div className="flex-1 overflow-y-auto p-6 space-y-4 z-0">
                {currentChatMessages.length === 0 && (
                     <div className="h-full flex flex-col items-center justify-center text-zinc-600 pb-10">
                        <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center text-2xl mb-4 border border-zinc-800">
                            <i className="fa-regular fa-hand-spock"></i>
                        </div>
                        <p>Saluda a <strong>{selectedUser.name}</strong></p>
                     </div>
                )}
                {currentChatMessages.map((msg, i) => {
                    const isMe = msg.from_id === user.id;
                    return (
                        <div key={i} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                            <div className={`${isMe ? 'bg-white text-black rounded-tr-sm shadow-md' : 'bg-zinc-800 text-white rounded-tl-sm shadow-sm border border-zinc-700'} px-4 py-2.5 rounded-2xl max-w-[70%] text-sm break-words leading-relaxed`}>
                            {msg.content}
                            </div>
                        </div>
                    );
                })}
                </div>

                <div className="p-4 border-t border-zinc-800 shrink-0 z-10 bg-zinc-950">
                <form 
                    className="flex items-center gap-3 bg-zinc-900 p-2 rounded-full border border-zinc-800 focus-within:border-zinc-600 transition shadow-inner"
                    onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                >
                    <button type="button" className="w-9 h-9 rounded-full flex items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-white transition">
                    <i className="fa-solid fa-plus"></i>
                    </button>
                    <input 
                        className="flex-1 bg-transparent border-none outline-none text-sm px-2 text-white placeholder-zinc-500" 
                        placeholder="Escribe un mensaje..." 
                        value={inputMsg}
                        onChange={e => setInputMsg(e.target.value)}
                    />
                    <button type="submit" disabled={!inputMsg.trim()} className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed">
                    <i className="fa-solid fa-paper-plane text-xs"></i>
                    </button>
                </form>
                </div>
                </>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 z-0">
                    <div className="w-20 h-20 bg-zinc-900 rounded-2xl flex items-center justify-center mb-6 border border-zinc-800 transform rotate-3 shadow-2xl">
                        <i className="fa-regular fa-comments text-4xl text-zinc-700"></i>
                    </div>
                    <h2 className="text-xl font-bold text-white mb-2">Tu bandeja de entrada</h2>
                    <p className="text-zinc-600">Selecciona un usuario para comenzar a chatear</p>
                </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

export default App

