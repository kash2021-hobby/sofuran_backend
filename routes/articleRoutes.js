const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { Article, User } = require('../models');
const { processPdf } = require('../utils/pdfProcessor');

// Multer setup for PDF upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/pdfs'));
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

/**
 * STEP 1: Upload PDF — renders pages to images, returns thumbnails for classification.
 * Does NOT start OCR/Gemini processing. Publisher must classify pages first.
 */
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Process the PDF metadata
    const pdfData = await processPdf(req.file.path);

    // Create the article in 'draft' status, awaiting classification
    const newArticle = await Article.create({
      title: req.body.title || pdfData.title || req.file.originalname.replace('.pdf', ''),
      summary: req.body.summary || 'Preparing high-fidelity digital magazine pages. Please wait...',
      content: '',
      heroImage: null,
      readTime: pdfData.readTime,
      status: 'draft', // Stay as draft until classification + processing is done
      uploadedPdf: req.file.filename,
      ocrStatus: 'processing', // Temporarily processing while we render page images
      authorId: 1,
      pageCount: pdfData.pageCount,
      pages: JSON.stringify([])
    });

    // Trigger background page image rendering (Step 1 only — no OCR/Gemini)
    const { renderPdfPagesOnly } = require('../utils/pdfProcessor');
    renderPdfPagesOnly(req.file.path, newArticle.id, Article);
    
    res.json({ 
      message: 'PDF uploaded. Page rendering started. Classify pages once ready.', 
      article: newArticle 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during upload and processing' });
  }
});

/**
 * STEP 2: Classify pages — publisher assigns type to each page, then processing begins.
 * Body: { pageTypes: ["cover", "normal", "poem", "normal", ...] }
 */
