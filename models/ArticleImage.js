module.exports = (sequelize, DataTypes) => {
  const ArticleImage = sequelize.define('ArticleImage', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    articleId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    imageUrl: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    caption: {
      type: DataTypes.STRING,
    },
    position: {
      type: DataTypes.INTEGER,
    },
  });
  return ArticleImage;
};
