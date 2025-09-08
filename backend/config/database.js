const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    // Connection options for better performance and reliability
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      family: 4, // Use IPv4, skip trying IPv6
      bufferMaxEntries: 0, // Disable mongoose buffering
      bufferCommands: false, // Disable mongoose buffering
    };

    // Connect to MongoDB
    const conn = await mongoose.connect(process.env.MONGODB_URI, options);

    logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);
    logger.info(`📊 Database Name: ${conn.connection.name}`);

    // Handle connection events
    mongoose.connection.on('connected', () => {
      logger.info('🔗 Mongoose connected to MongoDB');
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`❌ MongoDB connection error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
    });

    // Handle app termination - graceful shutdown
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

    // Handle process termination
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

    // Optional: Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      logger.error(`💥 Uncaught Exception: ${error.message}`);
      try {
        await mongoose.connection.close();
        logger.info('🔒 MongoDB connection closed due to uncaught exception');
      } catch (closeError) {
        logger.error(`❌ Error closing MongoDB connection: ${closeError.message}`);
      }
      process.exit(1);
    });

    // Return the connection for potential use
    return conn;

  } catch (error) {
    logger.error(`❌ Database connection failed: ${error.message}`);
    
    // Provide helpful error messages
    if (error.message.includes('ENOTFOUND')) {
      logger.error('🌐 Network error: Please check your internet connection and MongoDB URI');
    } else if (error.message.includes('authentication failed')) {
      logger.error('🔐 Authentication error: Please check your MongoDB username and password');
    } else if (error.message.includes('ECONNREFUSED')) {
      logger.error('🚫 Connection refused: Please ensure MongoDB is running');
    }

    // Exit the process with failure
    process.exit(1);
  }
};

// Optional: Export a function to check database health
const checkDatabaseHealth = async () => {
  try {
    // Check if mongoose is connected
    if (mongoose.connection.readyState === 1) {
      // Try to ping the database
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

// Optional: Export a function to get connection info
const getConnectionInfo = () => {
  return {
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name,
    collections: mongoose.connection.collections
  };
};

module.exports = {
  connectDB,
  checkDatabaseHealth,
  getConnectionInfo
};
