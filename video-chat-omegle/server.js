// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));

const waitingQueue = [];
const partners = new Map();

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("find-partner", () => {
    if (partners.has(socket.id)) return;
    if (waitingQueue.includes(socket.id)) return;

    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      const otherSocket = io.sockets.sockets.get(otherId);
      
      if (!otherSocket) {
        socket.emit("waiting", "Looking for a stranger...");
        if (waitingQueue.length > 0) socket.emit("find-partner");
        return;
      }

      partners.set(socket.id, otherId);
      partners.set(otherId, socket.id);

      socket.emit("partner-found", { id: otherId, initiator: true });
      otherSocket.emit("partner-found", { id: socket.id, initiator: false });

      console.log(`Paired ${socket.id} <-> ${otherId}`);
    } else {
      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking for a stranger...");
    }
  });

  socket.on("signal", (payload) => {
    const to = payload.to;
    const data = payload.data;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit("signal", { from: socket.id, data });
    }
  });

  // New: Handle chat messages
  socket.on("chat-message", (payload) => {
    const to = payload.to;
    const message = payload.message;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit("chat-message", { from: socket.id, message });
    }
  });

  socket.on("skip", () => {
    const partnerId = partners.get(socket.id);
    
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "skipped" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }

    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    socket.emit("waiting", "Looking for a new stranger...");
    
    if (waitingQueue.length >= 2) {
      const first = waitingQueue.shift();
      const second = waitingQueue.shift();
      const s1 = io.sockets.sockets.get(first);
      const s2 = io.sockets.sockets.get(second);
      
      if (s1 && s2) {
        partners.set(first, second);
        partners.set(second, first);
        s1.emit("partner-found", { id: second, initiator: true });
        s2.emit("partner-found", { id: first, initiator: false });
      } else {
        if (s1 && !waitingQueue.includes(first)) waitingQueue.push(first);
        if (s2 && !waitingQueue.includes(second)) waitingQueue.push(second);
      }
    }
  });

  socket.on("stop", () => {
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "stopped" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }

    socket.emit("stopped", "Stopped searching");
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    const partnerId = partners.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "peer-left" });
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
