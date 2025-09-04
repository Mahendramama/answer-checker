// public/app.js
// Frontend pipeline:
// - Gather files
// - For PDFs: try text extraction with pdf.js; if text too short, render selected pages to images for OCR
// - For DOCX: use mammoth to extract text
// - For PPTX: unzip and read slide XML text
// - For PNG/JPG: pass as images for OCR
// - Send {texts[], images[]} to backend for evaluation (OpenAI key stays server-side)

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");
const fileList = document.getElementById("fileList");
const evaluateBtn = document.getElementById("evaluateBtn");
const busy = document.getElementById("busy");
const result = document.getElementById("result");
const scoreCard = document.getElementById("scoreCard");
const breakdown = document.getElementById("breakdown");
const feedback = document.getElementById("feedback");

let files = [];

browseBtn.addEventListener("click", (e) => {
  e.preventDefault();
  fileInput.click();
});

dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("bg-gray-100");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("bg-gray-100"));

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("bg-gray-100");
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

function handleFiles(fileListObj) {
  for (const f of fileListObj) {
    if (!isAllowed(f)) continue;
    files.push(f);
  }
  renderFileList();
}

function isAllowed(f) {
  const ok = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
    "image/png",
    "image/jpeg",
  ];
  if (!ok.includes(f.type) && !f.name.toLowerCase().endsWith(".pptx") && !f.name.toLowerCase().endsWith(".docx") && !f.name.toLowerCase().endsWith(".pdf")) {
    alert(`Unsupported: ${f.name}`);
    return false;
  }
  return true;
}

function renderFileList() {
  fileList.innerHTML = "";
  files.slice(0, 10).forEach((f, idx) => {
    const li = document.createElement("li");
    li.className = "flex items-center justify-between bg-white rounded-lg border p-3";
    li.innerHTML = `
      <div class="text-sm">
        <div class="font-medium">${f.name}</div>
        <div class="text-gray-500">${f.type || "unknown"} · ${(f.size/1024/1024).toFixed(2)} MB</div>
      </div>
      <button class="text-red-600 text-sm underline" data-idx="${idx}">remove</button>
    `;
    li.querySelector("button").addEventListener("click", (e) => {
      const i = Number(e.target.getAttribute("data-idx"));
      files.splice(i, 1);
      renderFileList();
    });
    fileList.appendChild(li);
  });
}

evaluateBtn.addEventListener("click", async () => {
  const question = document.getElementById("question").value.trim();
  const maxMarks = Number(document.getElementById("maxMarks").value || 0);
  const examType = document.getElementById("examType").value;
  const timeLimit = document.getElementById("timeLimit").value ? Number(document.getElementById("timeLimit").value) : null;

  if (!question) return alert("Please paste the exact question.");
  if (!maxMarks || maxMarks <= 0) return alert("Enter valid Max Marks.");

  busy.classList.remove("hidden");
  evaluateBtn.disabled = true;
  result.classList.add("hidden");
  scoreCard.innerHTML = breakdown.innerHTML = feedback.innerHTML = "";

  try {
    // Extract texts & images
    const texts = [];
    const images = []; // {mime, dataUrl}
    for (const f of files.slice(0, 10)) {
      const ext = f.name.toLowerCase().split(".").pop();
      if (f.type.startsWith("image/")) {
        const dataUrl = await fileToDataURL(f, 0.8);
        images.push({ mime: f.type, dataUrl });
      } else if (ext === "pdf") {
        const { text, pagesAsImages } = await extractFromPDF(f);
        if (text && text.trim().length > 500) {
          texts.push({ source: f.name, text });
        } else {
          // fallback: send up to first 8 rendered pages to OCR
          for (let i = 0; i < Math.min(pagesAsImages.length, 8); i++) {
            images.push({ mime: "image/jpeg", dataUrl: pagesAsImages[i] });
          }
        }
      } else if (ext === "docx") {
        const text = await extractFromDOCX(f);
        if (text && text.trim().length > 0) texts.push({ source: f.name, text });
      } else if (ext === "pptx") {
        const text = await extractFromPPTX(f);
        if (text && text.trim().length > 0) texts.push({ source: f.name, text });
      }
    }

    const payload = {
      question,
      maxMarks,
      examType,
      timeLimit,
      texts,
      images, // OCR will be done server-side via OpenAI Vision
    };

    const res = await fetch("/.netlify/functions/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || "Server error");
    }
    const data = await res.json();
    renderResult(data);

  } catch (err) {
    alert(`Error: ${err.message || err}`);
  } finally {
    busy.classList.add("hidden");
    evaluateBtn.disabled = false;
  }
});

