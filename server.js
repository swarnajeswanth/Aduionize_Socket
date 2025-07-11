// server.js
const express = require("express");
const http = require("http");
const { Server: IOServer } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  path: "/socket.io",
  cors: {
    origin: "https://audionize.netlify.app", // or "*"
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 4000;
const sessions = {}; // { sessionCode: { host: socket, clients: [socket, ...] } }

// Health check endpoints
app.get("/", (req, res) => res.send("Server is running!"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- Socket.IO (Internet) ---
io.on("connection", (socket) => {
  socket.on("join", ({ session, role, name }) => {
    socket.session = session;
    socket.role = role;
    socket.name = name;
    socket.join(session);

    // Track host/client in memory for this session
    sessions[session] = sessions[session] || { clients: [], host: null };
    if (role === "host") {
      sessions[session].host = socket;
    } else {
      sessions[session].clients.push(socket);
    }

    // Optionally, notify others in the room
    socket.to(session).emit("user-joined", { name, role });
  });

  socket.on("sync", (data) => {
    if (socket.session) {
      socket.to(socket.session).emit("sync", data); // Only to others in the same room
    }
  });

  socket.on("disconnect", () => {
    if (socket.session && sessions[socket.session]) {
      // Remove from clients array if present
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c !== socket);

      // Remove as host if this was the host
      if (sessions[socket.session].host === socket) {
        sessions[socket.session].host = null;
      }

      // Optionally, notify others
      socket
        .to(socket.session)
        .emit("user-left", { name: socket.name, role: socket.role });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
