const express = require("express");
const http = require("http");
const { Server: IOServer } = require("socket.io");

const app = express();

// --- CORS MIDDLEWARE AT THE VERY TOP ---
const allowedOrigins = [
  "https://audionize.netlify.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://localhost:3000",
  "https://127.0.0.1:3000",
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});
// --- END CORS MIDDLEWARE ---

const server = http.createServer(app);
const io = new IOServer(server, {
  path: "/socket.io",
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
});

const PORT = process.env.PORT || 4000;
const sessions = {}; // { sessionCode: { host: socket, clients: [socket, ...], audio: {url, name, size, type} } }

// Health check endpoints for Render
app.get("/", (req, res) => res.send("Audionize Sync Server is running!"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));
app.get("/status", (req, res) =>
  res.json({
    status: "running",
    activeSessions: Object.keys(sessions).length,
    timestamp: new Date().toISOString(),
  })
);

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
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
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio); // for client compatibility
      }
    } else {
      sessions[session].clients.push({ id: socket.id, name, socket });
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio); // for client compatibility
      }
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
      socket.to(socket.session).emit("audio-uploaded", audio);
      socket.to(socket.session).emit("audio_sync", audio);
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
    const session = sessions[socket.session];
    if (session) {
      const clientIndex = session.clients.findIndex((c) => c.id === clientId);
      if (clientIndex !== -1) {
        const clientSocket = session.clients[clientIndex].socket;
        if (clientSocket) clientSocket.disconnect(true);
        session.clients.splice(clientIndex, 1);
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
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c.id !== socket.id);

      if (sessions[socket.session].host?.id === socket.id) {
        sessions[socket.session].host = null;
      }

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

server.listen(PORT, () => {
  console.log(`Audionize Sync Server started on port ${PORT}`);
});
