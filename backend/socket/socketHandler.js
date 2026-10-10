const jwt = require("jsonwebtoken");
const Room = require("../models/Room");

const ALLOWED_EMOJIS = ["👍", "🔥", "💪", "☕", "👏", "🚀"];
const MAX_TASK_LENGTH = 100;
const REACTION_COOLDOWN_MS = 300;

// In-memory presence store: { roomCode: { socketId: participantData } }
const roomPresence = {};

// One entry per USER (a user with two tabs open appears once)
function getParticipantList(roomCode) {
  const byUser = {};
  for (const p of Object.values(roomPresence[roomCode] || {})) byUser[p.userId] = p;
  return Object.values(byUser);
}

function userSocketsInRoom(roomCode, userId) {
  return Object.values(roomPresence[roomCode] || {}).filter((p) => p.userId === userId);
}

function cleanTask(task) {
  const text = typeof task === "string" ? task.trim().slice(0, MAX_TASK_LENGTH) : "";
  return text || "Getting focused...";
}

// Never let one bad message crash the whole server
function safe(socket, handler) {
  return async (payload) => {
    try {
      await handler(payload && typeof payload === "object" ? payload : {});
    } catch (err) {
      console.error(`Socket handler error (${socket.id}):`, err.message);
    }
  };
}

function initSocket(io) {
  // Authenticate every socket connection using the JWT from the client
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("No token provided"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded; // { id, name, email }
      next();
    } catch (err) {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    let currentRoom = null;
    let lastReactionAt = 0;
    let completed = false;

    function leaveCurrentRoom() {
      if (!currentRoom || !roomPresence[currentRoom]?.[socket.id]) return;
      const room = currentRoom;
      const leftName = roomPresence[room][socket.id].name;
      delete roomPresence[room][socket.id];
      socket.leave(room);
      currentRoom = null;

      if (Object.keys(roomPresence[room]).length === 0) {
        delete roomPresence[room];
        return;
      }
      io.to(room).emit("room:participants", getParticipantList(room));
      // Only announce "left" when the user's last tab is gone
      if (userSocketsInRoom(room, socket.user.id).length === 0) {
        io.to(room).emit("room:notice", { message: `${leftName} left the room`, type: "leave" });
      }
    }

    // Join a room
    socket.on(
      "room:join",
      safe(socket, async ({ roomCode, task }) => {
        if (typeof roomCode !== "string" || !/^[A-Za-z0-9]{6}$/.test(roomCode)) {
          return socket.emit("room:error", { message: "Invalid room code" });
        }
        const code = roomCode.toUpperCase();

        // The room must really exist and still be active
        const room = await Room.findOne({ code, isActive: true }).select("_id");
        if (!room) return socket.emit("room:error", { message: "Room not found or has ended" });

        if (currentRoom && currentRoom !== code) leaveCurrentRoom();
        currentRoom = code;
        socket.join(code);

        if (!roomPresence[code]) roomPresence[code] = {};
        const firstTabForUser = userSocketsInRoom(code, socket.user.id).length === 0;

        roomPresence[code][socket.id] = {
          socketId: socket.id,
          userId: socket.user.id,
          name: socket.user.name,
          task: cleanTask(task),
          joinedAt: Date.now(),
        };

        io.to(code).emit("room:participants", getParticipantList(code));
        if (firstTabForUser) {
          socket.to(code).emit("room:notice", {
            message: `${socket.user.name} joined the room`,
            type: "join",
          });
        }
      })
    );

    // Update current task
    socket.on(
      "task:update",
      safe(socket, ({ task }) => {
        if (!currentRoom || !roomPresence[currentRoom]?.[socket.id]) return;
        roomPresence[currentRoom][socket.id].task = cleanTask(task);
        io.to(currentRoom).emit("room:participants", getParticipantList(currentRoom));
      })
    );

    // Silent emoji reaction / nudge - broadcast without interrupting focus state.
    // With a targetUserId, only that person (and the sender) sees it.
    socket.on(
      "reaction:send",
      safe(socket, ({ emoji, targetUserId }) => {
        if (!currentRoom || !ALLOWED_EMOJIS.includes(emoji)) return;
        const now = Date.now();
        if (now - lastReactionAt < REACTION_COOLDOWN_MS) return; // simple anti-spam
        lastReactionAt = now;

        const reaction = {
          emoji,
          fromName: socket.user.name,
          fromUserId: socket.user.id,
          targetUserId: typeof targetUserId === "string" ? targetUserId : null,
          timestamp: now,
        };

        if (!reaction.targetUserId) {
          return io.to(currentRoom).emit("reaction:receive", reaction);
        }
        const targetSockets = userSocketsInRoom(currentRoom, reaction.targetUserId).map((p) => p.socketId);
        if (targetSockets.length === 0) return;
        io.to([...targetSockets, socket.id]).emit("reaction:receive", reaction);
      })
    );

    // Participant marks session complete (announced once per connection)
    socket.on(
      "session:complete",
      safe(socket, () => {
        if (!currentRoom || completed) return;
        completed = true;
        io.to(currentRoom).emit("room:notice", {
          message: `${socket.user.name} completed their focus session 🎉`,
          type: "complete",
        });
      })
    );

    socket.on("disconnect", () => {
      try {
        leaveCurrentRoom();
      } catch (err) {
        console.error("Disconnect cleanup error:", err.message);
      }
    });
  });
}

module.exports = initSocket;
