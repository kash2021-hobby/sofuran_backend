module.exports = (sequelize, DataTypes) => {
  const Article = sequelize.define('Article', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    slug: {
      type: DataTypes.STRING,
      unique: true,
    },
    summary: {
      type: DataTypes.TEXT,
    },
    content: {
      type: DataTypes.TEXT('long'),
    },
    heroImage: {
      type: DataTypes.STRING,
    },
    readTime: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    views: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    likes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.ENUM('draft', 'published'),
      defaultValue: 'draft',
    },
    ocrStatus: {
      type: DataTypes.ENUM('none', 'awaiting_classification', 'processing', 'completed', 'failed'),
      defaultValue: 'none',
    },
    uploadedPdf: {
      type: DataTypes.STRING,
    },
    pages: {
      type: DataTypes.TEXT('long'),
    },
    pageCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    pageTexts: {
      type: DataTypes.TEXT('long'),
    },
    // Publisher classification: JSON array like ["cover", "normal", "poem", "normal", ...]
    pageTypes: {
      type: DataTypes.TEXT('long'),
    },
    // Original language code of the article, e.g. "as", "bn", "hi", "en"
    originalLanguage: {
      type: DataTypes.STRING,
      defaultValue: 'as',
    },
    // JSON: { "hi": [...pageTexts...], "en": [...pageTexts...] }
    translations: {
      type: DataTypes.TEXT('long'),
    },
    // "none", "processing", "completed", "failed"
    translationStatus: {
      type: DataTypes.STRING,
      defaultValue: 'none',
    },
    authorId: {
      type: DataTypes.INTEGER,
    },
  });
  return Article;
};
