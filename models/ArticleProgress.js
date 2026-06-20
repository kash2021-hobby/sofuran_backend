module.exports = (sequelize, DataTypes) => {
  const ArticleProgress = sequelize.define('ArticleProgress', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    articleId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    currentPage: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalPages: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    lastReadAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    }
  });
  return ArticleProgress;
};
