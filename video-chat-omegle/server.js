// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname)); // يخدم كل الملفات من نفس المجلد

// طابور انتظار وحفظ شريك آخر لتجنب إعادة الاقتران الفوري
let waitingQueue = [];
const lastPartner = new Map(); // socketId -> lastPartnerId (لتجنب إعادة الاقتران السريع)

function tryPairing() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    // إيجاد شريك لب بدون أن يكون آخر شريك له نفسه
    let bIndex = waitingQueue.findIndex(s => s.id !== a.id && lastPartner.get(a.id) !== s.id && lastPartner.get(s.id) !== a.id);
    if (bIndex === -1) {
      // لم نجد شريك مناسب الآن — نعيد a للطابور ونكسر الحلقة
      waitingQueue.unshift(a);
      break;
    }
    const b = waitingQueue.splice(bIndex, 1)[0];

    // تأكد أن كلاهما ما زالا متصلين
    if (a.disconnected || b.disconnected) {
      if (!a.disconnected && waitingQueue.indexOf(a) === -1) waitingQueue.unshift(a);
      if (!b.disconnected && waitingQueue.indexOf(b) === -1) waitingQueue.unshift(b);
      continue;
    }

    const room = `room-${a.id}#${b.id}`;
    a.join(room);
    b.join(room);

    a.partnerId = b.id;
    b.partnerId = a.id;
    a.room = room;
    b.room = room;

    // تذكر آخر شريك لتجنب إعادة الاقتران الفوري
    lastPartner.set(a.id, b.id);
    lastPartner.set(b.id, a.id);

    // جعل أحدهما initiator = true (ليعمل offer)
    // نعتبر b (المنضم لاحقًا) هو initiator
    b.emit("partner-found", { partnerId: a.id, initiator: true });
    a.emit("partner-found", { partnerId: b.id, initiator: false });
  }
}

io.on("connection", (socket) => {
  socket.disconnected = false;
  console.log("User connected:", socket.id);

  // طلب البحث عن شريك
  socket.on("find-partner", () => {
    // تنظيف أي حالة سابقة
    if (socket.room) {
      // إذا كان في غرفة، اخرج وابلغ الشريك
      const room = socket.room;
      socket.leave(room);
      if (socket.partnerId) {
        io.to(socket.partnerId).emit("partner-disconnected");
        // ضع الشريك مرة أخرى في الطابور بحيث يعاد البحث عنه
        const partnerSocket = io.sockets.sockets.get(socket.partnerId);
        if (partnerSocket) {
          delete partnerSocket.room;
          delete partnerSocket.partnerId;
          waitingQueue.push(partnerSocket);
        }
      }
      delete socket.room;
      delete socket.partnerId;
    }

    // أضف المستخدم إلى الطابور إن لم يكن موجودًا
    if (!waitingQueue.find(s => s.id === socket.id)) {
      waitingQueue.push(socket);
    }
    tryPairing();
  });

  // استقبال إشارات (offer/answer/candidate)
  socket.on("signal", (payload) => {
    // payload يجب أن يحتوي على: { to?: partnerId, data: ... }
    // لكن سنستخدم الغرفة إن وُجدت لتوجيه الرسالة للشريك
    if (socket.room) {
      // أرسِل إلى كل من في الغرفة ما عدا المرسل
      socket.to(socket.room).emit("signal", { from: socket.id, data: payload.data });
    } else if (payload.to) {
      // كخطة احتياطية: إذا أعطى العميل معرف الشريك مباشرة
      io.to(payload.to).emit("signal", { from: socket.id, data: payload.data });
    }
  });

  // طلب تخطي الشريك (skip)
  socket.on("skip", () => {
    console.log("Skip requested by", socket.id);
    // أخبر الشريك أنه مفصول
    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "skipped" });
        // ضع الشريك في الطابور للبحث عن شريك جديد
        delete partnerSocket.room;
        delete partnerSocket.partnerId;
        waitingQueue.push(partnerSocket);
      }
    }

    // قم بإعادة تهيئة هذا السوكيت ووضعه مرة أخرى في الطابور
    if (socket.room) socket.leave(socket.room);
    delete socket.room;
    delete socket.partnerId;
    waitingQueue.push(socket);
    tryPairing();
  });

  // طلب إيقاف الجلسة (stop)
  socket.on("stop", () => {
    console.log("Stop requested by", socket.id);
    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "stopped" });
        delete partnerSocket.room;
        delete partnerSocket.partnerId;
      }
    }
    // إزالة هذا السوكيت من الطابور إن كان فيه
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    if (socket.room) socket.leave(socket.room);
    delete socket.room;
    delete socket.partnerId;
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    socket.disconnected = true;
    // أخبر الشريك وارجعه للطابور
    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partner-disconnected", { reason: "peer_left" });
        delete partnerSocket.room;
        delete partnerSocket.partnerId;
        // ضع الشريك في الطابور لإيجاد شريك جديد
        waitingQueue.push(partnerSocket);
        tryPairing();
      }
    }
    // إزالة من الطابور إن كان موجودًا
    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    lastPartner.delete(socket.id);
  });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
