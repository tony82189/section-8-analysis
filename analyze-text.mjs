import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

async function extractText(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = new Uint8Array(buffer);
  
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  
  console.log('Total pages:', pdf.numPages);
  
  let fullText = '';
  const maxPages = Math.min(5, pdf.numPages);
  
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map(item => item.str)
      .join(' ');
    fullText += `\n--- PAGE ${i} ---\n` + pageText;
  }
  
  return fullText;
}

async function analyze() {
  const pdfPath = './data/uploads/Section8List12_19_25.pdf';
  const buffer = fs.readFileSync(pdfPath);
  console.log('File size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
  
  try {
    const text = await extractText(pdfPath);
    console.log('\nText length:', text.length, 'characters');
    console.log('Has selectable text:', text.trim().length > 200);
    console.log('\n--- EXTRACTED TEXT (first 8000 chars) ---\n');
    console.log(text.substring(0, 8000));
  } catch (e) {
    console.log('Error:', e.message, e.stack);
  }
}

analyze();