function renderResult(data) {
  result.classList.remove("hidden");
  const { totalScaled, maxMarks, rawOutOf100, rubric, strengths, weaknesses, suggestions, inline_comments } = data;

  scoreCard.innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-gray-50 rounded-lg p-3">
        <div class="text-sm text-gray-500">Final Score</div>
        <div class="text-2xl font-semibold">${totalScaled}/${maxMarks}</div>
        <div class="text-xs text-gray-500">Raw: ${rawOutOf100}/100 (scaled)</div>
      </div>
      <div class="bg-gray-50 rounded-lg p-3">
        <div class="text-sm text-gray-500">Strict UPSC/OPSC Rubric</div>
        <div class="text-xs">Content, Analysis, Structure, Examples, Language, Presentation, Intro/Conclusion</div>
      </div>
    </div>
  `;

  breakdown.innerHTML = `
    <h3 class="font-medium mt-2">Breakdown (0–100):</h3>
    <ul class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
      ${Object.entries(rubric).map(([k,v]) => `
        <li class="bg-white border rounded p-2 flex justify-between"><span class="capitalize">${k.replaceAll('_',' ')}</span><span class="font-semibold">${v}</span></li>
      `).join("")}
    </ul>
  `;

  feedback.innerHTML = `
    <h3 class="font-medium mt-4">Feedback</h3>
    <div class="mt-2">
      <div class="mb-2"><strong>Strengths:</strong> ${bullet(strengths)}</div>
      <div class="mb-2"><strong>Weaknesses:</strong> ${bullet(weaknesses)}</div>
      <div class="mb-2"><strong>Suggestions:</strong> ${bullet(suggestions)}</div>
      ${inline_comments?.length ? `<div class="mt-3"><strong>Inline/Section Comments:</strong> ${bullet(inline_comments)}</div>` : ""}
    </div>
  `;
}

function bullet(list) {
  if (!list || !list.length) return "<span class='text-gray-500'>—</span>";
  return `<ul class="list-disc ml-5">${list.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function escapeHtml(s){return s.replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));}

// ---------- Helpers ----------

function fileToDataURL(file, quality=0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const ext = file.name.toLowerCase().split(".").pop();
    if (file.type.startsWith("image/")) {
      reader.onload = () => resolve(reader.result); // already dataURL
      reader.onerror = reject;
      reader.readAsDataURL(file);
    } else {
      // not used here
      reject(new Error("Not an image"));
    }
  });
}

async function extractFromPDF(file) {
  const arrayBuf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  let fullText = "";
  const pagesAsImages = []; // OCR fallback
  // Try text extraction
  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(it => it.str).join(" ");
    fullText += `\n\n[Page ${i}] ${pageText}`;
  }
  // If text is too short, render pages to images (JPEG compressed)
  if (!fullText || fullText.trim().length < 500) {
    for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      pagesAsImages.push(dataUrl);
    }
  }
  return { text: fullText, pagesAsImages };
}

async function extractFromDOCX(file) {
  const arrayBuf = await file.arrayBuffer();
  const res = await window.mammoth.extractRawText({ arrayBuffer: arrayBuf });
  return res.value || "";
}

async function extractFromPPTX(file) {
  // Read slide XML -> collect <a:t>text</a:t>
  const arrayBuf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuf);
  const slideFiles = Object.keys(zip.files).filter(p => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"));
  slideFiles.sort((a,b) => {
    const na = Number(a.match(/slide(\d+)\.xml/)?.[1] || 0);
    const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] || 0);
    return na - nb;
  });
  let text = "";
  for (const path of slideFiles.slice(0, 40)) {
    const xml = await zip.files[path].async("string");
    const matches = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
    const pageText = matches.map(m => m[1]).join(" ");
    const slideNo = path.match(/slide(\d+)\.xml/)?.[1] || "?";
    text += `\n\n[Slide ${slideNo}] ${pageText}`;
  }
  return text;
}
