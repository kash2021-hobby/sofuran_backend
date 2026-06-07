const { Article } = require('./models');
const { extractPoemLayout } = require('./utils/layoutProcessor');
const path = require('path');
const fs = require('fs');

async function test() {
  const article = await Article.findByPk(12);
  console.log("Article:", article.title);
  
  const pageTypes = JSON.parse(article.pageTypes || '[]');
  const pageUrls = JSON.parse(article.pages || '[]');
  const pageTexts = JSON.parse(article.pageTexts || '[]');
  
  console.log("Page 6 type:", pageTypes[5]); // 0-indexed, so 5 is page 6
  console.log("Page 6 text flow length:", pageTexts[5] ? pageTexts[5].length : 0);
  console.log("Page 6 text blocks:", JSON.stringify(pageTexts[5], null, 2));
}

test().catch(console.error);
