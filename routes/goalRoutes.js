const express = require('express');
const router = express.Router();
const { ReadingGoal } = require('../models');
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

// GET current user's reading goal and stats for this week
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // Get all goals for this user, we will process them on the frontend
    const goals = await ReadingGoal.findAll({
      where: { userId },
      order: [['date', 'DESC']],
      limit: 30 // Get last 30 days
    });

    res.json(goals);
  } catch (error) {
    console.error('Error fetching reading goals:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST update reading progress
router.post('/progress', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { minutesRead, pagesRead, articleId } = req.body;
    
    // YYYY-MM-DD
    const today = new Date().toISOString().split('T')[0];

    const [goal, created] = await ReadingGoal.findOrCreate({
      where: { userId, date: today },
      defaults: {
        dailyGoalMinutes: 5,
        minutesRead: minutesRead || 0,
        pagesRead: pagesRead || 0,
        lastArticleId: articleId
      }
    });

    if (!created) {
      goal.minutesRead += (minutesRead || 0);
      goal.pagesRead += (pagesRead || 0);
      if (articleId) goal.lastArticleId = articleId;
      await goal.save();
    }

    res.json(goal);
  } catch (error) {
    console.error('Error updating reading progress:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
