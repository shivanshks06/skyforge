import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../config/db.js";

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("skyforge-invalid-login-placeholder", 12);

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be configured with at least 32 characters.");
    }
    return "skyforge_development_jwt_secret_min_32_characters_long";
  }
  if (secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be configured with at least 32 characters.");
    }
    return secret.padEnd(32, "_");
  }
  return secret;
}

function createToken(userId) {
  return jwt.sign({ userId }, getJwtSecret(), { expiresIn: "7d" });
}

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
    this.statusCode = 400;
  }
}

function validateSignup({ name, email, password }) {
  const normalizedName = String(name || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");

  if (normalizedName.length < 2 || normalizedName.length > 100) {
    throw new InputError("Name must be between 2 and 100 characters.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw new InputError("A valid email address is required.");
  }
  if (normalizedPassword.length < 8 || normalizedPassword.length > 128 || Buffer.byteLength(normalizedPassword, "utf8") > 72) {
    throw new InputError("Password must be between 8 and 72 UTF-8 bytes.");
  }
  return { name: normalizedName, email: normalizedEmail, password: normalizedPassword };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    github: user.github || null,
  };
}

export const signup = async (req, res) => {
  try {
    const { name, email, password } = validateSignup(req.body || {});
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, email, password: passwordHash },
      include: { github: { select: { id: true, username: true, githubId: true } } },
    });

    return res.status(201).json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ message: "Email already exists" });
    const isInputError = error.name === "InputError";
    console.error("Signup error:", error.message);
    return res.status(isInputError ? 400 : 500).json({
      message: isInputError ? error.message : "Unable to create account",
    });
  }
};

export const login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
    if (Buffer.byteLength(password, "utf8") > 72) return res.status(400).json({ message: "Password must be between 8 and 72 UTF-8 bytes." });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { github: { select: { id: true, username: true, githubId: true } } },
    });
    const validPassword = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);
    if (!user || !validPassword) return res.status(401).json({ message: "Invalid email or password" });

    return res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ message: "Unable to sign in" });
  }
};

export const me = async (req, res) => res.json(req.user);

export const updateProfile = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ message: "Name must be between 2 and 100 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ message: "A valid email address is required." });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name, email },
      include: { github: { select: { id: true, username: true, githubId: true } } },
    });
    return res.json({ message: "Profile updated successfully", user: publicUser(user) });
  } catch (error) {
    if (error.code === "P2002") return res.status(409).json({ message: "Email already exists" });
    console.error("Profile update error:", error.message);
    return res.status(500).json({ message: "Unable to update profile" });
  }
};
