import Tesseract from 'tesseract.js';
import fs from 'fs';

async function runOCR() {
  console.log('Loading image...');
  const imagePath = './data/temp/page-01.png';
  
  console.log('Running OCR (this may take a minute)...');
  const result = await Tesseract.recognize(imagePath, 'eng', {
    logger: m => {
      if (m.status === 'recognizing text') {
        process.stdout.write(`\rProgress: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  
  console.log('\n\nConfidence:', result.data.confidence);
  console.log('Text length:', result.data.text.length);
  console.log('\n--- OCR TEXT OUTPUT ---\n');
  console.log(result.data.text);
}

runOCR();
