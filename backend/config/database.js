const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    // Modern, stable connection options only
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true
    };

    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is not defined');
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI, options);

    logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);
    logger.info(`📊 Database Name: ${conn.connection.name}`);

    // Connection event handlers
    mongoose.connection.on('connected', () => {
      logger.info('🔗 Mongoose connected to MongoDB');
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`❌ MongoDB connection error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
    });

    return conn;

  } catch (error) {
    logger.error(`❌ Database connection failed: ${error.message}`);
    
    if (error.message.includes('ENOTFOUND')) {
      logger.error('🌐 Network error: Check your internet connection and MongoDB URI');
    } else if (error.message.includes('authentication failed')) {
      logger.error('🔐 Authentication error: Check MongoDB username and password');
    } else if (error.message.includes('ECONNREFUSED')) {
      logger.error('🚫 Connection refused: Ensure MongoDB is running');
    }
    
    process.exit(1);
  }
};

// Export the function directly
module.exports = connectDB;
