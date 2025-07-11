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
const sessions = {}; // { sessionCode: { host: socket, clients: [socket, ...], audio: {url, name, size, type} } }

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
    sessions[session] = sessions[session] || {
      clients: [],
      host: null,
      audio: null,
    };
    if (role === "host") {
      sessions[session].host = socket;
      // If audio already uploaded, send to host
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
      }
    } else {
      sessions[session].clients.push(socket);
      // If audio already uploaded, send to new client
      if (sessions[session].audio) {
        socket.emit("audio-uploaded", sessions[session].audio);
      }
      // Notify host
      if (sessions[session].host) {
        sessions[session].host.emit("user-joined", { name, id: socket.id });
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
  });

  socket.on("audio-uploaded", (audio) => {
    if (socket.session && sessions[socket.session]) {
      sessions[socket.session].audio = audio;
      // Broadcast to all clients (except sender)
      socket.to(socket.session).emit("audio-uploaded", audio);
    }
  });

  socket.on("playback-action", (data) => {
    // { type: 'play'|'pause'|'seek', time }
    if (socket.session) {
      socket.to(socket.session).emit("playback-action", data);
    }
  });

  socket.on("mute-client", ({ clientId }) => {
    // Optionally, you can implement mute logic here
    io.to(clientId).emit("muted");
  });

  socket.on("disconnect-client", ({ clientId }) => {
    io.to(clientId).emit("disconnected");
    // Optionally, force disconnect:
    const clientSocket = sessions[socket.session]?.clients.find(
      (c) => c.id === clientId
    );
    if (clientSocket) clientSocket.disconnect(true);
  });

  socket.on("disconnect", () => {
    if (socket.session && sessions[socket.session]) {
      sessions[socket.session].clients = (
        sessions[socket.session].clients || []
      ).filter((c) => c !== socket);

      if (sessions[socket.session].host === socket) {
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
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
