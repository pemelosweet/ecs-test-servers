// 知识库文档解析 + 切块（纯函数，不依赖 Parse，便于单测）
// 支持：txt / Markdown / PDF / Word(.docx) / Excel(.xlsx)

// 根据 MIME 类型解析文件 buffer → 纯文本
async function parseDocument(buffer, mimeType, fileName = '') {
  const type = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  let values = '';
  // txt / markdown 直接按 UTF-8 读
  if (
    type.includes('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.markdown')
  ) {
    return buffer.toString('utf-8');
  }

  // PDF
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result?.text || '';
  }

  // Word (.docx)
  if (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  // Excel (.xlsx)
  if (
    type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    name.endsWith('.xlsx')
  ) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    return wb.SheetNames.map((sheetName) => {
      const ws = wb.Sheets[sheetName];
      return `# ${sheetName}\n${XLSX.utils.sheet_to_csv(ws)}`;
    }).join('\n\n');
  }

  throw new Error(`不支持的文档格式：${mimeType || fileName || '未知'}`);
}

// Markdown 标题行：# ~ ###### + 空格 + 文本
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

// 按标题行切分章节，并维护标题路径栈（如「公司规章制度手册 > 2. 考勤管理」）
// 无标题的纯文本退化为单个空路径章节，走原有段落聚合逻辑
function splitByHeadings(source) {
  const sections = [];
  const stack = []; // [{ level, text }]
  let body = [];

  const flush = () => {
    const text = body.join('\n').trim();
    if (text) {
      sections.push({ path: stack.map((s) => s.text).join(' > '), body: text });
    }
    body = [];
  };

  for (const line of source.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line.trim());
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2] });
    } else {
      body.push(line);
    }
  }
  flush();

  if (!sections.length) sections.push({ path: '', body: source });
  return sections;
}

// 章节内切块：空行分段聚合短段落，超长再硬切（带重叠防拦腰截断）
function splitBody(body, maxLen, overlap) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const merged = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > maxLen) {
      merged.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) merged.push(current);

  const out = [];
  for (const c of merged) {
    if (c.length <= maxLen) {
      out.push(c);
      continue;
    }
    let start = 0;
    while (start < c.length) {
      const end = Math.min(start + maxLen, c.length);
      out.push(c.slice(start, end));
      if (end >= c.length) break;
      start = end - overlap;
    }
  }
  return out;
}

// 文本切块：标题感知分段（章节不混杂）+ 块首附标题路径（召回单块也带完整上下文）
function chunkText(text, { maxLen = 600, overlap = 80 } = {}) {
  const source = String(text || '').trim();
  if (!source) return [];

  const chunks = [];
  for (const { path, body } of splitByHeadings(source)) {
    for (const piece of splitBody(body, maxLen, overlap)) {
      chunks.push(path ? `${path}\n${piece}` : piece);
    }
  }

  return chunks.map((content) => ({
    content,
    tokenCount: Math.ceil(content.length / 1.5), // 中文场景 token 近似估算
  }));
}

module.exports = { parseDocument, chunkText };
