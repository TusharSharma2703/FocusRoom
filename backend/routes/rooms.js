const express = require("express");
const Room = require("../models/Room");
const protect = require("../middleware/auth");

const router = express.Router();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// POST /api/rooms  - create a new room
router.post("/", protect, async (req, res) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const durationMinutes = req.body.durationMinutes === undefined ? 25 : Number(req.body.durationMinutes);
    if (!name) return res.status(400).json({ message: "Room name is required" });
    if (name.length > 60) return res.status(400).json({ message: "Room name must be 60 characters or less" });
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 180) {
      return res.status(400).json({ message: "Session length must be 5-180 minutes" });
    }

    // Pick an unused code. The unique index is the final guard: if two rooms grab
    // the same code at the same instant, the loser gets error 11000 and retries.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      if (await Room.exists({ code })) continue;
      try {
        const room = await Room.create({
          code,
          name,
          host: req.user.id,
          durationMinutes,
          startedAt: new Date(),
        });
        return res.status(201).json({ room });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    res.status(503).json({ message: "Could not generate a room code, please try again" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/rooms/:code - get room info by join code
router.get("/:code", protect, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(404).json({ message: "Room not found or has ended" });
    const room = await Room.findOne({ code, isActive: true }).populate("host", "name");
    if (!room) return res.status(404).json({ message: "Room not found or has ended" });
    res.json({ room });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/rooms/:code/end - host ends the room
router.patch("/:code/end", protect, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const room = await Room.findOne({ code });
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (room.host.toString() !== req.user.id) {
      return res.status(403).json({ message: "Only the host can end the room" });
    }
    room.isActive = false;
    await room.save();
    res.json({ message: "Room ended" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
