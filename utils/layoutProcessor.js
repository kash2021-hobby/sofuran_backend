const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { execSync } = require('child_process');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make API request with retry mechanism for handling rate limits (429) or temporary server errors (503).
 */
const callApiWithRetry = async (url, payload, headers = {}, retries = 5) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: 180000 // 3-minute timeout
      });
      return response;
    } catch (err) {
      const status = err.response?.status;
      const errorMsg = err.response?.data?.error?.message || err.message;
      const isTransient = status === 503 || status === 429 || status === 402 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      
      if (attempt === retries || !isTransient) {
        throw err;
      }
      
      const delay = (status === 429 || status === 402) ? 65000 : attempt * 3000;
      console.warn(`[LayoutProcessor] API transient error (status: ${status || err.code}, detail: ${errorMsg}). Retrying ${attempt}/${retries} in ${delay}ms...`);
      await wait(delay);
    }
  }
};

/**
 * Call the vision AI model via OpenRouter or fall back to direct Gemini API.
 * Returns the raw text response from the model.
 */
const callVisionAI = async (prompt, ocrText, imageBase64) => {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouterModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // Prefer OpenRouter if key is available
  if (openrouterKey) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const payload = {
      model: openrouterModel,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt + `\n\nOCR_TEXT_INPUT:\n${ocrText}` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    };
    const headers = {
      'Authorization': `Bearer ${openrouterKey}`,
      'HTTP-Referer': 'https://sofura.ltabai.in',
      'X-Title': 'Sofura Magazine'
    };

    const response = await callApiWithRetry(url, payload, headers);
    const choice = response?.data?.choices?.[0];
    if (!choice || !choice.message?.content) {
      throw new Error('No response content from OpenRouter');
    }
    console.log(`[LayoutProcessor] OpenRouter model: ${openrouterModel}, cost: $${response?.data?.usage?.cost || '?'}`);
    return choice.message.content;
  }

  // Fallback: Direct Gemini API
  if (geminiApiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${geminiApiKey}`;
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { text: `OCR_TEXT_INPUT:\n${ocrText}` },
          { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json' }
    };
    const response = await callApiWithRetry(url, payload);
    const candidates = response?.data?.candidates;
    if (!candidates || candidates.length === 0) {
      throw new Error('No response candidates from Gemini');
    }
    return candidates[0].content.parts[0].text;
  }

  throw new Error('No AI API key configured (OPENROUTER_API_KEY or GEMINI_API_KEY)');
};

/**
 * Extract images from PDF using PyMuPDF (zero AI cost).
 * Falls back to AI-based extraction if the PDF path is not available.
 */
const extractImagesFromPdf = (pdfPath, pageNum, articleId) => {
  try {
    const cropsDirName = `crops-${articleId}`;
    const cropsDir = path.join(__dirname, '../uploads/images', cropsDirName);
    const scriptPath = path.join(__dirname, 'extractImages.py');
    
    if (!pdfPath || !fs.existsSync(pdfPath) || !fs.existsSync(scriptPath)) {
      return null;
    }
    
    const result = execSync(
      `python3 "${scriptPath}" "${pdfPath}" ${pageNum} "${cropsDir}" "${articleId}"`,
      { timeout: 30000, encoding: 'utf-8' }
    );
    
    const parsed = JSON.parse(result.trim());
    if (parsed.error) {
      console.warn(`[LayoutProcessor] PDF image extraction warning: ${parsed.error}`);
      return null;
    }
    
    return parsed;
  } catch (err) {
    console.warn(`[LayoutProcessor] PDF image extraction failed, will fall back to AI: ${err.message}`);
    return null;
  }
};



/**
 * Extracts page layout, crops illustrations/graphics, and reconstructs
 * a responsive JSON flow of text and images.
 * 
 * @param {string} pageImagePath - Path to the high-res PNG page image
 * @param {string} ocrText - The extracted text content for the page
 * @param {number} articleId - The ID of the parent article
 * @param {number} pageIndex - The page number index (1-based)
 * @returns {Promise<Array<Object>>} Structured flow: [{ type: 'text', content: '...' }, { type: 'image', src: '...', caption: '...' }]
 */
const extractStructuredLayout = async (pageImagePath, ocrText, articleId, pageIndex, pdfPath = null) => {
  try {
    const hasApiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    
    if (!hasApiKey) {
      console.warn(`[LayoutProcessor] No AI API key configured. Skipping layout analysis for page ${pageIndex}.`);
      return [{ type: 'text', format: 'paragraph', content: ocrText }];
    }

    if (!fs.existsSync(pageImagePath)) {
      console.warn(`[LayoutProcessor] Page image not found: ${pageImagePath}`);
      return [{ type: 'text', format: 'paragraph', content: ocrText }];
    }

    console.log(`[LayoutProcessor] Optimizing image size for page ${pageIndex} layout parsing...`);
    
    const optimizedBuffer = await sharp(pageImagePath)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();

    const imageBase64 = optimizedBuffer.toString('base64');

    const modelName = process.env.OPENROUTER_MODEL || 'gemini';
    console.log(`[LayoutProcessor] Analyzing layout with ${modelName} for page ${pageIndex}...`);
    
    const prompt = `You are a professional magazine layout analyst, content classifier, and OCR cleanup engine. Analyze this scanned page image alongside the OCR text.

Task 1: CONTENT INTELLIGENCE — Classify the overall type of content on this page.
Valid types: "novel", "story", "article", "educational", "biography", "textbook", "poetry", "qa".

Task 2: DETECT IMAGES/GRAPHICS — Find any illustrations, photographs, or decorative graphics. EXTREMELY IMPORTANT: The bounding box MUST tightly wrap ONLY the actual image/illustration itself. DO NOT include any captions, headings, or surrounding body text inside the image bounding box. The coordinates must isolate the graphic perfectly.

Task 3: OCR CLEANUP & FORMATTING — Using BOTH the OCR text and the visual layout:
  - MERGE BROKEN LINES: OCR often breaks single sentences into multiple lines. You MUST merge these back into continuous flowing paragraphs. Only create a new paragraph when there is a clear visual paragraph break in the image.
  - FIX SPACING: Remove duplicate spaces and fix punctuation spacing.
  - CLASSIFY BLOCKS: Identify each text region as one of the following formats:
    * "heading": Titles, subtitles, section headers.
    * "paragraph": Normal body text.
    * "question": A question in a Q&A, textbook, or interview.
    * "answer": The answer corresponding to a question.
    * "quote": An indented or stylized quotation.
    * "fact": A highlighted fact or important note.
    * "list": Bulleted or numbered lists.
    * "table": Tabular data.
    * "poem": Poetry or verse.
  - BOLD TEXT: Wrap visually bold phrases within the text in **double asterisks**.

Task 4: AI TYPOGRAPHY — Set design properties to match the original PDF.
  - Headings should be fontSize: "large", "xlarge", or "xxlarge".
  - Body text MUST be fontSize: "base".

Return JSON exactly matching this schema:
{
  "contentType": "educational",
  "confidence": 0.95,
  "images": [{"id": 0, "box": [ymin,xmin,ymax,xmax], "caption": "..."}],
  "contentBlocks": [
    {"type": "image_ref", "imageId": 0},
    {
      "type": "text", 
      "format": "heading", 
      "content": "Chapter 1",
      "design": { "textAlign": "center", "fontSize": "xlarge" }
    },
    {
      "type": "text", 
      "format": "paragraph", 
      "content": "Clean, continuous text with merged lines.",
      "design": { "textAlign": "justify", "fontSize": "base" }
    }
  ]
}

RULES:
- MERGE arbitrary OCR line breaks! This is critical for ebook rendering.
- For paragraphs, default textAlign should be "justify" or "left".
- ALWAYS use fontSize "base" for paragraphs, questions, answers, lists.
- Bounding boxes for images MUST be extremely precise. NEVER crop surrounding text or captions into an image bounding box.
- Valid JSON only. No markdown wrapper.
- Normalize box coordinates to 0-1000 scale.`;

    let textResponse = '';

    textResponse = await callVisionAI(prompt, ocrText, imageBase64);

    if (!textResponse) {
       console.warn('[LayoutProcessor] Empty AI response.');
       return { contentType: 'article', confidence: 0, blocks: [{ type: 'text', format: 'paragraph', content: ocrText }] };
    }
    
    // Clean response to handle markdown block wrapper if any
    let cleanText = textResponse.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    const result = JSON.parse(cleanText);
    
    const detectedImages = result.images || [];
    const contentBlocks = result.contentBlocks || [];

    // STEP 1: Try to extract images from PDF structure (FREE — no AI cost)
    let imageMap = {};
    let pdfImages = null;
    
    if (pdfPath) {
      pdfImages = extractImagesFromPdf(pdfPath, pageIndex, articleId);
    }
    
    if (pdfImages && pdfImages.count > 0) {
      console.log(`[LayoutProcessor] PDF extraction found ${pdfImages.count} images for page ${pageIndex} (zero AI cost).`);
      for (const img of pdfImages.images) {
        imageMap[img.id] = {
          type: 'image',
          src: img.src,
          caption: img.caption || '',
          layout: img.layout
        };
      }
    } else {
      // Fallback: use AI-detected images and crop from the rendered page image
      const detectedImages = result.images || [];
      
      if (detectedImages.length > 0) {
        const originalImage = sharp(pageImagePath);
        const metadata = await originalImage.metadata();
        const width = metadata.width;
        const height = metadata.height;
        
        const cropsDirName = `crops-${articleId}`;
        const cropsDir = path.join(__dirname, '../uploads/images', cropsDirName);
        if (!fs.existsSync(cropsDir)) {
          fs.mkdirSync(cropsDir, { recursive: true });
        }
        
        for (const img of detectedImages) {
          const { id, box, caption } = img;
          if (!box || box.length !== 4) continue;
          
          const [ymin, xmin, ymax, xmax] = box;
          const left = Math.max(0, Math.round((xmin / 1000) * width));
          const top = Math.max(0, Math.round((ymin / 1000) * height));
          const right = Math.min(width, Math.round((xmax / 1000) * width));
          const bottom = Math.min(height, Math.round((ymax / 1000) * height));
          const extractWidth = right - left;
          const extractHeight = bottom - top;
          if (extractWidth <= 0 || extractHeight <= 0) continue;
          
          const cropFileName = `page-${pageIndex}-crop-${id}.png`;
          const cropFilePath = path.join(cropsDir, cropFileName);
          
          try {
            console.log(`[LayoutProcessor] Cropping illustration ${id} for page ${pageIndex}...`);
            await sharp(pageImagePath)
              .extract({ left, top, width: extractWidth, height: extractHeight })
              .toFile(cropFilePath);
            
            imageMap[id] = {
              type: 'image',
              src: `/uploads/images/${cropsDirName}/${cropFileName}`,
              caption: caption || '',
              layout: {
                widthRatio: extractWidth / width,
                heightRatio: extractHeight / height,
                topRatio: top / height,
                leftRatio: left / width
              }
            };
          } catch (err) {
            console.error(`[LayoutProcessor] Failed to crop image ${id}:`, err);
          }
        }
      }
    }

    // Reconstruct the content flow using the new contentBlocks format
    const contentFlow = [];

    if (contentBlocks.length > 0) {
      for (const block of contentBlocks) {
        if (block.type === 'image_ref' && imageMap[block.imageId] !== undefined) {
          contentFlow.push(imageMap[block.imageId]);
        } else if (block.type === 'text') {
          contentFlow.push({
            type: 'text',
            format: block.format || 'paragraph',
            content: block.content || '',
            design: block.design || undefined
          });
        }
      }
    }

    // Fallback: if contentBlocks was empty/missing (old model response), use textWithPlaceholders
    if (contentFlow.length === 0) {
      const textWithPlaceholders = result.textWithPlaceholders || ocrText;
      const regex = /(\[IMAGE_\d+\])/g;
      const parts = textWithPlaceholders.split(regex);
      for (const part of parts) {
        if (!part) continue;
        const imgMatch = part.match(/\[IMAGE_(\d+)\]/);
        if (imgMatch && imageMap[parseInt(imgMatch[1])]) {
          contentFlow.push(imageMap[parseInt(imgMatch[1])]);
        } else {
          contentFlow.push({ type: 'text', format: 'paragraph', content: part });
        }
      }
    }

    // Final fallback
    if (contentFlow.length === 0) {
      contentFlow.push({ type: 'text', format: 'paragraph', content: ocrText });
    }

    // Ensure all cropped images are included even if Gemini forgot to reference them
    for (const [id, imgObj] of Object.entries(imageMap)) {
      if (!contentFlow.find(b => b.type === 'image' && b.src === imgObj.src)) {
        contentFlow.unshift(imgObj);
      }
    }

    console.log(`[LayoutProcessor] Page ${pageIndex} analysis complete. Type: ${result.contentType || 'article'}, Found ${detectedImages.length} images, ${contentFlow.filter(b => b.type === 'text').length} text blocks.`);
    return {
      contentType: result.contentType || 'article',
      confidence: result.confidence || 1.0,
      blocks: contentFlow
    };

  } catch (error) {
    console.error(`[LayoutProcessor] Error parsing layout on page ${pageIndex}:`, error.message || error);
    return { contentType: 'article', confidence: 0, blocks: [{ type: 'text', format: 'paragraph', content: ocrText }] };
  }
};

/**
 * Poem-specific layout extraction using Gemini Vision.
 * Extracts poem title, author, body with preserved line breaks, stanza spacing,
 * and any illustrations/graphics on the page.
 */
const extractPoemLayout = async (pageImagePath, ocrText, articleId, pageIndex, pdfPath = null) => {
  try {
    const hasApiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

    if (!hasApiKey) {
      console.warn(`[LayoutProcessor] No AI API key configured. Returning raw OCR for poem page ${pageIndex}.`);
      return [{ type: 'text', format: 'poem', content: ocrText }];
    }

    if (!fs.existsSync(pageImagePath)) {
      console.warn(`[LayoutProcessor] Page image not found: ${pageImagePath}`);
      return [{ type: 'text', format: 'poem', content: ocrText }];
    }

    const modelName = process.env.OPENROUTER_MODEL || 'gemini';
    console.log(`[LayoutProcessor] Analyzing POEM page ${pageIndex} with ${modelName}...`);

    const optimizedBuffer = await sharp(pageImagePath)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();

    const imageBase64 = optimizedBuffer.toString('base64');

    const prompt = `Task 1: Find images/graphics. Do NOT select text.
Task 2: Format poem using OCR text and layout. Types: poem_title, poem_author, poem, heading. Do NOT use "paragraph".
Task 3: AI Typography & Design. Analyze the SPATIAL LAYOUT in the image. 

CRITICAL LAYOUT RULES FOR MOBILE READING:
- ALL poem stanzas and text blocks MUST use type: "poem". Do NOT use "paragraph" anywhere on this page to prevent unwanted text indentation.
- ALL poem stanzas MUST use design.textAlign: "left". Do NOT use right-aligned stanzas, keep them all on the left for a clean single-column reading experience.
- The ONLY text that should use design.textAlign: "right" is the author name, signature, date, or publication name at the VERY END of the poem.
- If the poem title or subtitle is centered, use design.textAlign: "center" for those blocks.

Return JSON:
{
  "images": [{"id": 0, "box": [ymin,xmin,ymax,xmax], "caption": "..."}],
  "contentBlocks": [
    {"type": "image_ref", "imageId": 0},
    {
      "type": "text", 
      "format": "poem", 
      "content": "...",
      "design": {
        "textAlign": "left", 
        "fontFamily": "serif", 
        "fontWeight": "normal",
        "fontStyle": "normal",
        "fontSize": "base",
        "color": "default",
        "marginTop": "medium"
      }
    }
  ]
}
RULES:
- Preserve EVERY original linebreak (\\n) and stanza break (\\n\\n) for poems. Do NOT merge lines.
- OCR_TEXT_INPUT MAY CONTAIN ERRORS OR DUPLICATES. Use the visual image as the ultimate source of truth.
- NEVER duplicate text. If the OCR contains duplicated "ghost" lines that only appear once in the visual image, DO NOT output them twice. Output exactly what is visibly present.
- Fix any obvious OCR errors (like misread dates or characters) based on what you clearly see in the image.
- Valid JSON only. No markdown.
- design.textAlign options: left, center, right
- design.fontFamily options: serif, sans, monospace
- design.fontWeight options: normal, semibold, bold
- design.fontStyle options: normal, italic
- design.fontSize options: base, large, xlarge, xxlarge
- design.color options: default
- design.marginTop options: small, medium, large`;

    let cleanText = '';

    cleanText = await callVisionAI(prompt, ocrText, imageBase64);
    cleanText = cleanText.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    const result = JSON.parse(cleanText);
    const detectedImages = result.images || [];
    const contentBlocks = result.contentBlocks || [];

    // STEP 1: Try to extract images from PDF structure (FREE — no AI cost)
    let imageMap = {};
    let pdfImages = null;
    
    if (pdfPath) {
      pdfImages = extractImagesFromPdf(pdfPath, pageIndex, articleId);
    }
    
    if (pdfImages && pdfImages.count > 0) {
      console.log(`[LayoutProcessor] PDF extraction found ${pdfImages.count} images for POEM page ${pageIndex} (zero AI cost).`);
      for (const img of pdfImages.images) {
        imageMap[img.id] = {
          type: 'image',
          src: img.src,
          caption: img.caption || '',
          layout: img.layout
        };
      }
    } else {
      // Fallback: AI detection
      if (detectedImages.length > 0) {
        const metadata = await sharp(pageImagePath).metadata();
        const { width, height } = metadata;
        const cropsDirName = `crops-${articleId}`;
        const cropsDir = path.join(__dirname, '../uploads/images', cropsDirName);
        if (!fs.existsSync(cropsDir)) fs.mkdirSync(cropsDir, { recursive: true });

        for (const img of detectedImages) {
          const { id, box, caption } = img;
          if (!box || box.length !== 4) continue;
          const [ymin, xmin, ymax, xmax] = box;
          const left = Math.max(0, Math.round((xmin / 1000) * width));
          const top = Math.max(0, Math.round((ymin / 1000) * height));
          const right = Math.min(width, Math.round((xmax / 1000) * width));
          const bottom = Math.min(height, Math.round((ymax / 1000) * height));
          const extractWidth = right - left;
          const extractHeight = bottom - top;
          if (extractWidth <= 0 || extractHeight <= 0) continue;

          const cropFileName = `page-${pageIndex}-crop-${id}.png`;
          const cropFilePath = path.join(cropsDir, cropFileName);
          try {
            await sharp(pageImagePath).extract({ left, top, width: extractWidth, height: extractHeight }).toFile(cropFilePath);
            imageMap[id] = { 
              type: 'image', 
              src: `/uploads/images/${cropsDirName}/${cropFileName}`, 
              caption: caption || '',
              layout: {
                widthRatio: extractWidth / width,
                heightRatio: extractHeight / height,
                topRatio: top / height,
                leftRatio: left / width
              }
            };
          } catch (err) {
            console.error(`[LayoutProcessor] Failed to crop poem page image ${id}:`, err);
          }
        }
      }
    }

    // Build content flow
    const contentFlow = [];
    for (const block of contentBlocks) {
      if (block.type === 'image_ref' && imageMap[block.imageId] !== undefined) {
        contentFlow.push(imageMap[block.imageId]);
      } else if (block.type === 'text') {
        contentFlow.push({
          type: 'text',
          format: block.format || 'poem',
          content: block.content || '',
          design: block.design || undefined
        });
      }
    }

    // Ensure all cropped images are included even if Gemini forgot to reference them
    for (const [id, imgObj] of Object.entries(imageMap)) {
      if (!contentFlow.find(b => b.type === 'image' && b.src === imgObj.src)) {
        contentFlow.unshift(imgObj);
      }
    }

    if (contentFlow.length === 0) {
      contentFlow.push({ type: 'text', format: 'poem', content: ocrText });
    }

    console.log(`[LayoutProcessor] Poem page ${pageIndex} analysis complete. ${detectedImages.length} images, ${contentFlow.filter(b => b.type === 'text').length} text blocks.`);
    return {
      contentType: 'poetry',
      confidence: 1.0,
      blocks: contentFlow
    };

  } catch (error) {
    console.error(`[LayoutProcessor] Error parsing poem page ${pageIndex}:`, error.message || error);
    return { contentType: 'poetry', confidence: 0, blocks: [{ type: 'text', format: 'poem', content: ocrText }] };
  }
};

module.exports = {
  extractStructuredLayout,
  extractPoemLayout
};
