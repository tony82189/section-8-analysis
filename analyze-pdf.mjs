import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

async function analyze() {
  const pdfPath = './data/uploads/Section8List12_19_25.pdf';
  
  const buffer = fs.readFileSync(pdfPath);
  console.log('File size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
  
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    console.log('\nTotal pages:', pdfDoc.getPageCount());
    
    const page1 = pdfDoc.getPage(0);
    const { width, height } = page1.getSize();
    console.log('Page 1 size:', width, 'x', height);
    
    console.log('\nPDF loaded successfully - this is a valid PDF');
  } catch (e) {
    console.log('Error:', e.message);
  }
}

analyze();
