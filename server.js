const http = require("http");
const { Server: IOServer } = require("socket.io");
const WebSocket = require("ws");

const server = http.createServer();
const io = new IOServer(server, {
  path: "/socket.io",
  cors: {
    origin: "https://audionize.netlify.app",
    methods: ["GET", "POST"],
  },
});
const wss = new WebSocket.Server({ server, path: "/ws" });

const sessions = {}; // { sessionCode: { host, clients, audioUrl, ... } }

// --- WebSocket (LAN) ---
wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }
    // Example: { type: 'join', session: 'ABC123', role: 'host'|'client', ... }
    if (data.type === "join") {
      ws.session = data.session;
      ws.role = data.role;
      ws.name = data.name;
      sessions[data.session] = sessions[data.session] || {
        clients: [],
        host: null,
        audioData: null,
      };
      if (data.role === "host") {
        sessions[data.session].host = ws;
      } else {
        sessions[data.session].clients.push(ws);
        // Notify host about new client
        if (sessions[data.session].host) {
          sessions[data.session].host.send(
            JSON.stringify({
              type: "client_joined",
              clientId: ws.id || Date.now(),
              clientName: data.name,
              timestamp: Date.now(),
            })
          );
        }
      }
    }
    // Broadcast sync/play/pause/etc. to all in session
    if (data.type === "sync" && ws.session) {
      const session = sessions[ws.session];
      if (session) {
        (session.clients || []).forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN)
            client.send(msg);
        });
      }
    }
  });
  ws.on("close", () => {
    // Remove from session
    if (ws.session && sessions[ws.session]) {
      sessions[ws.session].clients = (
        sessions[ws.session].clients || []
      ).filter((c) => c !== ws);
      if (sessions[ws.session].host === ws) sessions[ws.session].host = null;

      // Notify host about client leaving
      if (ws.role === "client" && sessions[ws.session].host) {
        sessions[ws.session].host.send(
          JSON.stringify({
            type: "client_left",
            clientId: ws.id || Date.now(),
            clientName: ws.name,
            timestamp: Date.now(),
          })
        );
      }
    }
  });
});

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
  console.log("Socket.IO client connected:", socket.id);

  // Handle ping for latency measurement
  socket.on("ping", (data) => {
    socket.emit("pong", {
      sentTime: data.sentTime,
      serverTime: Date.now(),
    });
  });

  socket.on("join", ({ session, role, name }) => {
    socket.session = session;
    socket.role = role;
    socket.name = name;
    socket.join(session);

    // Track host/client in memory for this session
    sessions[session] = sessions[session] || {
      clients: [],
      host: null,
      audio: null,
    };
    if (role === "host") {
      sessions[session].host = { id: socket.id, name, socket };
      // If audio already uploaded, send to host
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio); // for client compatibility
      }
    } else {
      sessions[session].clients.push({ id: socket.id, name, socket });
      // If audio already uploaded, send to new client
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio); // for client compatibility
      }
      // Notify host
      if (sessions[session].host) {
        sessions[session].host.socket.emit("user-joined", {
          name,
          id: socket.id,
        });
      }
    }

    // Notify all clients of updated presence
    const clientList = sessions[session].clients.map((c) => ({
      id: c.id,
      name: c.name,
    }));
    io.to(session).emit("presence-update", {
      host: sessions[session].host?.name,
      clients: clientList,
    });
    console.log(`[JOIN] ${role} (${name}) joined session ${session}`);
  });

  socket.on("audio_upload", (audio) => {
    if (socket.session && sessions[socket.session]) {
      sessions[socket.session].audio = audio;
      // Broadcast to all clients (except sender)
      socket.to(socket.session).emit("audio-uploaded", audio);
      socket.to(socket.session).emit("audio_sync", audio); // for client compatibility
      // Also send to host if not sender
      if (
        sessions[socket.session].host &&
        sessions[socket.session].host.id !== socket.id
      ) {
        sessions[socket.session].host.socket.emit("audio-uploaded", audio);
        sessions[socket.session].host.socket.emit("audio_sync", audio);
      }
    }
  });

  [
    "play_command",
    "pause_command",
    "seek_command",
    "volume_command",
    "sync_all_command",
  ].forEach((event) => {
    socket.on(event, (data) => {
      if (socket.session) {
        socket.to(socket.session).emit(event, data);
      }
    });
  });

  socket.on("mic-status", ({ isMuted }) => {
    if (socket.session) {
      io.to(socket.session).emit("mic-status-update", {
        userId: socket.id,
        name: socket.name,
        isMuted,
      });
    }
  });

  socket.on("mute-client", ({ clientId }) => {
    io.to(clientId).emit("muted");
  });

  socket.on("disconnect-client", ({ clientId }) => {
    io.to(clientId).emit("disconnected");
    // Optionally, force disconnect:
    const session = sessions[socket.session];
    if (session) {
      const clientIndex = session.clients.findIndex((c) => c.id === clientId);
      if (clientIndex !== -1) {
        const clientSocket = session.clients[clientIndex].socket;
        if (clientSocket) clientSocket.disconnect(true);
        session.clients.splice(clientIndex, 1);
        // Emit updated presence
        const clientList = session.clients.map((c) => ({
          id: c.id,
          name: c.name,
        }));
        io.to(socket.session).emit("presence-update", {
          host: session.host?.name,
          clients: clientList,
        });
        console.log(
          `[DISCONNECT-CLIENT] Client ${clientId} forcibly disconnected from session ${socket.session}`
        );
      }
    }
  });

  socket.on("disconnect", () => {
    if (socket.session && sessions[socket.session]) {
      // Remove from clients array by id
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c.id !== socket.id);

      if (sessions[socket.session].host?.id === socket.id) {
        sessions[socket.session].host = null;
      }

      // Notify all clients of updated presence
      const clientList = sessions[socket.session].clients.map((c) => ({
        id: c.id,
        name: c.name,
      }));
      io.to(socket.session).emit("presence-update", {
        host: sessions[socket.session].host?.name,
        clients: clientList,
      });

      socket
        .to(socket.session)
        .emit("user-left", { name: socket.name, role: socket.role });

      // Clean up session if empty
      if (
        !sessions[socket.session].host &&
        sessions[socket.session].clients.length === 0
      ) {
        delete sessions[socket.session];
      }
      console.log(
        `[LEAVE] ${socket.role} (${socket.name}) left session ${socket.session}`
      );
    }
  });
});

// Health check endpoints for Render
server.on("request", (req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Audionize Sync Server is running!");
  } else if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "running",
        activeSessions: Object.keys(sessions).length,
        totalConnections: io.engine.clientsCount,
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Audionize Sync Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Socket.IO endpoint: http://localhost:${PORT}/socket.io`);
});
