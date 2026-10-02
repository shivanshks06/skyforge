import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load server/.env regardless of the working directory. ESM hoists imports, so every
// entry point imports this module first, before anything that reads process.env.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"), quiet: true });
