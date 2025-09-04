// netlify/functions/evaluate.mjs
import OpenAI from "openai";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: "OPENAI_API_KEY is not set" };
    }
    const client = new OpenAI({ apiKey });

    const body = JSON.parse(event.body || "{}");
    const { question, maxMarks, examType, timeLimit, texts = [], images = [] } = body;

    if (!question || !maxMarks) {
      return { statusCode: 400, body: "Missing question or maxMarks" };
    }

    // Build user content (prefer extracted text; add images for OCR)
    const userContent = [{
      type: "text",
      text:
        `Question:\n${question}\n\n` +
        `Context:\n- Exam Type: ${examType || "GS"}\n` +
        (timeLimit ? `- Time Limit (mins): ${timeLimit}\n` : "") +
        `- Max Marks: ${maxMarks}\n\n` +
        `Candidate Answer (compiled text sections follow).`
    }];

    if (texts.length) {
      const bigText = texts.map(t => `\n\n[Source: ${t.source || "unknown"}]\n${t.text}`).join("\n");
      const trimmed = bigText.length > 150000 ? bigText.slice(0, 150000) + "\n...[trimmed]" : bigText;
      userContent.push({ type: "text", text: trimmed });
    }

    if (images.length) {
      for (const img of images.slice(0, 12)) {
        userContent.push({ type: "image_url", image_url: { url: img.dataUrl } });
      }
      userContent.push({ type: "text", text: "If images contain handwriting or printed text, perform OCR before evaluation." });
    }

    const systemPrompt = `
You are a strict evaluator for UPSC/OPSC mains-style answers.

INSTRUCTIONS (apply rigorously):
- Award marks only for relevant, accurate, well-structured content.
- Penalize factual errors, poor structure, filler, missing intro/conclusion, lack of examples/case laws/reports, weak presentation/legibility.

RUBRIC (0–100):
- content_relevance_accuracy: 40
- analysis_depth_linkages: 20
- structure_intro_body_conclusion: 15
- use_of_examples_cases_data_diagrams: 10
- clarity_language_and_presentation: 10
- value_add: 5

OUTPUT: JSON ONLY:
{
  "rawOutOf100": number,
  "rubric": {
    "content_relevance_accuracy": number,
    "analysis_depth_linkages": number,
    "structure_intro_body_conclusion": number,
    "use_of_examples_cases_data_diagrams": number,
    "clarity_language_and_presentation": number,
    "value_add": number
  },
  "strengths": [string],
  "weaknesses": [string],
  "suggestions": [string],
  "inline_comments": [string]
}
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

    // Parse + scale
    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const rawOutOf100 = clamp(parsed.rawOutOf100, 0, 100);
    const scaled = Math.round((rawOutOf100 / 100) * Number(maxMarks));

    const resp = {
      rawOutOf100,
      rubric: parsed.rubric || {},
      strengths: parsed.strengths || [],
      weaknesses: parsed.weaknesses || [],
      suggestions: parsed.suggestions || [],
      inline_comments: parsed.inline_comments || [],
      totalScaled: scaled,
      maxMarks: Number(maxMarks)
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resp)
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err?.message || "Internal error" };
  }
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
