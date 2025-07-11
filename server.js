const express = require("express");
const http = require("http");
const { Server: IOServer } = require("socket.io");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  path: "/socket.io",
  cors: {
    origin: "*", // Change to your frontend domain in production
    methods: ["GET", "POST"],
  },
});
const wss = new WebSocket.Server({ server, path: "/ws" });

const PORT = process.env.PORT || 4000;
const sessions = {}; // { sessionCode: { host, clients, audioUrl, ... } }

// Health check endpoint
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// --- WebSocket (LAN) ---
wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }
    if (data.type === "join") {
      ws.session = data.session;
      ws.role = data.role;
      sessions[data.session] = sessions[data.session] || {
        clients: [],
        host: null,
      };
      if (data.role === "host") sessions[data.session].host = ws;
      else sessions[data.session].clients.push(ws);
    }
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
    if (ws.session && sessions[ws.session]) {
      sessions[ws.session].clients = (
        sessions[ws.session].clients || []
      ).filter((c) => c !== ws);
      if (sessions[ws.session].host === ws) sessions[ws.session].host = null;
    }
  });
});

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
  socket.on("join", ({ session, role }) => {
    socket.session = session;
    socket.role = role;
    socket.join(session);
    sessions[session] = sessions[session] || { clients: [], host: null };
    if (role === "host") sessions[session].host = socket;
    else sessions[session].clients.push(socket);
  });
  socket.on("sync", (data) => {
    if (socket.session) {
      socket.to(socket.session).emit("sync", data);
    }
  });
  socket.on("disconnect", () => {
    if (socket.session && sessions[socket.session]) {
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c !== socket);
      if (sessions[socket.session].host === socket)
        sessions[socket.session].host = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
