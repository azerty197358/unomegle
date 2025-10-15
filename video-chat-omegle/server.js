const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname)); // يخدم كل الملفات من نفس المجلد

let waitingUser = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // عند دخول مستخدم
  if (waitingUser) {
    const partner = waitingUser;
    waitingUser = null;

    socket.partner = partner.id;
    partner.partner = socket.id;

    socket.emit("partner-found", partner.id);
    partner.emit("partner-found", socket.id);
  } else {
    waitingUser = socket;
    socket.emit("waiting", "Looking for a partner...");
  }

  // استقبال إشارات WebRTC
  socket.on("signal", (data) => {
    if (socket.partner) io.to(socket.partner).emit("signal", { from: socket.id, data });
  });

  // عند قطع الاتصال
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (socket.partner) io.to(socket.partner).emit("partner-disconnected");
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
