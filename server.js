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
  maxHttpBufferSize: 1e8, // 100 MB
});

const PORT = process.env.PORT || 4000;
const sessions = {}; // { sessionCode: { host: socket, clients: [socket, ...], audio: {url, name, size, type} } }
const clientHeartbeats = new Map(); // Track client heartbeats for cleanup
const clientReadiness = new Map(); // Track client readiness: { sessionCode: Set<clientId> }
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CLIENT_TIMEOUT = 90000; // 90 seconds - client considered disconnected if no heartbeat

// Health check endpoints for Render
app.get("/", (req, res) => res.send("Audionize Sync Server is running!"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));
app.get("/status", (req, res) =>
  res.json({
    status: "running",
    activeSessions: Object.keys(sessions).length,
    sessions: Object.keys(sessions).map((sessionCode) => ({
      sessionCode,
      host: sessions[sessionCode].host?.name || null,
      clientCount: sessions[sessionCode].clients.length,
      clients: sessions[sessionCode].clients.map((c) => ({
        id: c.id,
        name: c.name,
      })),
      hasAudio: !!sessions[sessionCode].audio,
      createdAt: sessions[sessionCode].createdAt,
    })),
    timestamp: new Date().toISOString(),
  })
);

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
  // Set up heartbeat for this socket
  socket.heartbeat = Date.now();
  clientHeartbeats.set(socket.id, Date.now());

  // Handle heartbeat from clients
  socket.on("heartbeat", () => {
    socket.heartbeat = Date.now();
    clientHeartbeats.set(socket.id, Date.now());
  });

  socket.on("join", ({ session, role, name }) => {
    console.log(
      `[JOIN-ATTEMPT] ${role} (${name}) attempting to join session ${session}`
    );

    // Validate input
    if (!session || !role || !name) {
      console.error(`[JOIN-ERROR] Invalid join data:`, { session, role, name });
      return;
    }

    socket.session = session;
    socket.role = role;
    socket.name = name;
    socket.join(session);

    // Initialize session if it doesn't exist
    if (!sessions[session]) {
      sessions[session] = {
        clients: [],
        host: null,
        audio: null,
        createdAt: Date.now(),
      };
      console.log(`[SESSION-CREATED] New session ${session} created`);
    }

    // Remove any existing connection for this socket ID
    if (role === "host") {
      // If there's already a host, disconnect them
      if (sessions[session].host && sessions[session].host.id !== socket.id) {
        console.log(
          `[HOST-REPLACE] Replacing existing host in session ${session}`
        );
        sessions[session].host.socket.disconnect(true);
      }
      sessions[session].host = { id: socket.id, name, socket };
      console.log(`[HOST-JOINED] Host (${name}) joined session ${session}`);

      // Send existing audio to new host
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio);
      }
    } else {
      // Remove any existing client with same ID
      sessions[session].clients = sessions[session].clients.filter(
        (c) => c.id !== socket.id
      );

      // Add new client
      sessions[session].clients.push({ id: socket.id, name, socket });
      console.log(
        `[CLIENT-JOINED] Client (${name}) joined session ${session}. Total clients: ${sessions[session].clients.length}`
      );

      // Send existing audio to new client
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
        socket.emit("audio_sync", sessions[session].audio);
      }

      // Notify host about new client
      if (sessions[session].host) {
        sessions[session].host.socket.emit("user-joined", {
          name,
          id: socket.id,
        });
      }
    }

    // Broadcast updated presence to all clients in session
    const clientList = sessions[session].clients.map((c) => ({
      id: c.id,
      name: c.name,
    }));

    io.to(session).emit("presence-update", {
      host: sessions[session].host?.name,
      clients: clientList,
    });

    console.log(
      `[JOIN-SUCCESS] ${role} (${name}) successfully joined session ${session}`
    );
    console.log(
      `[SESSION-STATUS] Session ${session}: Host=${sessions[session].host?.name}, Clients=${sessions[session].clients.length}`
    );
  });

  socket.on("audio_upload", (audio) => {
    if (socket.session && sessions[socket.session]) {
      console.log(
        `[AUDIO-UPLOAD] Received audio upload from ${socket.id} (size: ${
          audio?.fileSize || "unknown"
        })`
      );
      // Optional: Validate file size (reject if >100MB)
      if (audio && audio.fileSize && audio.fileSize > 100 * 1024 * 1024) {
        socket.emit("audio-upload-error", {
          message: "File too large (max 100MB)",
        });
        return;
      }
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

  // Optimized command forwarding for millisecond precision
  [
    "play_command",
    "pause_command",
    "seek_command",
    "volume_command",
    "sync_all_command",
  ].forEach((event) => {
    socket.on(event, (data) => {
      if (socket.session) {
        // Add timestamp for tracking
        const enhancedData = {
          ...data,
          serverTimestamp: Date.now(),
          originalTimestamp: data.timestamp,
        };

        // Forward immediately without any processing delay
        socket.to(socket.session).emit(event, enhancedData);

        // Log for debugging (optional)
        if (event === "play_command") {
          console.log(
            `[${event.toUpperCase()}] Forwarded to ${
              sessions[socket.session].clients.length
            } clients`
          );
        }
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

  // Handle client readiness for better sync
  socket.on("client-ready", () => {
    if (socket.session) {
      // Initialize readiness tracking for this session if not exists
      if (!clientReadiness.has(socket.session)) {
        clientReadiness.set(socket.session, new Set());
      }

      const readyClients = clientReadiness.get(socket.session);
      readyClients.add(socket.id);

      console.log(
        `[CLIENT-READY] ${socket.name} (${socket.id}) ready in session ${socket.session}`
      );

      // Check if all clients in the session are ready
      const session = sessions[socket.session];
      if (session && session.clients.length > 0) {
        const allClientsReady = session.clients.every((client) =>
          readyClients.has(client.id)
        );

        if (allClientsReady && session.host) {
          console.log(
            `[ALL-CLIENTS-READY] Session ${socket.session} - all clients ready`
          );
          session.host.socket.emit("all-clients-ready", {
            sessionCode: socket.session,
            readyClients: Array.from(readyClients),
          });
        }
      }
    }
  });

  socket.on("client-not-ready", () => {
    if (socket.session) {
      const readyClients = clientReadiness.get(socket.session);
      if (readyClients) {
        readyClients.delete(socket.id);
        console.log(
          `[CLIENT-NOT-READY] ${socket.name} (${socket.id}) not ready in session ${socket.session}`
        );
      }
    }
  });

  socket.on("disconnect", () => {
    // Clean up heartbeat tracking
    clientHeartbeats.delete(socket.id);

    // Clean up readiness tracking
    if (socket.session) {
      const readyClients = clientReadiness.get(socket.session);
      if (readyClients) {
        readyClients.delete(socket.id);
        // Remove session from readiness tracking if no clients left
        if (readyClients.size === 0) {
          clientReadiness.delete(socket.session);
        }
      }
    }

    if (socket.session && sessions[socket.session]) {
      console.log(
        `[DISCONNECT] ${socket.role} (${socket.name}) disconnecting from session ${socket.session}`
      );

      // Remove client from session
      if (socket.role === "client") {
        const initialClientCount = sessions[socket.session].clients.length;
        sessions[socket.session].clients = sessions[
          socket.session
        ].clients.filter((c) => c.id !== socket.id);
        const finalClientCount = sessions[socket.session].clients.length;

        if (initialClientCount !== finalClientCount) {
          console.log(
            `[CLIENT-LEFT] Client (${socket.name}) left session ${socket.session}. Clients: ${finalClientCount}`
          );

          // Notify host about client leaving
          if (sessions[socket.session].host) {
            sessions[socket.session].host.socket.emit("user-left", {
              name: socket.name,
              id: socket.id,
              role: socket.role,
            });
          }
        }
      }

      // Handle host disconnection
      if (
        socket.role === "host" &&
        sessions[socket.session].host?.id === socket.id
      ) {
        console.log(
          `[HOST-LEFT] Host (${socket.name}) left session ${socket.session}`
        );

        // Notify all clients in the session
        io.to(socket.session).emit("host_disconnect", {
          message: "Host has disconnected. Session ended.",
        });
        sessions[socket.session].host = null;
      }

      // Update presence for remaining clients
      const clientList = sessions[socket.session].clients.map((c) => ({
        id: c.id,
        name: c.name,
      }));

      io.to(socket.session).emit("presence-update", {
        host: sessions[socket.session].host?.name,
        clients: clientList,
      });

      // Clean up empty sessions
      if (
        !sessions[socket.session].host &&
        sessions[socket.session].clients.length === 0
      ) {
        console.log(
          `[SESSION-CLEANUP] Removing empty session ${socket.session}`
        );
        delete sessions[socket.session];
      } else {
        console.log(
          `[SESSION-STATUS] Session ${socket.session}: Host=${
            sessions[socket.session].host?.name
          }, Clients=${sessions[socket.session].clients.length}`
        );
      }
    }
  });
});

// Heartbeat cleanup mechanism
setInterval(() => {
  const now = Date.now();
  const disconnectedClients = [];

  // Check for stale clients
  for (const [clientId, lastHeartbeat] of clientHeartbeats.entries()) {
    if (now - lastHeartbeat > CLIENT_TIMEOUT) {
      disconnectedClients.push(clientId);
    }
  }

  // Clean up disconnected clients
  disconnectedClients.forEach((clientId) => {
    const socket = io.sockets.sockets.get(clientId);
    if (socket) {
      console.log(
        `[HEARTBEAT-TIMEOUT] Client ${clientId} timed out, forcing disconnect`
      );
      socket.disconnect(true);
    }
    clientHeartbeats.delete(clientId);
  });

  // Log cleanup stats
  if (disconnectedClients.length > 0) {
    console.log(
      `[HEARTBEAT-CLEANUP] Cleaned up ${disconnectedClients.length} stale clients`
    );
  }
}, HEARTBEAT_INTERVAL);

server.listen(PORT, () => {
  console.log(`Audionize Sync Server started on port ${PORT}`);
  console.log(`Heartbeat cleanup running every ${HEARTBEAT_INTERVAL}ms`);
});
