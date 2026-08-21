import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// In-memory fallback for read-only filesystems (Vercel serverless)
const memStore = new Map<string, string>();

export async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Read-only filesystem — will use in-memory fallback
  }
}

export async function readJSON<T>(filePath: string): Promise<T | null> {
  // Check in-memory first (handles Vercel + recently written data)
  const memKey = filePath;
  if (memStore.has(memKey)) {
    return JSON.parse(memStore.get(memKey)!) as T;
  }

  try {
    const fullPath = path.join(DATA_DIR, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJSON<T>(filePath: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);

  // Always store in memory
  memStore.set(filePath, json);

  // Try to write to disk (fails silently on Vercel)
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    await ensureDir(path.dirname(fullPath));
    const tmpPath = `${fullPath}.tmp`;
    await fs.writeFile(tmpPath, json);
    await fs.rename(tmpPath, fullPath);
  } catch {
    // Read-only filesystem — in-memory fallback is already set
  }
}

export async function deleteJSON(filePath: string): Promise<boolean> {
  memStore.delete(filePath);
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    await fs.unlink(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function listJSON<T>(dirPath: string): Promise<T[]> {
  const results: T[] = [];
  const seenKeys = new Set<string>();

  // Collect from in-memory store
  const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
  for (const [key, value] of memStore) {
    if (key.startsWith(prefix) && key.endsWith(".json")) {
      seenKeys.add(key);
      results.push(JSON.parse(value) as T);
    }
  }

  // Collect from disk (skip duplicates already in memory)
  try {
    const fullPath = path.join(DATA_DIR, dirPath);
    const files = await fs.readdir(fullPath);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const fileKey = `${prefix}${file}`;
        if (seenKeys.has(fileKey)) continue;
        const content = await fs.readFile(path.join(fullPath, file), "utf-8");
        results.push(JSON.parse(content) as T);
      }
    }
  } catch {
    // Directory doesn't exist on disk — only in-memory results
  }

  return results;
}
