const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make API request with retry mechanism for handling rate limits (429) or temporary server errors (503).
 */
const callGeminiWithRetry = async (url, payload, retries = 5) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000 // 60s timeout for free tier
      });
      return response;
    } catch (err) {
      const status = err.response?.status;
      const errorMsg = err.response?.data?.error?.message || err.message;
      const isTransient = status === 503 || status === 429 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      
      if (attempt === retries || !isTransient) {
        throw err;
      }
      
      // If we hit a 429 rate limit (token quota), wait 65 seconds to let the minute window fully reset.
      const delay = status === 429 ? 65000 : attempt * 3000;
      console.warn(`[LayoutProcessor] Gemini API transient error (status: ${status || err.code}, detail: ${errorMsg}). Retrying ${attempt}/${retries} in ${delay}ms...`);
      await wait(delay);
    }
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
const extractStructuredLayout = async (pageImagePath, ocrText, articleId, pageIndex) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn(`[LayoutProcessor] GEMINI_API_KEY is not defined. Skipping layout analysis for page ${pageIndex}.`);
      return [{ type: 'text', format: 'paragraph', content: ocrText }];
    }

    if (!fs.existsSync(pageImagePath)) {
      console.warn(`[LayoutProcessor] Page image not found: ${pageImagePath}`);
      return [{ type: 'text', format: 'paragraph', content: ocrText }];
    }

    console.log(`[LayoutProcessor] Optimizing image size for page ${pageIndex} layout parsing...`);
    
    // Token Cost Optimization: Resize to 512px. Since we provide OCR text, Gemini
    // only needs a low-res image to understand layout bounding boxes. This saves massive token counts!
    const optimizedBuffer = await sharp(pageImagePath)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();

    const imageBase64 = optimizedBuffer.toString('base64');

    console.log(`[LayoutProcessor] Analyzing layout with Gemini Vision for page ${pageIndex}...`);
    
    const prompt = `You are a professional magazine layout analyst. Analyze this scanned page image alongside the OCR text.

Task 1: DETECT IMAGES/GRAPHICS — Find any illustrations, photographs, or decorative graphics. Do NOT select text regions.
Task 2: FORMAT TEXT — Using BOTH the OCR text and the visual layout from the image, identify:
  - HEADINGS: Text that appears larger, bolder, or more prominent than body text. These are titles, subtitles, section headers.
  - BOLD TEXT: Sentences or phrases that are visually bolder/thicker than surrounding text. Wrap these in **double asterisks** in the content.
  - PARAGRAPHS: Normal body text.
  - POEMS/VERSES: Text with deliberate line-by-line arrangement.
  - QUOTES: Indented or styled quotations.
  - DIALOGUES: Conversational text.
Task 3: AI TYPOGRAPHY — For EVERY text block, set the design properties to match how it appears in the original PDF.

CRITICAL RULES FOR HEADINGS:
- If text is visually LARGER than body text → format: "heading", fontSize: "xlarge" or "xxlarge"
- If text is visually BOLD but same size as body → keep format: "paragraph" but set fontWeight: "bold"  
- If text is a subheading (slightly larger) → format: "heading", fontSize: "large"
- Bold sentences within paragraphs: wrap them in **asterisks** inside the content string.

Return JSON:
{
  "images": [{"id": 0, "box": [ymin,xmin,ymax,xmax], "caption": "..."}],
  "contentBlocks": [
    {"type": "image_ref", "imageId": 0},
    {
      "type": "text", 
      "format": "heading", 
      "content": "This Is A Heading",
      "design": {
        "textAlign": "center", 
        "fontFamily": "serif", 
        "fontWeight": "bold",
        "fontStyle": "normal",
        "fontSize": "xlarge",
        "color": "default",
        "marginTop": "large"
      }
    },
    {
      "type": "text", 
      "format": "paragraph", 
      "content": "Normal text with **some bold words** in between.",
      "design": {
        "textAlign": "justify", 
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
- Look at the IMAGE carefully to detect which text is bold, large, or a heading. Do NOT rely only on OCR text.
- Preserve all linebreaks (\\n) for poem, verse, dialogue, list.
- For paragraphs, default textAlign should be "justify".
- For ALL paragraph/body text blocks, ALWAYS use fontSize: "base". Do NOT use "small" for any text.
- Only use fontSize "large", "xlarge", "xxlarge" for heading blocks.
- ALWAYS use color: "default" for every block. Do NOT use "accent" or "muted".
- Valid JSON only. No markdown wrapper.
- design.textAlign options: left, center, right, justify
- design.fontFamily options: serif, sans, monospace
- design.fontWeight options: normal, semibold, bold
- design.fontStyle options: normal, italic
- design.fontSize options: base, large, xlarge, xxlarge
- design.color: always "default"
- design.marginTop options: small, medium, large`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          parts: [
            { text: prompt },
            { text: `OCR_TEXT_INPUT:\n${ocrText}` },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    };

    const response = await callGeminiWithRetry(url, payload);

    const candidates = response?.data?.candidates;
    if (!candidates || candidates.length === 0) {
      console.warn('[LayoutProcessor] No response candidates from Gemini.');
      return [{ type: 'text', format: 'paragraph', content: ocrText }];
    }

    const textResponse = candidates[0].content.parts[0].text;
    
    // Clean response to handle markdown block wrapper if any
    let cleanText = textResponse.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    const result = JSON.parse(cleanText);
    
    const detectedImages = result.images || [];
    const contentBlocks = result.contentBlocks || [];

    // Crop detected images and build lookup map
    const imageMap = {};

    if (detectedImages.length > 0) {
      // Load original image metadata using sharp to convert coordinates to exact pixel values
      const originalImage = sharp(pageImagePath);
      const metadata = await originalImage.metadata();
      const width = metadata.width;
      const height = metadata.height;

      // Create a crops directory if it doesn't exist
      const cropsDirName = `crops-${articleId}`;
      const cropsDir = path.join(__dirname, '../uploads/images', cropsDirName);
      if (!fs.existsSync(cropsDir)) {
        fs.mkdirSync(cropsDir, { recursive: true });
      }

      for (const img of detectedImages) {
        const { id, box, caption } = img;
        if (!box || box.length !== 4) continue;

        const [ymin, xmin, ymax, xmax] = box;
        
        // Convert normalized coords (0-1000) to actual pixels on original high-res image
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
            caption: caption || ''
          };
        } catch (err) {
          console.error(`[LayoutProcessor] Failed to crop image ${id}:`, err);
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

    console.log(`[LayoutProcessor] Page ${pageIndex} layout analysis complete. Found ${detectedImages.length} images, ${contentFlow.filter(b => b.type === 'text').length} text blocks.`);
    return contentFlow;

  } catch (error) {
    console.error(`[LayoutProcessor] Error parsing layout on page ${pageIndex}:`, error.message || error);
    return [{ type: 'text', format: 'paragraph', content: ocrText }];
  }
};

