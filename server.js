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
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  transports: ["websocket", "polling"], // Prefer WebSocket, fallback to polling
});

const PORT = process.env.PORT || 4000;
const sessions = {}; // { sessionCode: { host: socket, clients: [socket, ...], audio: {url, name, size, type} } }
const clientHeartbeats = new Map(); // Track client heartbeats for cleanup
const clientReadiness = new Map(); // Track client readiness: { sessionCode: Set<clientId> }
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CLIENT_TIMEOUT = 90000; // 90 seconds - client considered disconnected if no heartbeat
const SESSION_CLEANUP_INTERVAL = 300000; // 5 minutes - clean up old sessions
const HOST_GRACE_PERIOD = 5 * 60 * 1000; // 5 minutes - grace period for host reconnection
const MAX_SESSIONS_PER_IP = 10; // Prevent abuse
const MAX_CLIENTS_PER_SESSION = 50; // Prevent overcrowding

// Add debouncing for play commands to prevent spam
const playCommandDebounce = new Map(); // { sessionCode: { lastCommand: timestamp, pending: false } }

// Rate limiting for connections
const connectionAttempts = new Map(); // { ip: { count: number, resetTime: timestamp } }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_CONNECTIONS_PER_MINUTE = 20;

// Input validation helpers
const validateSessionCode = (code) => {
  return (
    code &&
    typeof code === "string" &&
    code.length >= 4 &&
    code.length <= 20 &&
    /^[a-zA-Z0-9]+$/.test(code)
  );
};

const validateUserName = (name) => {
  return (
    name &&
    typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 50
  );
};

const validateRole = (role) => {
  return role === "host" || role === "client";
};

// Rate limiting helper
const checkRateLimit = (ip) => {
  const now = Date.now();
  const attempts = connectionAttempts.get(ip) || {
    count: 0,
    resetTime: now + RATE_LIMIT_WINDOW,
  };

  if (now > attempts.resetTime) {
    attempts.count = 1;
    attempts.resetTime = now + RATE_LIMIT_WINDOW;
  } else {
    attempts.count++;
  }

  connectionAttempts.set(ip, attempts);
  return attempts.count <= MAX_CONNECTIONS_PER_MINUTE;
};

// Session cleanup helper
const cleanupOldSessions = () => {
  const now = Date.now();
  const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

  Object.keys(sessions).forEach((sessionCode) => {
    const session = sessions[sessionCode];
    const sessionAge = now - session.createdAt;

    // Clean up sessions older than 24 hours
    if (sessionAge > SESSION_MAX_AGE) {
      console.log(
        `[SESSION-CLEANUP] Removing old session ${sessionCode} (age: ${Math.round(
          sessionAge / 1000 / 60
        )} minutes)`
      );

      // Disconnect all clients
      if (session.host) {
        session.host.socket.disconnect(true);
      }
      session.clients.forEach((client) => {
        if (client.socket) client.socket.disconnect(true);
      });

      delete sessions[sessionCode];
      clientReadiness.delete(sessionCode);
      playCommandDebounce.delete(sessionCode);
      playCommandDebounce.delete(`${sessionCode}_all_ready`);
    }
  });
};

// Health check endpoints for Render
app.get("/", (req, res) => res.send("Audionize Sync Server is running!"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));
app.get("/status", (req, res) =>
  res.json({
    status: "running",
    activeSessions: Object.keys(sessions).length,
    totalClients: Object.values(sessions).reduce(
      (sum, session) => sum + session.clients.length,
      0
    ),
    sessions: Object.keys(sessions).map((sessionCode) => ({
      sessionCode,
      host: sessions[sessionCode].host?.name || null,
      hostDisconnectedAt: sessions[sessionCode].hostDisconnectedAt || null,
      clientCount: sessions[sessionCode].clients.length,
      clients: sessions[sessionCode].clients.map((c) => ({
        id: c.id,
        name: c.name,
      })),
      hasAudio: !!sessions[sessionCode].audio,
      createdAt: sessions[sessionCode].createdAt,
      age: Math.round(
        (Date.now() - sessions[sessionCode].createdAt) / 1000 / 60
      ), // minutes
    })),
    serverInfo: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
    },
    timestamp: new Date().toISOString(),
  })
);

