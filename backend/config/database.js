const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    // Essential connection options for production stability
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
      bufferMaxEntries: 0,
      bufferCommands: false
    };

    // Check environment variable
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is not defined');
    }

    // Connect to MongoDB
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

    // Graceful shutdown handlers
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        logger.info('🔒 MongoDB connection closed through app termination');
        process.exit(0);
      } catch (error) {
        logger.error(`❌ Error during MongoDB shutdown: ${error.message}`);
        process.exit(1);
      }
    });

    process.on('SIGTERM', async () => {
      try {
        await mongoose.connection.close();
        logger.info('🔒 MongoDB connection closed through SIGTERM');
        process.exit(0);
      } catch (error) {
        logger.error(`❌ Error during MongoDB shutdown: ${error.message}`);
        process.exit(1);
      }
    });

    return conn;

  } catch (error) {
    logger.error(`❌ Database connection failed: ${error.message}`);
    
    // Helpful error diagnostics
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

// Health check function for monitoring
const checkDatabaseHealth = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      return {
        status: 'healthy',
        connected: true,
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host,
        name: mongoose.connection.name
      };
    } else {
      return {
        status: 'unhealthy',
        connected: false,
        readyState: mongoose.connection.readyState,
        message: 'Database not connected'
      };
    }
  } catch (error) {
    logger.error(`Database health check failed: ${error.message}`);
    return {
      status: 'unhealthy',
      connected: false,
      error: error.message
    };
  }
};

// CRITICAL: Export the function directly (not as an object)
module.exports = connectDB;
