const { Article } = require('./models');
const { extractPoemLayout } = require('./utils/layoutProcessor');
const path = require('path');
const fs = require('fs');

async function test() {
  const article = await Article.findByPk(12);
  const filePath = path.join(__dirname, 'uploads/pdfs', article.uploadedPdf);
  const baseName = path.basename(filePath, path.extname(filePath));
  const imagesDir = path.join(__dirname, 'uploads/images', baseName);
  
  // Page 6 is file page-06.png (or page-6.png)
  const files = fs.readdirSync(imagesDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
      
  const pageFile = files[5];
  const pageImagePath = path.join(imagesDir, pageFile);
  
  console.log("Testing live layout on:", pageImagePath);
  
  // Fake empty OCR text so Gemini Vision does it
  const pageRawText = ""; 
  const result = await extractPoemLayout(pageImagePath, pageRawText, article.id, 6);
  
  console.log(JSON.stringify(result, null, 2));
}

test().catch(console.error);
