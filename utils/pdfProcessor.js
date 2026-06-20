const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { extractStructuredLayout, extractPoemLayout } = require('./layoutProcessor');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract PDF page count and metadata using pdfinfo
const getPdfInfo = async (filePath) => {
  try {
    const { stdout } = await execPromise(`pdfinfo "${filePath}"`);
    const pagesMatch = stdout.match(/Pages:\s+(\d+)/);
    const titleMatch = stdout.match(/Title:\s+(.+)/);
    
    return {
      pageCount: pagesMatch ? parseInt(pagesMatch[1]) : 0,
      title: titleMatch ? titleMatch[1].trim() : null
    };
  } catch (error) {
    console.error('Error running pdfinfo:', error);
    return { pageCount: 0, title: null };
  }
};

// Initial fast metadata retrieval for uploaded PDF
const processPdf = async (filePath) => {
  try {
    const info = await getPdfInfo(filePath);
    return {
      title: info.title || path.basename(filePath, path.extname(filePath)),
      pageCount: info.pageCount,
      summary: 'Processing digital magazine pages...',
      readTime: Math.max(1, Math.ceil(info.pageCount * 1.5))
    };
  } catch (error) {
    console.error('Error processing PDF metadata:', error);
    throw new Error('Failed to parse PDF metadata');
  }
};

/**
 * STEP 1: Render PDF pages to PNG images only.
 * Does NOT start OCR or Gemini processing.
 * Returns page image URLs so the frontend can show them for classification.
 */
const renderPdfPagesOnly = async (filePath, articleId, Article) => {
  const baseName = path.basename(filePath, path.extname(filePath));
  const imagesDir = path.join(__dirname, '../uploads/images', baseName);
  
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  try {
    console.log(`[Renderer] Starting pdftoppm for ${filePath}...`);
    // Convert PDF pages to high-resolution PNG
    // -r 200 gives ultra-sharp text resolution (33% sharper than 150 DPI) for mobile zooming
    // -thinlinemode solid makes thin lines in comics and illustrations stand out clearly
    await execPromise(`pdftoppm -png -r 200 -thinlinemode solid "${filePath}" "${imagesDir}/page"`);

    const files = fs.readdirSync(imagesDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0]);
        const numB = parseInt(b.match(/\d+/)[0]);
        return numA - numB;
      });

    console.log(`[Renderer] Successfully rendered ${files.length} pages.`);

    const pageUrls = files.map(file => `/uploads/images/${baseName}/${file}`);

    // Save page URLs and set status to awaiting_classification
    await Article.update({
      pages: JSON.stringify(pageUrls),
      heroImage: pageUrls[0] || null,
      pageCount: pageUrls.length,
      readTime: Math.max(1, Math.ceil(pageUrls.length * 1.5)),
      ocrStatus: 'awaiting_classification'
    }, { where: { id: articleId } });

    console.log(`[Renderer] Article ${articleId}: ${pageUrls.length} pages rendered. Awaiting publisher classification.`);
    return pageUrls;

  } catch (error) {
    console.error(`[Renderer] Error rendering pages for article ${articleId}:`, error);
    await Article.update({ ocrStatus: 'failed' }, { where: { id: articleId } });
    throw error;
  }
};

/**
 * STEP 2: Process pages based on publisher classification.
 * Called after the publisher submits their page type selections.
 * 
 * @param {number} articleId - Article ID
 * @param {string[]} pageTypes - Array of page types: "cover", "poem", "normal"
 * @param {Object} Article - Sequelize Article model
 */
