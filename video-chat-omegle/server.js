// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname)); // يخدم كل الملفات من نفس المجلد

// Queue of sockets waiting for a partner
const waitingQueue = []; // array of socket.id
const partners = new Map(); // socket.id -> partnerId

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // client asks to find partner
  socket.on("find-partner", () => {
    // if already paired, ignore
    if (partners.has(socket.id)) return;
    // if already in queue, ignore
    if (waitingQueue.includes(socket.id)) return;

    // if someone is waiting -> pair them
    if (waitingQueue.length > 0) {
      const otherId = waitingQueue.shift();
      // if other disconnected meanwhile, try next
      const otherSocket = io.sockets.sockets.get(otherId);
      if (!otherSocket) {
        // try to pair again
        socket.emit("waiting", "Looking for a partner...");
        if (waitingQueue.length > 0) socket.emit("find-partner");
        return;
      }

      // set partners
      partners.set(socket.id, otherId);
      partners.set(otherId, socket.id);

      // choose initiator (make the newer socket the initiator for example)
      // send partner-found with role initiator true/false
      socket.emit("partner-found", { id: otherId, initiator: true });
      otherSocket.emit("partner-found", { id: socket.id, initiator: false });

      console.log(`Paired ${socket.id} <-> ${otherId}`);
    } else {
      // add to queue
      waitingQueue.push(socket.id);
      socket.emit("waiting", "Looking for a partner...");
    }
  });

  // signaling messages forwarded to specific peer
  // payload: { to: "<socketId>", data: <SDP or ICE candidate> }
  socket.on("signal", (payload) => {
    const to = payload.to;
    const data = payload.data;
    if (!to) return;
    const target = io.sockets.sockets.get(to);
    if (target) {
      target.emit("signal", { from: socket.id, data });
    }
  });

  // skip: user wants to leave current partner (if any) and find a new one
  socket.on("skip", () => {
    const partnerId = partners.get(socket.id);
    // inform partner if exists
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        // notify partner that their partner skipped
        partnerSocket.emit("partner-disconnected", { reason: "skipped" });
        // remove partner mapping for partner
        partners.delete(partnerId);
      }
      partners.delete(socket.id);
    }

    // push this socket back to queue to find a new partner
    if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    socket.emit("waiting", "Looking for a new partner...");
    // try to pair immediately if someone else waiting
    if (waitingQueue.length >= 2) {
      const first = waitingQueue.shift();
      const second = waitingQueue.shift();
      const s1 = io.sockets.sockets.get(first);
      const s2 = io.sockets.sockets.get(second);
      if (s1 && s2) {
        partners.set(first, second);
        partners.set(second, first);
        // make first initiator
        s1.emit("partner-found", { id: second, initiator: true });
        s2.emit("partner-found", { id: first, initiator: false });
      } else {
        // if any missing, requeue existing ones
        if (s1 && !waitingQueue.includes(first)) waitingQueue.push(first);
        if (s2 && !waitingQueue.includes(second)) waitingQueue.push(second);
      }
    }
  });

  // stop: user wants to stop searching / end session
  socket.on("stop", () => {
    // remove from waiting queue if present
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

    // remove from waitingQueue if present
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    // notify partner if exists
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