/**
 * Poem-specific layout extraction using Gemini Vision.
 * Extracts poem title, author, body with preserved line breaks, stanza spacing,
 * and any illustrations/graphics on the page.
 */
const extractPoemLayout = async (pageImagePath, ocrText, articleId, pageIndex) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn(`[LayoutProcessor] GEMINI_API_KEY not set. Returning raw OCR for poem page ${pageIndex}.`);
      return [{ type: 'text', format: 'poem', content: ocrText }];
    }

    if (!fs.existsSync(pageImagePath)) {
      console.warn(`[LayoutProcessor] Page image not found: ${pageImagePath}`);
      return [{ type: 'text', format: 'poem', content: ocrText }];
    }

    console.log(`[LayoutProcessor] Analyzing POEM page ${pageIndex} with Gemini Vision...`);

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
- Preserve EVERY original linebreak (\n) and stanza break (\n\n) for poems. Do NOT merge lines.
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
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

    const response = await callGeminiWithRetry(url, payload);
    const candidates = response?.data?.candidates;
    if (!candidates || candidates.length === 0) {
      return [{ type: 'text', format: 'poem', content: ocrText }];
    }

    let cleanText = candidates[0].content.parts[0].text.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    const result = JSON.parse(cleanText);
    const detectedImages = result.images || [];
    const contentBlocks = result.contentBlocks || [];

    // Crop detected images
    const imageMap = {};
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
          imageMap[id] = { type: 'image', src: `/uploads/images/${cropsDirName}/${cropFileName}`, caption: caption || '' };
        } catch (err) {
          console.error(`[LayoutProcessor] Failed to crop poem page image ${id}:`, err);
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
    return contentFlow;

  } catch (error) {
    console.error(`[LayoutProcessor] Error parsing poem page ${pageIndex}:`, error.message || error);
    return [{ type: 'text', format: 'poem', content: ocrText }];
  }
};

module.exports = {
  extractStructuredLayout,
  extractPoemLayout
};
