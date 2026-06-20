const express = require('express');
const router = express.Router();
const { ArticleProgress, Article, User } = require('../models');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey123';

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// GET most recent reading progress for user
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const recentProgress = await ArticleProgress.findOne({
      where: { userId },
      order: [['lastReadAt', 'DESC']],
      include: [{ model: Article, include: [{ model: User, attributes: ['name'] }] }]
    });

    res.json(recentProgress);
  } catch (error) {
    console.error('Error fetching recent progress:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET all reading progress for user (Library)
router.get('/all', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const allProgress = await ArticleProgress.findAll({
      where: { userId },
      order: [['lastReadAt', 'DESC']],
      include: [{ model: Article, include: [{ model: User, attributes: ['name'] }] }]
    });

    res.json(allProgress);
  } catch (error) {
    console.error('Error fetching all progress:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST update reading progress for an article
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { articleId, currentPage, totalPages } = req.body;

    if (!articleId) return res.status(400).json({ error: 'articleId required' });

    let [progress, created] = await ArticleProgress.findOrCreate({
      where: { userId, articleId },
      defaults: {
        currentPage: currentPage || 0,
        totalPages: totalPages || 1,
        lastReadAt: new Date()
      }
    });

    if (!created) {
      if (currentPage !== undefined) progress.currentPage = currentPage;
      if (totalPages !== undefined) progress.totalPages = totalPages;
      progress.lastReadAt = new Date();
      await progress.save();
    }

    res.json(progress);
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