const processClassifiedPages = async (articleId, pageTypes, Article, agent = 'default') => {
  try {
    const article = await Article.findByPk(articleId);
    if (!article || !article.uploadedPdf) {
      throw new Error(`Article ${articleId} not found or has no PDF`);
    }

    const filePath = path.join(__dirname, '../uploads/pdfs', article.uploadedPdf);
    const baseName = path.basename(filePath, path.extname(filePath));
    const imagesDir = path.join(__dirname, '../uploads/images', baseName);
    const pageUrls = article.pages ? JSON.parse(article.pages) : [];

    // Update status to processing
    await Article.update({ 
      ocrStatus: 'processing',
      pageTypes: JSON.stringify(pageTypes)
    }, { where: { id: articleId } });

    console.log(`[Processor] Starting classified processing for article ${articleId} (Agent: ${agent}, ${pageUrls.length} pages)...`);

    // Check for OCR availability
    let useOcr = false;
    try {
      await execPromise('which tesseract');
      useOcr = true;
      console.log('[Processor] Tesseract OCR found.');
    } catch (e) {
      console.log('[Processor] Tesseract OCR not found. Falling back to pdftotext.');
    }

    const files = fs.existsSync(imagesDir) 
      ? fs.readdirSync(imagesDir)
          .filter(f => f.startsWith('page-') && f.endsWith('.png'))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
      : [];

    const pageTexts = [];

    // Find the first cover page to use as hero image
    let heroImage = pageUrls[0] || null;
    const firstCoverIndex = pageTypes.indexOf('cover');
    if (firstCoverIndex !== -1 && pageUrls[firstCoverIndex]) {
      heroImage = pageUrls[firstCoverIndex];
    }

    for (let i = 0; i < pageUrls.length; i++) {
      const pageType = pageTypes[i] || 'normal';
      const pageNum = i + 1;
      const pageImagePath = files[i] ? path.join(imagesDir, files[i]) : '';

      console.log(`[Processor] Page ${pageNum}/${pageUrls.length} — type: ${pageType}`);

      if (pageType === 'cover') {
        // COVER: No OCR, no Gemini. Just store the page image reference.
        pageTexts.push({
          contentType: 'cover',
          confidence: 1.0,
          blocks: [{ type: 'cover', src: pageUrls[i] }]
        });
        console.log(`[Processor] Page ${pageNum}: Cover page — using raw image.`);

      } else if (pageType === 'poem') {
        // POEM: Use Gemini with poem-specific prompt for formatting preservation
        let pageRawText = '';
        if (useOcr && pageImagePath && fs.existsSync(pageImagePath)) {
          try {
            console.log(`[Processor] Running OCR on poem page ${pageNum}...`);
            const { stdout } = await execPromise(`tesseract "${pageImagePath}" stdout -l eng+asm+ben --oem 1 --psm 3`);
            pageRawText = stdout.trim();
          } catch (err) {
            console.error(`[Processor] OCR failed for poem page ${pageNum}:`, err);
          }
        } else {
          try {
            const { stdout } = await execPromise(`pdftotext -f ${pageNum} -l ${pageNum} "${filePath}" -`);
            pageRawText = stdout.trim();
          } catch (err) {
            console.error(`[Processor] pdftotext failed for poem page ${pageNum}:`, err);
          }
        }

        if (pageImagePath && fs.existsSync(pageImagePath)) {
          const poemFlow = await extractPoemLayout(pageImagePath, pageRawText, articleId, pageNum, agent);
          pageTexts.push(poemFlow);
        } else {
          pageTexts.push({
            contentType: 'poetry',
            confidence: 1.0,
            blocks: [{ type: 'text', format: 'poem', content: pageRawText }]
          });
        }

        // No artificial rate limit needed for paid tier (handled by automatic retry logic if necessary)

      } else {
        // NORMAL: Current flow — OCR text + Gemini layout analysis
        let pageRawText = '';
        if (useOcr && pageImagePath && fs.existsSync(pageImagePath)) {
          try {
            console.log(`[Processor] Running OCR on page ${pageNum}...`);
            const { stdout } = await execPromise(`tesseract "${pageImagePath}" stdout -l eng+asm+ben --oem 1 --psm 3`);
            pageRawText = stdout.trim();
          } catch (err) {
            console.error(`[Processor] OCR failed for page ${pageNum}:`, err);
          }
        } else {
          try {
            const { stdout } = await execPromise(`pdftotext -f ${pageNum} -l ${pageNum} "${filePath}" -`);
            pageRawText = stdout.trim();
          } catch (err) {
            console.error(`[Processor] pdftotext failed for page ${pageNum}:`, err);
          }
        }

        if (pageImagePath && fs.existsSync(pageImagePath)) {
          const layoutFlow = await extractStructuredLayout(pageImagePath, pageRawText, articleId, pageNum, agent);
          pageTexts.push(layoutFlow);
        } else {
          pageTexts.push({
            contentType: 'article',
            confidence: 1.0,
            blocks: [{ type: 'text', format: 'paragraph', content: pageRawText }]
          });
        }

        // No artificial rate limit needed for paid tier (handled by automatic retry logic if necessary)
      }

      // Save page progress to database immediately (live updates for the frontend)
      await Article.update({
        pageTexts: JSON.stringify(pageTexts)
      }, { where: { id: articleId } });
    }

    console.log(`[Processor] All ${pageTexts.length} pages processed for article ${articleId}.`);

    // Fetch latest article for summary check
    const articleInstance = await Article.findByPk(articleId);
    
    if (articleInstance) {
      const isTempSummary = !articleInstance.summary || 
        articleInstance.summary.includes('Preparing high-fidelity') || 
        articleInstance.summary === 'Processing digital magazine pages...';

      const finalSummary = isTempSummary 
        ? `A high-fidelity digital magazine edition with ${pageUrls.length} pages.`
        : articleInstance.summary;

      // Auto-generate Table of Contents / Index
      const tableOfContents = [];
      pageTexts.forEach((pageData, idx) => {
        const pageBlocks = pageData && Array.isArray(pageData.blocks) ? pageData.blocks : (Array.isArray(pageData) ? pageData : []);
        pageBlocks.forEach(block => {
          if (block.type === 'text' && (block.format === 'heading' || block.format === 'poem_title')) {
            const title = block.content.replace(/\n/g, ' ').trim();
            if (title && title.length > 2) {
              tableOfContents.push({ title, pageIndex: idx, pageNumber: idx + 1 });
            }
          }
        });
      });

      // Final update
      await Article.update({
        pageTexts: JSON.stringify(pageTexts),
        heroImage: heroImage,
        readTime: Math.max(1, Math.ceil(pageUrls.length * 1.5)),
        summary: finalSummary,
        ocrStatus: 'completed',
        tableOfContents: JSON.stringify(tableOfContents)
      }, { where: { id: articleId } });

      console.log(`[Processor] Article ${articleId} fully processed and ready.`);
    } else {
      console.log(`[Processor] Article ${articleId} no longer exists. Skipping final save.`);
    }

  } catch (error) {
    console.error(`[Processor] Error processing classified pages for article ${articleId}:`, error);
    await Article.update({ ocrStatus: 'failed' }, { where: { id: articleId } });
  }
};

