module.exports = (sequelize, DataTypes) => {
  const UserPreference = sequelize.define('UserPreference', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // visitorId is a UUID stored in localStorage for anonymous users
    // For logged-in users, we can link via userId
    visitorId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // JSON array of language codes, e.g. ["as", "en", "bn"]
    languages: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        const raw = this.getDataValue('languages');
        return raw ? JSON.parse(raw) : [];
      },
      set(val) {
        this.setDataValue('languages', JSON.stringify(val));
      },
    },
    // JSON object mapping language code to style key
    // e.g. { "as": "literary", "en": "editorial" }
    stylePerLanguage: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        const raw = this.getDataValue('stylePerLanguage');
        return raw ? JSON.parse(raw) : {};
      },
      set(val) {
        this.setDataValue('stylePerLanguage', JSON.stringify(val));
      },
    },
    onboardingCompleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  });

  return UserPreference;
};
