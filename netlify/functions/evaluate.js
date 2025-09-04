// netlify/functions/evaluate.js
// Server-side strict UPSC/OPSC evaluation using OpenAI.
// Expects JSON: { question, maxMarks, examType, timeLimit, texts: [{source,text}], images: [{mime,dataUrl}] }

import OpenAI from "openai";

export const config = {
  path: "/.netlify/functions/evaluate",
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");
    const body = await readJson(req);
    const { question, maxMarks, examType, timeLimit, texts = [], images = [] } = body || {};

    if (!question || !maxMarks) return res.status(400).send("Missing question or maxMarks");

    // Build message content: prefer extracted text; append images for OCR when provided
    const userContent = [];

    userContent.push({
      type: "text",
      text:
        `Question:\n${question}\n\n` +
        `Context:\n` +
        `- Exam Type: ${examType || "GS"}\n` +
        (timeLimit ? `- Time Limit (mins): ${timeLimit}\n` : "") +
        `- Max Marks: ${maxMarks}\n\n` +
        `Candidate Answer (compiled text sections follow).`
    });

    if (texts.length) {
      const bigText = texts.map(t => `\n\n[Source: ${t.source || "unknown"}]\n${t.text}`).join("\n");
      // Trim very long text to avoid runaway tokens
      const trimmed = bigText.length > 150000 ? bigText.slice(0, 150000) + "\n...[trimmed]" : bigText;
      userContent.push({ type: "text", text: trimmed });
    }

    if (images.length) {
      // Append images for OCR where text extraction failed/scanned
      for (const img of images.slice(0, 12)) {
        userContent.push({
          type: "image_url",
          image_url: { url: img.dataUrl } // data: URL from client
        });
      }
      userContent.push({ type: "text", text: "If images contain handwriting or printed text, perform OCR before evaluation." });
    }

    const systemPrompt = `
You are a strict evaluator for UPSC/OPSC mains-style answers.

INSTRUCTIONS (apply rigorously):
- Assume zero grace: award marks only for content that is relevant, accurate, and well-structured.
- Penalize factual errors, poor structure, generic filler, missing intro/conclusion, lack of subheadings, absence of examples/case laws/commissions, poor handwriting legibility (if OCR shows unclear text).
- Require answer to address ALL parts of the question with logical flow and prioritization.

RUBRIC (0–100; be strict):
- content_relevance_accuracy: 40
- analysis_depth_linkages: 20
- structure_intro_body_conclusion: 15
- use_of_examples_cases_data_diagrams: 10
- clarity_language_and_presentation: 10
- value_add (keywords, committees, constitutional articles, recent reports): 5

OUTPUT: JSON ONLY with this schema:
{
  "rawOutOf100": number,             // 0-100
  "rubric": {
    "content_relevance_accuracy": number,
    "analysis_depth_linkages": number,
    "structure_intro_body_conclusion": number,
    "use_of_examples_cases_data_diagrams": number,
    "clarity_language_and_presentation": number,
    "value_add": number
  },
  "strengths": [string, ...],
  "weaknesses": [string, ...],
  "suggestions": [string, ...],
  "inline_comments": [string, ...]   // numbered or section-tagged comments
}

NOTES:
- Ensure rubric subtotal equals rawOutOf100 (consistency check).
- No prose outside JSON. No markdown. No extra keys.
- Keep comments concise and actionable.
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const rawOutOf100 = clampNumber(parsed.rawOutOf100, 0, 100);
    const maxMarks = Number(body.maxMarks);
    // scale 0–100 to 0–maxMarks
    const totalScaled = Math.round((rawOutOf100 / 100) * maxMarks);

    const resp = {
      rawOutOf100,
      rubric: parsed.rubric || {},
      strengths: parsed.strengths || [],
      weaknesses: parsed.weaknesses || [],
      suggestions: parsed.suggestions || [],
      inline_comments: parsed.inline_comments || [],
      totalScaled,
      maxMarks
    };

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify(resp));
  } catch (err) {
    console.error(err);
    return res.status(500).send(err?.message || "Internal error");
  }
};

// ---------- helpers ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function clampNumber(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
