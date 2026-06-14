// multimodal.mjs — pure builders that turn a tool's `multimodal` marker into the message blocks
// OpenRouter expects. Kept separate from tools/loop so it is unit-testable with no LLM and no FS.
//
// A tool (view_image / view_pdf in tools.mjs) returns result.multimodal = { kind, ... }. The loop
// calls buildMultimodalContent() to produce the ARRAY `content` for the user message it pushes, and
// pdfPluginNeeded() to decide whether to attach the OpenRouter file-parser plugin on the next call.

// Build the content ARRAY for a user message that carries an attachment so the model can SEE it.
//   image: [{type:'text',...},{type:'image_url',image_url:{url:'data:image/<ext>;base64,...'}}]
//   pdf:   [{type:'text',...},{type:'file',file:{filename,file_data:'data:application/pdf;base64,...'}}]
export function buildMultimodalContent(mm) {
  if (!mm || typeof mm !== "object") return null;
  if (mm.kind === "image") {
    if (!mm.dataUrl) return null;
    return [
      { type: "text", text: `(attached image ${mm.path})` },
      { type: "image_url", image_url: { url: mm.dataUrl } },
    ];
  }
  if (mm.kind === "pdf") {
    if (!mm.dataUrl) return null;
    return [
      { type: "text", text: `(attached pdf ${mm.path})` },
      { type: "file", file: { filename: mm.filename || "document.pdf", file_data: mm.dataUrl } },
    ];
  }
  return null;
}

// Does this messages[] thread contain a PDF file block? If so the request must carry the
// file-parser plugin so OpenRouter extracts the PDF text for the model.
export function hasPdfInContext(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      if (block && block.type === "file" && block.file && typeof block.file.file_data === "string"
          && block.file.file_data.startsWith("data:application/pdf")) return true;
    }
  }
  return false;
}

// The OpenRouter plugin spec for parsing in-context PDFs (engine 'pdf-text' = cheap text extraction).
export const PDF_PLUGIN = { id: "file-parser", pdf: { engine: "pdf-text" } };
