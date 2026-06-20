const axios = require('axios');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const LANG_NAMES = {
  as: 'Assamese',
  bn: 'Bengali',
  hi: 'Hindi',
  en: 'English',
};

/**
 * Call Gemini API with retry for rate limits.
 * Uses exponential backoff for 503 errors.
 */
const callGemini = async (prompt, retries = 5) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Use Pro model for highest quality translation
  const model = process.env.GEMINI_TRANSLATION_MODEL || 'gemini-2.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 180000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty Gemini response');
      return text;
    } catch (err) {
      const status = err.response?.status;
      const isTransient = status === 429 || status === 503 || status === 502 || status === 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET';
      if (attempt === retries || !isTransient) throw err;

      // Exponential backoff: 429 = 65s flat, 503 = 10s × 2^attempt, timeout = 5s × attempt
      let delay;
      if (status === 429) {
        delay = 65000;
      } else if (status === 503) {
        delay = Math.min(10000 * Math.pow(2, attempt - 1), 120000); // 10s, 20s, 40s, 80s, max 120s
      } else {
        delay = 5000 * attempt;
      }
      console.warn(`[Translator] Gemini error (${status || err.code}). Retry ${attempt}/${retries} in ${Math.round(delay / 1000)}s...`);
      await wait(delay);
    }
  }
};



/**
 * Translate a single text block's content from one language to another.
 * Returns translated text preserving paragraph structure.
 */
const translateText = async (text, fromLang, toLang) => {
  const fromName = fromLang === 'auto' ? 'its original source language (auto-detect)' : (LANG_NAMES[fromLang] || fromLang);
  const toName = LANG_NAMES[toLang] || toLang;

  const prompt = `You are a professional literary translator for magazines and books.

Translate the following text from ${fromName} to ${toName}.

RULES:
- Preserve ALL paragraph breaks exactly as they are (\\n\\n between paragraphs).
- Preserve any markdown formatting like ## headings, > blockquotes, **bold**, etc.
- Maintain the literary tone, mood, and style of the original.
- For poetry or dialogue, preserve the line-by-line structure.
- Do NOT add any explanation, notes, or commentary.
- Return ONLY the translated text, nothing else.

TEXT TO TRANSLATE:
${text}`;

  const result = await callGemini(prompt);
  return result.trim();
};

/**
 * Translate an entire article's pageTexts to target languages.
 * 
 * @param {number} articleId - Article ID
 * @param {Array<string>} targetLangs - e.g. ['hi', 'en']
 * @param {Object} ArticleModel - Sequelize Article model
 * @param {string} agent - AI agent to use
 */
const translateArticle = async (articleId, targetLangs, ArticleModel) => {
  console.log(`[Translator] Starting translation for article ${articleId} → [${targetLangs.join(', ')}]`);

  try {
    await ArticleModel.update({ translationStatus: 'processing' }, { where: { id: articleId } });

    const article = await ArticleModel.findByPk(articleId);
    if (!article || !article.pageTexts) {
      throw new Error('Article or pageTexts not found');
    }

    const originalLang = article.originalLanguage || 'auto';
    const pageTextsArray = JSON.parse(article.pageTexts);
    const existingTranslations = article.translations ? JSON.parse(article.translations) : {};

    for (const targetLang of targetLangs) {
      console.log(`[Translator] Translating to ${LANG_NAMES[targetLang] || targetLang}...`);
      const translatedPages = [];

      for (let pageIdx = 0; pageIdx < pageTextsArray.length; pageIdx++) {
        const pageBlocks = pageTextsArray[pageIdx];
        console.log(`[Translator]   Page ${pageIdx + 1}/${pageTextsArray.length}...`);

        // If it's a simple string
        if (typeof pageBlocks === 'string') {
          if (pageBlocks.trim()) {
            try {
              const translated = await translateText(pageBlocks, originalLang, targetLang);
              translatedPages.push(translated);
            } catch (e) {
              console.error(`[Translator] ⚠️ Page ${pageIdx + 1} translation failed: ${e.message}. Keeping original.`);
              translatedPages.push(pageBlocks);
            }
          } else {
            translatedPages.push(pageBlocks);
          }
          // Cooldown between pages to avoid 503 overload
          await wait(2000);
          continue;
        }

        // If it's an array of blocks OR the new structured object { contentType, blocks: [] }
        let actualBlocks = [];
        let isObjectFormat = false;

        if (Array.isArray(pageBlocks)) {
          actualBlocks = pageBlocks;
        } else if (pageBlocks && typeof pageBlocks === 'object' && Array.isArray(pageBlocks.blocks)) {
          actualBlocks = pageBlocks.blocks;
          isObjectFormat = true;
        }

        if (actualBlocks.length > 0) {
          const translatedBlocks = [];
          for (const block of actualBlocks) {
            if (block.type === 'text' && block.content && String(block.content).trim()) {
              try {
                const translated = await translateText(String(block.content), originalLang, targetLang);
                translatedBlocks.push({ ...block, content: translated });
              } catch (e) {
                console.error(`[Translator] ⚠️ Block translation failed on page ${pageIdx + 1}: ${e.message}. Keeping original.`);
                translatedBlocks.push({ ...block });
              }
            } else {
              // Images, covers, etc. — keep as-is
              translatedBlocks.push(block);
            }
          }
          
          if (isObjectFormat) {
            translatedPages.push({ ...pageBlocks, blocks: translatedBlocks });
          } else {
            translatedPages.push(translatedBlocks);
          }
          
          // Cooldown between pages to avoid 503 overload
          await wait(2000);
          continue;
        }

        // Fallback
        translatedPages.push(pageBlocks);
      }

      existingTranslations[targetLang] = translatedPages;

      // Save after each language in case of failure mid-way
      await ArticleModel.update(
        { translations: JSON.stringify(existingTranslations) },
        { where: { id: articleId } }
      );
      console.log(`[Translator] ✅ ${LANG_NAMES[targetLang]} translation saved for article ${articleId}.`);
    }

    await ArticleModel.update({ translationStatus: 'completed' }, { where: { id: articleId } });
    console.log(`[Translator] ✅ All translations complete for article ${articleId}.`);
  } catch (error) {
    console.error(`[Translator] ❌ Translation failed for article ${articleId}:`, error.message);
    await ArticleModel.update({ translationStatus: 'failed' }, { where: { id: articleId } });
  }
};

module.exports = { translateArticle, translateText };
