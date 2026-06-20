module.exports = (sequelize, DataTypes) => {
  const ReadingGoal = sequelize.define('ReadingGoal', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Daily reading goal in minutes
    dailyGoalMinutes: {
      type: DataTypes.INTEGER,
      defaultValue: 5,
    },
    // Date string "YYYY-MM-DD"
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    // Minutes read on that date
    minutesRead: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Number of pages read on that date
    pagesRead: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Last article ID read
    lastArticleId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  });
  return ReadingGoal;
};
