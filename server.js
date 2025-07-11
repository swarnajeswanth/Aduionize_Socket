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

  socket.on("join", ({ session, role, name }) => {
    console.log(`Client ${socket.id} joining session ${session} as ${role}`);
    socket.session = session;
    socket.role = role;
    socket.name = name;
    socket.join(session);

    sessions[session] = sessions[session] || {
      clients: [],
      host: null,
      audioData: null,
    };

    if (role === "host") {
      sessions[session].host = socket;
    } else {
      sessions[session].clients.push(socket);
      // Notify host about new client
      socket.to(session).emit("client_joined", {
        clientId: socket.id,
        clientName: name,
        timestamp: Date.now(),
      });
    }
  });

  socket.on("audio_upload", (data) => {
    console.log("Audio upload received for session:", data.sessionCode);
    if (socket.session) {
      // Store audio data in session
      sessions[socket.session].audioData = data;
      // Broadcast to all clients in session
      socket.to(socket.session).emit("audio_sync", data);
    }
  });

  socket.on("play_command", (data) => {
    console.log("Play command received for session:", data.sessionCode);
    if (socket.session) {
      socket.to(socket.session).emit("play_command", data);
    }
  });

  socket.on("pause_command", (data) => {
    console.log("Pause command received for session:", data.sessionCode);
    if (socket.session) {
      socket.to(socket.session).emit("pause_command", data);
    }
  });

  socket.on("seek_command", (data) => {
    console.log("Seek command received for session:", data.sessionCode);
    if (socket.session) {
      socket.to(socket.session).emit("seek_command", data);
    }
  });

  socket.on("volume_command", (data) => {
    console.log("Volume command received for session:", data.sessionCode);
    if (socket.session) {
      socket.to(socket.session).emit("volume_command", data);
    }
  });

  socket.on("sync_all_command", (data) => {
    console.log("Sync all command received for session:", data.sessionCode);
    if (socket.session) {
      socket.to(socket.session).emit("sync_all_command", data);
    }
  });

  socket.on("time_update", (data) => {
    if (socket.session) {
      // Forward time update to host
      socket.to(socket.session).emit("time_update", {
        ...data,
        clientId: socket.id,
        clientName: socket.name,
      });
    }
  });

  socket.on("sync", (data) => {
    if (socket.session) {
      socket.to(socket.session).emit("sync", data);
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket.IO client disconnected:", socket.id);
    if (socket.session && sessions[socket.session]) {
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c !== socket);
      if (sessions[socket.session].host === socket)
        sessions[socket.session].host = null;

      // Notify host about client leaving
      if (socket.role === "client") {
        socket.to(socket.session).emit("client_left", {
          clientId: socket.id,
          clientName: socket.name,
          timestamp: Date.now(),
        });
      }
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
