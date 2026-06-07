require('dotenv').config();
const express = require('express');

process.on('exit', (code) => { console.log('PROCESS EXIT:', code); console.trace(); });
process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED REJECTION:', err); });
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
const authRoutes = require('./routes/authRoutes');
const articleRoutes = require('./routes/articleRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const preferenceRoutes = require('./routes/preferenceRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/preferences', preferenceRoutes);

// Create uploads directories if they don't exist
const ensureUploadsDir = () => {
  const dirs = ['uploads', 'uploads/pdfs', 'uploads/images'];
  dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });
};

const startServer = async () => {
  try {
    ensureUploadsDir();

    // 1. Create DB if it doesn't exist
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
    await connection.end();
    console.log(`Database ${dbConfig.database} created or already exists.`);

    // 2. Initialize Sequelize and sync models
    const db = require('./models');
    await db.sequelize.sync();
    console.log('Database models synced automatically.');

    // Self-healing migration to extract text for existing uploaded PDFs
    // (Disabled as requested to skip OCR of existing PDFs on startup)
    // const { reprocessExistingArticles } = require('./utils/pdfProcessor');
    // await reprocessExistingArticles(db.Article);
    
    // Seed an initial article if none exist
    const articleCount = await db.Article.count();
    if (articleCount === 0) {
      await db.Article.create({
        title: 'The Future of AI in Publishing',
        slug: 'future-of-ai-publishing',
        summary: 'Explore how artificial intelligence is transforming the way we create, distribute, and consume digital content.',
        content: '<h2>The Rise of Automated Content Generation</h2><p>In recent years, we have seen a massive leap in generative AI capabilities. From text generation to image synthesis, tools are now able to assist authors in creating more engaging content faster than ever before. This doesn\'t mean human writers are obsolete; rather, their role is shifting from pure generation to curation and direction.</p><p>The publishing industry has traditionally been slow to adopt new technologies, but the current wave of AI tools is proving too powerful to ignore.</p><img src="https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&q=80&w=800" alt="Technology network" /><figcaption>AI networks are becoming more complex and capable.</figcaption><h3>Transforming the Reader Experience</h3><p>For readers, AI means more relevant content and better discovery mechanisms. Recommendation algorithms are becoming sophisticated enough to understand context and nuance, not just basic keywords.</p>',
        heroImage: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&q=80&w=800',
        readTime: 5,
        status: 'published',
      });
      console.log('Seeded initial article.');
    }
    
    const server = app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
    
    server.on('close', () => {
      console.log('HTTP SERVER CLOSED UNEXPECTEDLY!');
    });
    
    server.on('error', (err) => {
      console.error('HTTP SERVER ERROR:', err);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
  }
};

startServer();
