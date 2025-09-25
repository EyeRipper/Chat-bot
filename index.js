import { GoogleGenAI } from "@google/genai";
import express from "express";
import compression from "compression";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
dotenv.config();

const app = express();
app.use(express.json());
app.use(compression());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", setHeaders: (res, filePath) => {
  if (filePath.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-cache");
  }
} }));
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY is not set. Add it to a .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Load colleges dataset
const collegesPath = path.join(__dirname, "data", "colleges.json");
let colleges = [];
try {
  const raw = fs.readFileSync(collegesPath, "utf-8");
  colleges = JSON.parse(raw);
} catch (e) {
  console.warn("Could not load colleges dataset:", e?.message);
}

// Optionally load supplemental RTU colleges dataset (merged into colleges)
const rtuCollegesPath = path.join(__dirname, "data", "rtu_colleges.json");
try {
  if (fs.existsSync(rtuCollegesPath)) {
    const raw = fs.readFileSync(rtuCollegesPath, "utf-8");
    const rtuColleges = JSON.parse(raw);
    if (Array.isArray(rtuColleges)) {
      const byName = new Map(colleges.map(c => [String(c.name).toLowerCase(), c]));
      for (const c of rtuColleges) {
        const key = String(c?.name || "").toLowerCase();
        if (!key) continue;
        if (!byName.has(key)) {
          byName.set(key, c);
        }
      }
      colleges = Array.from(byName.values());
    }
  }
} catch (e) {
  console.warn("Could not merge RTU colleges:", e?.message);
}

// Load scholarships dataset
const scholarshipsPath = path.join(__dirname, "data", "scholarships.json");
let scholarships = [];
try {
  const raw = fs.readFileSync(scholarshipsPath, "utf-8");
  scholarships = JSON.parse(raw);
} catch (e) {
  console.warn("Could not load scholarships dataset:", e?.message);
}

// Optionally load universities metadata
const universitiesPath = path.join(__dirname, "data", "universities.json");
let universities = [];
try {
  if (fs.existsSync(universitiesPath)) {
    const raw = fs.readFileSync(universitiesPath, "utf-8");
    const parsed = JSON.parse(raw);
    universities = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  }
} catch (e) {
  console.warn("Could not load universities dataset:", e?.message);
}

// Admin endpoint to replace dataset
app.post("/admin/colleges", (req, res) => {
  try {
    const payload = req.body;
    if (!Array.isArray(payload)) {
      return res.status(400).json({ error: "Body must be an array of college objects" });
    }
    // Basic validation for required fields
    for (const item of payload) {
      if (!item || typeof item !== "object" || !item.name || !item.location) {
        return res.status(400).json({ error: "Each item must include at least 'name' and 'location'" });
      }
    }

    fs.mkdirSync(path.dirname(collegesPath), { recursive: true });
    fs.writeFileSync(collegesPath, JSON.stringify(payload, null, 2), "utf-8");
    colleges = payload;
    return res.status(200).json({ ok: true, count: colleges.length });
  } catch (error) {
    console.error("/admin/colleges error:", error);
    return res.status(500).json({ error: "Failed to save dataset" });
  }
});

// Fetch all colleges
app.get("/colleges", (_req, res) => {
  res.json({ count: colleges.length, results: colleges });
});

// Admin endpoint to replace scholarships
app.post("/admin/scholarships", (req, res) => {
  try {
    const payload = req.body;
    if (!Array.isArray(payload)) {
      return res.status(400).json({ error: "Body must be an array of scholarship objects" });
    }
    for (const item of payload) {
      if (!item || typeof item !== "object" || !item.name || !item.category) {
        return res.status(400).json({ error: "Each item must include at least 'name' and 'category'" });
      }
    }
    fs.mkdirSync(path.dirname(scholarshipsPath), { recursive: true });
    fs.writeFileSync(scholarshipsPath, JSON.stringify(payload, null, 2), "utf-8");
    scholarships = payload;
    return res.status(200).json({ ok: true, count: scholarships.length });
  } catch (error) {
    console.error("/admin/scholarships error:", error);
    return res.status(500).json({ error: "Failed to save dataset" });
  }
});

// Fetch all scholarships
app.get("/scholarships", (_req, res) => {
  res.json({ count: scholarships.length, results: scholarships });
});

// Lightweight stats endpoint for fast UI load
app.get("/stats", (_req, res) => {
  res.json({
    colleges: colleges.length,
    scholarships: scholarships.length,
    universities: universities.length,
  });
});

// Universities endpoint (kept lightweight for now)
app.get("/universities", (_req, res) => {
  res.json({ count: universities.length });
});

app.post("/campus-connect", async (req, res) => {
  try {
    const { prompts } = req.body ?? {};
    if (typeof prompts !== "string" || prompts.trim().length === 0) {
      return res.status(400).json({ error: "Invalid 'prompts': expected non-empty string" });
    }

    const text = await main(prompts.trim());
    return res.status(200).json({ text });
  } catch (error) {
    console.error("/campus-connect error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Deterministic search API
app.get("/colleges/search", (req, res) => {
  const { location, branch, hostel, maxFee } = req.query;
  let results = colleges;

  if (location) {
    results = results.filter(c => c.location.toLowerCase() === String(location).toLowerCase());
  }
  if (branch) {
    const b = String(branch).toLowerCase();
    results = results.filter(c => c.branches?.some(x => String(x).toLowerCase() === b));
  }
  if (hostel) {
    results = results.filter(c => String(c.hostel).toLowerCase() === String(hostel).toLowerCase());
  }
  if (maxFee) {
    const cap = Number(maxFee);
    if (!Number.isNaN(cap)) {
      results = results.filter(c => Number(c.fee) <= cap);
    }
  }
  res.json({ count: results.length, results });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function main(prompts) {
  const prompt = prompts;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: `You are Campus Connect — a college and scholarships assistant. Answer ONLY using the provided datasets. If unknown, say you don't know.

Keep answers concise and structured in Markdown:
- Title (###)
- Subsections (####)
- Bullet points, bold labels

Datasets (JSON - truncated for performance):
Universities:
${JSON.stringify(universities.slice(0, 100)).slice(0, 5000)}

Colleges:
${JSON.stringify(colleges.slice(0, 200)).slice(0, 20000)}

Scholarships:
${JSON.stringify(scholarships.slice(0, 200)).slice(0, 12000)}

User question: ${prompt}` }
        ],
      },
    ],
  });

  // Normalize text extraction across SDK variants
  const text = typeof response.text === "function"
    ? response.text()
    : (response.response?.text?.() || response.candidates?.[0]?.content?.parts?.[0]?.text);
  return text ?? "";
}

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});