router.post('/:id/classify', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const { pageTypes } = req.body;
    if (!pageTypes || !Array.isArray(pageTypes)) {
      return res.status(400).json({ error: 'pageTypes must be an array of page type strings' });
    }

    const pageUrls = article.pages ? JSON.parse(article.pages) : [];
    if (pageTypes.length !== pageUrls.length) {
      return res.status(400).json({ 
        error: `pageTypes length (${pageTypes.length}) must match page count (${pageUrls.length})` 
      });
    }

    // Validate types
    const validTypes = ['cover', 'poem', 'normal'];
    for (const type of pageTypes) {
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid page type: "${type}". Must be one of: ${validTypes.join(', ')}` });
      }
    }

    // Save classification and update status
    await Article.update({
      pageTypes: JSON.stringify(pageTypes),
      ocrStatus: 'processing',
      status: 'draft' // Remain as draft until Publisher Reviews and publishes with monetization settings
    }, { where: { id: article.id } });

    // Trigger background classified processing
    const { processClassifiedPages } = require('../utils/pdfProcessor');
    const agent = req.body.agent || 'default';
    processClassifiedPages(article.id, pageTypes, Article, agent);

    res.json({ 
      message: 'Page classification saved. Processing started based on page types.',
      pageTypes 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during page classification' });
  }
});

// Get all published articles
router.get('/', async (req, res) => {
  try {
    const whereClause = req.query.publisher === 'true' ? {} : { status: 'published' };
    const articles = await Article.findAll({
      where: whereClause,
      order: [['createdAt', 'DESC']],
      include: [{ model: User, attributes: ['name'] }]
    });
    res.json(articles);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error fetching articles' });
  }
});

// Get single article by ID (works for both published and draft — needed for classification step)
router.get('/:id', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id, {
      include: [{ model: User, attributes: ['name'] }]
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    
    // Increment views only for published articles
    if (article.status === 'published') {
      article.views += 1;
      await article.save();
    }
    
    res.json(article);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error fetching article' });
  }
});

// Update page content directly (e.g. text replacements)
router.put('/:id/update-content', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    
    const { pageTexts } = req.body;
    if (!pageTexts) return res.status(400).json({ error: 'pageTexts is required' });

    article.pageTexts = pageTexts;
    await article.save();
    
    res.json({ message: 'Content updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error updating content' });
  }
});

// Delete article
router.delete('/:id', async (req, res) => {
  const fs = require('fs');
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Clean up filesystem files (PDF and extracted images folder)
    if (article.uploadedPdf) {
      const pdfPath = path.join(__dirname, '../uploads/pdfs', article.uploadedPdf);
      if (fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(pdfPath); } catch (e) { console.error('Failed to delete PDF file:', e); }
      }
      
      const baseName = article.uploadedPdf.replace('.pdf', '');
      const imagesDir = path.join(__dirname, '../uploads/images', baseName);
      if (fs.existsSync(imagesDir)) {
        try { fs.rmSync(imagesDir, { recursive: true, force: true }); } catch (e) { console.error('Failed to delete images dir:', e); }
      }
    }

    await article.destroy();
    res.json({ message: 'Article deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error deleting article' });
  }
});

// Reprocess Layout & OCR for a single article manually
router.post('/:id/reprocess', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.uploadedPdf) return res.status(400).json({ error: 'No PDF associated with this article' });

    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../uploads/pdfs', article.uploadedPdf);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }

    // Set article status to processing
    article.ocrStatus = 'processing';
    await article.save();

    // If article has page types, use classified processing. Otherwise legacy flow.
    let pageTypes = [];
    try {
      if (article.pageTypes) {
        pageTypes = JSON.parse(article.pageTypes);
      }
    } catch (e) {}

    const agent = req.body.agent || 'default';

    if (pageTypes.length > 0) {
      const { processClassifiedPages } = require('../utils/pdfProcessor');
      processClassifiedPages(article.id, pageTypes, Article, agent);
    } else {
      const { renderPdfPages } = require('../utils/pdfProcessor');
      renderPdfPages(filePath, article.id, Article, agent);
    }

    res.json({ message: 'Reprocessing started successfully', article });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error triggering reprocessing' });
  }
});

// Reprocess Layout & OCR for a SINGLE page
router.post('/:id/reprocess-page', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.uploadedPdf) return res.status(400).json({ error: 'No PDF associated with this article' });

    const pageIndex = parseInt(req.body.pageIdx, 10);
    if (isNaN(pageIndex) || pageIndex < 0) return res.status(400).json({ error: 'Invalid page index' });
    const agent = req.body.agent || 'default';

    const { processSingleClassifiedPage } = require('../utils/pdfProcessor');
    const updatedArticle = await processSingleClassifiedPage(article.id, pageIndex, Article, agent);
    res.json({ message: 'Reprocessing complete for page ' + (pageIndex + 1), pageTexts: updatedArticle.pageTexts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error triggering page reprocessing' });
  }
});

// Reprocess Layout & OCR for SELECTED pages (batch)
router.post('/:id/reprocess-selected', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.uploadedPdf) return res.status(400).json({ error: 'No PDF associated with this article' });

    const body = req.body || {};
    const pageIndexes = body.pageIndexes;
    if (!Array.isArray(pageIndexes) || pageIndexes.length === 0) {
      return res.status(400).json({ error: 'Please provide pageIndexes array' });
    }

    const { processSingleClassifiedPage } = require('../utils/pdfProcessor');
    
    // Process each selected page sequentially in background
    (async () => {
      for (const pageIndex of pageIndexes) {
        const idx = parseInt(pageIndex, 10);
        if (!isNaN(idx) && idx >= 0) {
          await processSingleClassifiedPage(article.id, idx, Article);
        }
      }
      console.log(`[Reprocess] Finished reprocessing ${pageIndexes.length} selected pages for article ${article.id}`);
    })();

    res.json({ 
      message: `Reprocessing started for ${pageIndexes.length} selected pages`,
      pages: pageIndexes.map(p => p + 1) 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error triggering batch reprocessing' });
  }
});

/**
 * Translate article to Hindi and English.
 * POST body (optional): { targetLangs: ["hi", "en"], originalLanguage: "as", agent: "chatgpt-4" }
 */
router.post('/:id/translate', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.pageTexts) return res.status(400).json({ error: 'Article has no text content to translate' });

    const body = req.body || {};
    const targetLangs = body.targetLangs || ['hi', 'en'];
    const originalLanguage = body.originalLanguage || article.originalLanguage || 'auto';
    const agent = body.agent || 'default';

    // Update original language if provided
    if (body.originalLanguage) {
      await Article.update({ originalLanguage }, { where: { id: article.id } });
    }

    // Start translation in background (non-blocking)
    const { translateArticle } = require('../utils/translator');
    translateArticle(article.id, targetLangs, Article, agent);

    res.json({
      message: `Translation started for article "${article.title}" → [${targetLangs.join(', ')}]`,
      originalLanguage,
      targetLangs,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error triggering translation' });
  }
});


/**
 * STEP 4: Finalize, Monetize & Publish
 * Body: { price: float, freePagesCount: int }
 */
router.post('/:id/monetize-and-publish', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    
    // Ensure OCR is actually complete before allowing publish
    if (article.ocrStatus !== 'completed') {
      return res.status(400).json({ error: 'Cannot publish until processing is fully completed.' });
    }

    const { price, freePagesCount } = req.body;
    
    await Article.update({
      price: price || 0,
      freePagesCount: freePagesCount || 0,
      status: 'published' // Make it live!
    }, { where: { id: article.id } });

    res.json({ message: 'Book published successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error publishing book' });
  }
});

// Like article
router.post('/:id/like', async (req, res) => {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    
    article.likes = (article.likes || 0) + 1;
    await article.save();
    
    res.json({ message: 'Article liked', likes: article.likes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error liking article' });
  }
});

module.exports = router;

