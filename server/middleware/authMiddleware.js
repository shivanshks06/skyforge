import jwt from "jsonwebtoken";
import prisma from "../config/db.js";
import { getJwtSecret } from "../controllers/authController.js";

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];

    let decoded;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    let user;
    try {
      user = await prisma.user.findUnique({
      where: {
        id: decoded.userId,
      },
      select: {
        id: true,
        name: true,
        email: true,
        github: {
          select: {
            id: true,
            username: true,
            githubId: true,
          },
        },
      },
    });
    } catch (error) {
      console.error("[AUTH] User lookup failed:", error.message);
      return res.status(503).json({ message: "Authentication service is temporarily unavailable" });
    }

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = user;

    next();
  } catch (error) {
    console.error("[AUTH] Unexpected authentication middleware error:", error.message);
    res.status(500).json({
      message: "Authentication service is temporarily unavailable",
    });
  }
};

export default protect;