/**
 * STEP 2.5: Reprocess a Single Page
 */
const processSingleClassifiedPage = async (articleId, pageIndex, Article, agent = 'default') => {
  try {
    const article = await Article.findByPk(articleId);
    if (!article || !article.uploadedPdf) return;

    const filePath = path.join(__dirname, '../uploads/pdfs', article.uploadedPdf);
    const baseName = path.basename(filePath, path.extname(filePath));
    const imagesDir = path.join(__dirname, '../uploads/images', baseName);
    
    let pageUrls = [];
    let pageTypes = [];
    let pageTexts = [];

    try { pageUrls = JSON.parse(article.pages || '[]'); } catch(e){}
    try { pageTypes = JSON.parse(article.pageTypes || '[]'); } catch(e){}
    try { pageTexts = JSON.parse(article.pageTexts || '[]'); } catch(e){}

    if (pageIndex < 0 || pageIndex >= pageUrls.length) return;

    const pageType = pageTypes[pageIndex] || 'normal';
    const pageNum = pageIndex + 1;
    
    const files = fs.existsSync(imagesDir) 
      ? fs.readdirSync(imagesDir)
          .filter(f => f.startsWith('page-') && f.endsWith('.png'))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
      : [];
      
    const pageImagePath = files[pageIndex] ? path.join(imagesDir, files[pageIndex]) : '';

    console.log(`[Processor] Reprocessing Single Page ${pageNum}/${pageUrls.length} — type: ${pageType}`);

    let useOcr = false;
    try { await execPromise('which tesseract'); useOcr = true; } catch (e) {}

    let newPageResult = [];

    if (pageType === 'cover') {
      newPageResult = [{ type: 'cover', src: pageUrls[pageIndex] }];
    } else {
      let pageRawText = '';
      if (useOcr && pageImagePath && fs.existsSync(pageImagePath)) {
        try {
          const { stdout } = await execPromise(`tesseract "${pageImagePath}" stdout -l eng+asm+ben --oem 1 --psm 3`);
          pageRawText = stdout.trim();
        } catch (err) {}
      } else {
        try {
          const { stdout } = await execPromise(`pdftotext -f ${pageNum} -l ${pageNum} "${filePath}" -`);
          pageRawText = stdout.trim();
        } catch (err) {}
      }

      if (pageImagePath && fs.existsSync(pageImagePath)) {
        if (pageType === 'poem') {
          newPageResult = await extractPoemLayout(pageImagePath, pageRawText, articleId, pageNum, agent);
        } else {
          newPageResult = await extractStructuredLayout(pageImagePath, pageRawText, articleId, pageNum, agent);
        }
      } else {
        newPageResult = [{ type: 'text', format: pageType === 'poem' ? 'poem' : 'paragraph', content: pageRawText }];
      }
    }

    if (!Array.isArray(pageTexts)) pageTexts = [];
    pageTexts[pageIndex] = newPageResult;

    await Article.update({
      pageTexts: JSON.stringify(pageTexts)
    }, { where: { id: articleId } });

    console.log(`[Processor] Successfully reprocessed page ${pageNum}`);
    return await Article.findByPk(articleId);

  } catch (err) {
    console.error(`[Processor] Error reprocessing single page ${pageIndex}:`, err);
    throw err;
  }
};

