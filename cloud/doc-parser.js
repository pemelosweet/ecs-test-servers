// 知识库文档解析 + 切块（纯函数，不依赖 Parse，便于单测）
// 支持：txt / Markdown / PDF / Word(.docx) / Excel(.xlsx)

// 根据 MIME 类型解析文件 buffer → 纯文本
async function parseDocument(buffer, mimeType, fileName = '') {
  console.log(buffer, mimeType, fileName,'===进行文档解析');
  
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

// 文本切块：先按段落聚合，超长再硬切（带重叠），保证语义尽量完整
function chunkText(text, { maxLen = 600, overlap = 80 } = {}) {
  const source = String(text || '').trim();
  if (!source) return [];

  // 1. 按空行分段，聚合短段落
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const merged = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length > maxLen) {
      merged.push(current.trim());
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) merged.push(current.trim());

  // 2. 超长段落硬切（带重叠，防语义拦腰截断）
  const chunks = [];
  for (const c of merged) {
    if (c.length <= maxLen) {
      chunks.push(c);
      continue;
    }
    let start = 0;
    while (start < c.length) {
      const end = Math.min(start + maxLen, c.length);
      chunks.push(c.slice(start, end));
      if (end >= c.length) break;
      start = end - overlap;
    }
  }

  return chunks.map((content) => ({
    content,
    tokenCount: Math.ceil(content.length / 1.5), // 中文场景 token 近似估算
  }));
}

module.exports = { parseDocument, chunkText };
