const express = require('express');
const router = express.Router();
const { UserPreference } = require('../models');

// GET preferences by visitorId
router.get('/:visitorId', async (req, res) => {
  try {
    const pref = await UserPreference.findOne({
      where: { visitorId: req.params.visitorId },
    });
    if (!pref) return res.status(404).json({ error: 'No preferences found' });
    res.json(pref);
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST (create or update) preferences
router.post('/', async (req, res) => {
  try {
    const { visitorId, languages, stylePerLanguage } = req.body;

    if (!visitorId || !languages || !stylePerLanguage) {
      return res.status(400).json({ error: 'visitorId, languages, and stylePerLanguage are required' });
    }

    const [pref, created] = await UserPreference.findOrCreate({
      where: { visitorId },
      defaults: {
        languages,
        stylePerLanguage,
        onboardingCompleted: true,
      },
    });

    if (!created) {
      pref.languages = languages;
      pref.stylePerLanguage = stylePerLanguage;
      pref.onboardingCompleted = true;
      await pref.save();
    }

    res.json(pref);
  } catch (error) {
    console.error('Error saving preferences:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
