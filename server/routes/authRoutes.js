import express from "express";
import { signup, login, me, updateProfile } from "../controllers/authController.js";
import protect from "../middleware/authMiddleware.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

const signupIpLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, prefix: "signup-ip", message: "Too many signup attempts. Please try again later." });
const loginIpLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, prefix: "login-ip", message: "Too many login attempts. Please try again later." });
const loginAccountLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "login-account",
  keyResolver: (req) => String(req.body?.email || "").trim().toLowerCase() || req.ip,
  message: "Too many login attempts for this account. Please try again later.",
});

router.post("/signup", signupIpLimit, signup);
router.post("/login", loginIpLimit, loginAccountLimit, login);
router.get("/me", protect, me);
router.patch("/profile", protect, updateProfile);

export default router;
