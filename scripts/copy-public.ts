// Copies static assets into the build output. Static-site projects publish dist/public.
import { cpSync } from "node:fs";

cpSync("public", "dist/public", { recursive: true });
