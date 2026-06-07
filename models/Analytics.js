module.exports = (sequelize, DataTypes) => {
  const Analytics = sequelize.define('Analytics', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    articleId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    readTimeSpent: {
      type: DataTypes.INTEGER, // in seconds
    },
    deviceType: {
      type: DataTypes.STRING,
    },
    location: {
      type: DataTypes.STRING,
    },
  });
  return Analytics;
};
