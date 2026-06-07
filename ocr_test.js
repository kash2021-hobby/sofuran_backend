const { createWorker } = require('tesseract.js');

async function testOCR() {
  console.log('Initializing Tesseract worker...');
  const worker = await createWorker('asm');
  console.log('Worker initialized. Running OCR on img-000.jpg...');
  const { data: { text } } = await worker.recognize('uploads/images/1779196903327-Feb_26/img-000.jpg');
  console.log('--- Extracted Text ---');
  console.log(text);
  console.log('----------------------');
  await worker.terminate();
}

testOCR().catch(err => console.error('OCR Error:', err));