/**
 * Legacy: Background renderer for backward compatibility (used by reprocess).
 * Processes all pages as "normal" type.
 */
const renderPdfPages = async (filePath, articleId, Article, agent = 'default') => {
  // First render the page images
  await renderPdfPagesOnly(filePath, articleId, Article);
  
  // Then process all pages as "normal" (legacy behavior)
  const article = await Article.findByPk(articleId);
  const pageUrls = article.pages ? JSON.parse(article.pages) : [];
  const allNormal = pageUrls.map(() => 'normal');
  
  await processClassifiedPages(articleId, allNormal, Article, agent);
};

// Self-healing migration to extract text for existing uploaded PDFs
const reprocessExistingArticles = async (Article) => {
  try {
    const articles = await Article.findAll();
    
    let useOcr = false;
    try {
      await execPromise('which tesseract');
      useOcr = true;
      console.log('[Self-Heal] Tesseract OCR found. Will use high-accuracy Assamese OCR for self-healing.');
    } catch (e) {
      console.log('[Self-Heal] Tesseract OCR not found. Falling back to pdftotext.');
    }

    for (const article of articles) {
      // Skip articles awaiting classification — those are intentionally paused
      if (article.ocrStatus === 'awaiting_classification') {
        console.log(`[Self-Heal] Skipping article ${article.id} — awaiting publisher classification.`);
        continue;
      }

      let isPlainStringArray = false;
      let isIncomplete = false;
      let isOldLayoutFormat = false;
      try {
        if (article.pageTexts) {
          const parsed = JSON.parse(article.pageTexts);
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && parsed.some(page => typeof page === 'string')) {
              isPlainStringArray = true;
            }
            if (parsed.length < article.pageCount) {
              isIncomplete = true;
            }
            // Detect old layout format: blocks with type 'text' but no 'format' field
            if (parsed.length > 0 && parsed.some(page => 
              Array.isArray(page) && page.some(block => block.type === 'text' && !block.format)
            )) {
              isOldLayoutFormat = true;
            }
          }
        }
      } catch (e) {}

      const needsReprocessing = !article.pageTexts || 
        article.pageTexts === '[]' || 
        article.pageTexts === '' || 
        (useOcr && !/[\u0980-\u09FF]/.test(article.pageTexts)) ||
        (isPlainStringArray && process.env.GEMINI_API_KEY) ||
        (isIncomplete && process.env.GEMINI_API_KEY) ||
        (isOldLayoutFormat && process.env.GEMINI_API_KEY);

      if (article.uploadedPdf && needsReprocessing) {
        const filePath = path.join(__dirname, '../uploads/pdfs', article.uploadedPdf);
        const baseName = path.basename(filePath, path.extname(filePath));
        const imagesDir = path.join(__dirname, '../uploads/images', baseName);
        
        if (fs.existsSync(filePath)) {
          console.log(`[Self-Heal] Reprocessing text extraction for article ID ${article.id}...`);
          
          // If article has pageTypes, use classified processing. Otherwise treat all as normal.
          let pageTypes = [];
          try {
            if (article.pageTypes) {
              pageTypes = JSON.parse(article.pageTypes);
            }
          } catch (e) {}

          if (pageTypes.length === 0) {
            pageTypes = Array(article.pageCount).fill('normal');
          }

          await processClassifiedPages(article.id, pageTypes, Article);
        }
      }
    }
  } catch (error) {
    console.error('[Self-Heal] Error during self-healing text extraction:', error);
  }
};

module.exports = {
  processPdf,
  renderPdfPages,
  renderPdfPagesOnly,
  processClassifiedPages,
  processSingleClassifiedPage,
  reprocessExistingArticles
};
