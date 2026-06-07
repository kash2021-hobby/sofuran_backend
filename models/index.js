const { Sequelize, DataTypes } = require('sequelize');
const dbConfig = require('../config/db');

const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
  host: dbConfig.host,
  dialect: dbConfig.dialect,
  logging: false,
});

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.User = require('./User')(sequelize, DataTypes);
db.Article = require('./Article')(sequelize, DataTypes);
db.ArticleImage = require('./ArticleImage')(sequelize, DataTypes);
db.Comment = require('./Comment')(sequelize, DataTypes);
db.Analytics = require('./Analytics')(sequelize, DataTypes);
db.Payment = require('./Payment')(sequelize, DataTypes);
db.UserPreference = require('./UserPreference')(sequelize, DataTypes);

// Relationships
db.User.hasMany(db.Article, { foreignKey: 'authorId' });
db.Article.belongsTo(db.User, { foreignKey: 'authorId' });

db.Article.hasMany(db.ArticleImage, { foreignKey: 'articleId' });
db.ArticleImage.belongsTo(db.Article, { foreignKey: 'articleId' });

db.User.hasMany(db.Comment, { foreignKey: 'userId' });
db.Comment.belongsTo(db.User, { foreignKey: 'userId' });
db.Article.hasMany(db.Comment, { foreignKey: 'articleId' });
db.Comment.belongsTo(db.Article, { foreignKey: 'articleId' });

db.Article.hasMany(db.Analytics, { foreignKey: 'articleId' });
db.Analytics.belongsTo(db.Article, { foreignKey: 'articleId' });

db.User.hasMany(db.Payment, { foreignKey: 'userId' });
db.Payment.belongsTo(db.User, { foreignKey: 'userId' });

db.User.hasOne(db.UserPreference, { foreignKey: 'userId' });
db.UserPreference.belongsTo(db.User, { foreignKey: 'userId' });

module.exports = db;
