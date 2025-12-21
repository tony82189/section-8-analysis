const fs = require('fs');

async function analyze() {
  const pdfParse = (await import('pdf-parse')).default;
  const pdfPath = './data/uploads/Section8List12_19_25.pdf';
  
  const buffer = fs.readFileSync(pdfPath);
  console.log('File size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
  
  try {
    const data = await pdfParse(buffer, { max: 5 });
    console.log('\nTotal pages:', data.numpages);
    console.log('Has selectable text:', data.text.trim().length > 100);
    console.log('Text length from first 5 pages:', data.text.length, 'characters');
    console.log('\n--- SAMPLE TEXT (first 5000 chars) ---\n');
    console.log(data.text.substring(0, 5000));
  } catch (e) {
    console.log('Error:', e.message);
  }
}

analyze();