// Session status endpoint for checking specific session
app.get("/session/:sessionCode", (req, res) => {
  const { sessionCode } = req.params;

  if (!sessions[sessionCode]) {
    return res.status(404).json({
      error: "Session not found",
      sessionCode,
    });
  }

  const session = sessions[sessionCode];
  const now = Date.now();

  res.json({
    sessionCode,
    exists: true,
    host: session.host
      ? {
          name: session.host.name,
          id: session.host.id,
          connected: true,
        }
      : null,
    hostDisconnectedAt: session.hostDisconnectedAt || null,
    hostGracePeriodRemaining: session.hostDisconnectedAt
      ? Math.max(0, HOST_GRACE_PERIOD - (now - session.hostDisconnectedAt))
      : null,
    clientCount: session.clients.length,
    clients: session.clients.map((c) => ({
      id: c.id,
      name: c.name,
    })),
    hasAudio: !!session.audio,
    createdAt: session.createdAt,
    age: Math.round((now - session.createdAt) / 1000 / 60), // minutes
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
  // Rate limiting
  const clientIp = socket.handshake.address;
  if (!checkRateLimit(clientIp)) {
    console.log(`[RATE-LIMIT] Too many connections from ${clientIp}`);
    socket.emit("rate-limited", {
      message: "Too many connection attempts. Please try again later.",
    });
    socket.disconnect(true);
    return;
  }

  // Set up heartbeat for this socket
  socket.heartbeat = Date.now();
  clientHeartbeats.set(socket.id, Date.now());

  // Handle heartbeat from clients
  socket.on("heartbeat", () => {
    socket.heartbeat = Date.now();
    clientHeartbeats.set(socket.id, Date.now());
  });

  socket.on("join", ({ session, role, name }) => {
    try {
      console.log(
        `[JOIN-ATTEMPT] ${role} (${name}) attempting to join session ${session}`
      );

      // Enhanced input validation
      if (!validateSessionCode(session)) {
        console.error(`[JOIN-ERROR] Invalid session code:`, session);
        socket.emit("join-error", { message: "Invalid session code format" });
        return;
      }

      if (!validateRole(role)) {
        console.error(`[JOIN-ERROR] Invalid role:`, role);
        socket.emit("join-error", { message: "Invalid role specified" });
        return;
      }

      if (!validateUserName(name)) {
        console.error(`[JOIN-ERROR] Invalid username:`, name);
        socket.emit("join-error", { message: "Invalid username format" });
        return;
      }

      // Check session limits
      if (role === "client") {
        if (!sessions[session] || !sessions[session].host) {
          socket.emit("session-not-found", {
            message:
              "Session not found or host is not active. Please check the code or ask the host to start a new session.",
          });
          console.log(
            `[JOIN-ERROR] Client (${name}) attempted to join non-existent or hostless session ${session}`
          );
          return;
        }

        // Check client limit per session
        if (sessions[session].clients.length >= MAX_CLIENTS_PER_SESSION) {
          socket.emit("session-full", {
            message: "Session is full. Maximum number of clients reached.",
          });
          console.log(
            `[JOIN-ERROR] Client (${name}) attempted to join full session ${session}`
          );
          return;
        }
      }

      socket.session = session;
      socket.role = role;
      socket.name = name.trim();
      socket.join(session);

      // Initialize session if it doesn't exist
      if (!sessions[session]) {
        sessions[session] = {
          clients: [],
          host: null,
          audio: null,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        console.log(`[SESSION-CREATED] New session ${session} created`);
      }

      // Update session activity
      sessions[session].lastActivity = Date.now();

      // If host joins, set host in the existing session (do NOT overwrite session object)
      if (role === "host") {
        // If there's already a host, disconnect them
        if (sessions[session].host && sessions[session].host.id !== socket.id) {
          console.log(
            `[HOST-REPLACE] Replacing existing host in session ${session}`
          );
          sessions[session].host.socket.disconnect(true);
        }
        // Always update the host socket reference
        sessions[session].host = { id: socket.id, name: socket.name, socket };
        console.log(
          `[HOST-JOINED] Host (${socket.name}) joined session ${session}`
        );

        // Send existing audio to new host
        if (sessions[session].audio) {
          console.log(
            `[AUDIO-SYNC] Sending existing audio to new host (${socket.name}) in session ${session}`
          );
          socket.emit("audio-uploaded", sessions[session].audio);
          socket.emit("audio_sync", sessions[session].audio);
        }
      } else {
        // Remove any existing client with same ID or name
        sessions[session].clients = sessions[session].clients.filter(
          (c) => c.id !== socket.id && c.name !== socket.name
        );

        // Add new client
        sessions[session].clients.push({
          id: socket.id,
          name: socket.name,
          socket,
        });
        console.log(
          `[CLIENT-JOINED] Client (${socket.name}) joined session ${session}. Total clients: ${sessions[session].clients.length}`
        );

        // Send existing audio to new client
        if (sessions[session].audio) {
          console.log(
            `[AUDIO-SYNC] Sending existing audio to new client (${socket.name}) in session ${session}`
          );
          socket.emit("audio-uploaded", sessions[session].audio);
          socket.emit("audio_sync", sessions[session].audio);
        }

        // Notify host about new client
        if (sessions[session].host) {
          sessions[session].host.socket.emit("user-joined", {
            name: socket.name,
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
        `[JOIN-SUCCESS] ${role} (${socket.name}) successfully joined session ${session}`
      );
      console.log(
        `[SESSION-STATUS] Session ${session}: Host=${sessions[session].host?.name}, Clients=${sessions[session].clients.length}`
      );
    } catch (error) {
      console.error(`[JOIN-ERROR] Exception during join:`, error);
      socket.emit("join-error", {
        message: "Internal server error during join",
      });
    }
  });

  socket.on("audio_upload", (audio) => {
    try {
      if (socket.session && sessions[socket.session]) {
        console.log(
          `[AUDIO-UPLOAD] Received audio upload from ${socket.id} (size: ${
            audio?.fileSize || "unknown"
          })`
        );

        // Enhanced file validation
        if (!audio || typeof audio !== "object") {
          socket.emit("audio-upload-error", { message: "Invalid audio data" });
          return;
        }

        // Validate file size (reject if >100MB)
        if (audio.fileSize && audio.fileSize > 100 * 1024 * 1024) {
          socket.emit("audio-upload-error", {
            message: "File too large (max 100MB)",
          });
          return;
        }

        // Validate file type
        if (audio.fileType && !audio.fileType.startsWith("audio/")) {
          socket.emit("audio-upload-error", {
            message: "Invalid file type. Only audio files are allowed.",
          });
          return;
        }

        sessions[socket.session].audio = audio;
        sessions[socket.session].lastActivity = Date.now();

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
    } catch (error) {
      console.error(
        `[AUDIO-UPLOAD-ERROR] Exception during audio upload:`,
        error
      );
      socket.emit("audio-upload-error", {
        message: "Internal server error during audio upload",
      });
    }
  });

  // Optimized command forwarding for millisecond precision with debouncing
  [
    "pause_command",
    "seek_command",
    "volume_command",
    "sync_all_command",
  ].forEach((event) => {
    socket.on(event, (data) => {
      try {
        if (socket.session && sessions[socket.session]) {
          // Validate data structure
          if (!data || typeof data !== "object") {
            console.warn(
              `[${event.toUpperCase()}] Invalid data received from ${socket.id}`
            );
            return;
          }

          // Add timestamp for tracking
          const enhancedData = {
            ...data,
            serverTimestamp: Date.now(),
            originalTimestamp: data.timestamp,
          };

          // Update session activity
          sessions[socket.session].lastActivity = Date.now();

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
      } catch (error) {
        console.error(
          `[${event.toUpperCase()}-ERROR] Exception during command forwarding:`,
          error
        );
      }
    });
  });

  // Special handling for play_command with debouncing
  socket.on("play_command", (data) => {
    try {
      if (socket.session && sessions[socket.session]) {
        const sessionCode = socket.session;
        const now = Date.now();
        const debounceInfo = playCommandDebounce.get(sessionCode) || {
          lastCommand: 0,
          pending: false,
        };

        // Debounce play commands to prevent spam (100ms minimum interval)
        if (now - debounceInfo.lastCommand < 100) {
          console.log(
            `[PLAY_COMMAND] Debounced - too frequent (${
              now - debounceInfo.lastCommand
            }ms since last)`
          );
          return;
        }

        // Update debounce info
        playCommandDebounce.set(sessionCode, {
          lastCommand: now,
          pending: false,
        });

        // Validate data structure
        if (!data || typeof data !== "object") {
          console.warn(
            `[PLAY_COMMAND] Invalid data received from ${socket.id}`
          );
          return;
        }

        // Add timestamp for tracking
        const enhancedData = {
          ...data,
          serverTimestamp: now,
          originalTimestamp: data.timestamp,
        };

        // Update session activity
        sessions[sessionCode].lastActivity = Date.now();

        // Forward to clients
        socket.to(sessionCode).emit("play_command", enhancedData);

        console.log(
          `[PLAY_COMMAND] Forwarded to ${sessions[sessionCode].clients.length} clients (debounced)`
        );
      }
    } catch (error) {
      console.error(
        `[PLAY_COMMAND-ERROR] Exception during play command:`,
        error
      );
    }
  });

  socket.on("mic-status", ({ isMuted }) => {
    try {
      if (socket.session && typeof isMuted === "boolean") {
        io.to(socket.session).emit("mic-status-update", {
          userId: socket.id,
          name: socket.name,
          isMuted,
        });
      }
    } catch (error) {
      console.error(
        `[MIC-STATUS-ERROR] Exception during mic status update:`,
        error
      );
    }
  });

  socket.on("mute-client", ({ clientId }) => {
    try {
      if (clientId && typeof clientId === "string") {
        io.to(clientId).emit("muted");
      }
    } catch (error) {
      console.error(`[MUTE-CLIENT-ERROR] Exception during client mute:`, error);
    }
  });

  socket.on("disconnect-client", ({ clientId }) => {
    try {
      if (!clientId || typeof clientId !== "string") {
        console.warn(
          `[DISCONNECT-CLIENT] Invalid clientId received:`,
          clientId
        );
        return;
      }

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
    } catch (error) {
      console.error(
        `[DISCONNECT-CLIENT-ERROR] Exception during client disconnect:`,
        error
      );
    }
  });

  // Handle client readiness for better sync with deduplication
  socket.on("client-ready", (data) => {
    try {
      if (socket.session) {
        // Initialize readiness tracking for this session if not exists
        if (!clientReadiness.has(socket.session)) {
          clientReadiness.set(socket.session, new Set());
        }

        const readyClients = clientReadiness.get(socket.session);
        const wasAlreadyReady = readyClients.has(socket.id);
        readyClients.add(socket.id);

        // Only log if this is a new ready state
        if (!wasAlreadyReady) {
          console.log(
            `[CLIENT-READY] ${socket.name} (${socket.id}) ready in session ${socket.session}`
          );
        }

        // Check if all clients in the session are ready
        const session = sessions[socket.session];
        if (session && session.clients.length > 0) {
          const allClientsReady = session.clients.every((client) =>
            readyClients.has(client.id)
          );

          if (
            allClientsReady &&
            session.host &&
            session.host.socket.connected
          ) {
            // Only emit if we haven't already notified about this state
            const sessionKey = `${socket.session}_all_ready`;
            const lastNotification = playCommandDebounce.get(sessionKey);
            const now = Date.now();

            if (
              !lastNotification ||
              now - lastNotification.lastCommand > 1000
            ) {
              console.log(
                `[SERVER] Emitting all-clients-ready to host socket: ${session.host.socket.id}`
              );
              console.log(
                `[SERVER] Ready clients: ${Array.from(readyClients)}`
              );
              session.host.socket.emit("all-clients-ready", {
                sessionCode: socket.session,
                readyClients: Array.from(readyClients),
              });
              console.log(`[SERVER] all-clients-ready event sent to host`);

              // Track this notification to prevent spam
              playCommandDebounce.set(sessionKey, {
                lastCommand: now,
                pending: false,
              });
            } else {
              console.log(
                `[SERVER] Skipping duplicate all-clients-ready notification`
              );
            }
          } else if (
            allClientsReady &&
            session.host &&
            !session.host.socket.connected
          ) {
            console.log(
              `[SERVER] Host socket not connected, cannot send all-clients-ready`
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `[CLIENT-READY-ERROR] Exception during client ready:`,
        error
      );
    }
  });

  socket.on("client-not-ready", (data) => {
    try {
      if (socket.session) {
        const readyClients = clientReadiness.get(socket.session);
        if (readyClients) {
          readyClients.delete(socket.id);
          console.log(
            `[CLIENT-NOT-READY] ${socket.name} (${socket.id}) not ready in session ${socket.session}`
          );
        }
      }
    } catch (error) {
      console.error(
        `[CLIENT-NOT-READY-ERROR] Exception during client not ready:`,
        error
      );
    }
  });

  socket.on("disconnect", () => {
    try {
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

        // Clean up debounce tracking for this session
        playCommandDebounce.delete(socket.session);
        playCommandDebounce.delete(`${socket.session}_all_ready`);
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

        // Handle host disconnection with grace period
        if (
          socket.role === "host" &&
          sessions[socket.session].host?.id === socket.id
        ) {
          console.log(
            `[HOST-LEFT] Host (${socket.name}) left session ${socket.session}`
          );

          // Mark host as disconnected but keep session alive
          sessions[socket.session].hostDisconnectedAt = Date.now();
          sessions[socket.session].host = null;

          // Notify clients but don't disconnect them immediately
          io.to(socket.session).emit("host_disconnect", {
            message: "Host has disconnected. Waiting for reconnection...",
            gracePeriod: HOST_GRACE_PERIOD,
            hostName: socket.name,
          });

          // Set cleanup timer for session if host doesn't return
          setTimeout(() => {
            if (sessions[socket.session] && !sessions[socket.session].host) {
              console.log(
                `[HOST-GRACE-TIMEOUT] Host did not return to session ${socket.session}, cleaning up`
              );

              // Notify clients that session is ending
              io.to(socket.session).emit("host_disconnect", {
                message: "Host did not return. Session ended.",
                gracePeriod: 0,
              });

              // Disconnect all clients
              sessions[socket.session].clients.forEach((client) => {
                if (client.socket) client.socket.disconnect(true);
              });

              // Clean up session
              delete sessions[socket.session];
            }
          }, HOST_GRACE_PERIOD);

          return; // End further processing
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
    } catch (error) {
      console.error(`[DISCONNECT-ERROR] Exception during disconnect:`, error);
    }
  });

  // Handle connection errors
  socket.on("error", (error) => {
    console.error(`[SOCKET-ERROR] Socket error for ${socket.id}:`, error);
  });
});

// Heartbeat cleanup mechanism
setInterval(() => {
  try {
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
  } catch (error) {
    console.error(
      `[HEARTBEAT-CLEANUP-ERROR] Exception during heartbeat cleanup:`,
      error
    );
  }
}, HEARTBEAT_INTERVAL);

// Session cleanup mechanism
setInterval(() => {
  try {
    cleanupOldSessions();
  } catch (error) {
    console.error(
      `[SESSION-CLEANUP-ERROR] Exception during session cleanup:`,
      error
    );
  }
}, SESSION_CLEANUP_INTERVAL);

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] Received SIGTERM, shutting down gracefully...");

  // Disconnect all clients
  io.sockets.sockets.forEach((socket) => {
    socket.disconnect(true);
  });

  // Close server
  server.close(() => {
    console.log("[SHUTDOWN] Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("[SHUTDOWN] Received SIGINT, shutting down gracefully...");

  // Disconnect all clients
  io.sockets.sockets.forEach((socket) => {
    socket.disconnect(true);
  });

  // Close server
  server.close(() => {
    console.log("[SHUTDOWN] Server closed");
    process.exit(0);
  });
});

// Unhandled error handling
process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT-EXCEPTION]", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[UNHANDLED-REJECTION]", reason);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Audionize Sync Server started on port ${PORT}`);
  console.log(`Heartbeat cleanup running every ${HEARTBEAT_INTERVAL}ms`);
  console.log(`Session cleanup running every ${SESSION_CLEANUP_INTERVAL}ms`);
  console.log(`Max clients per session: ${MAX_CLIENTS_PER_SESSION}`);
  console.log(`Max connections per minute: ${MAX_CONNECTIONS_PER_MINUTE}`);
});
