const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const swaggerUI = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables FIRST
dotenv.config();

const connectDB = require('./config/database');
const { cache } = require('./config/redis');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Route imports
const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const calendarRoutes = require('./routes/calendar');
const chatRoutes = require('./routes/chat');
const reminderRoutes = require('./routes/reminders');
const orderRoutes = require('./routes/orders');
const emailRoutes = require('./routes/email');

const app = express();
const server = http.createServer(app);

// Trust proxy for accurate client IP (moved up for better performance)
app.set('trust proxy', 1);

// OPTIMIZED CORS Configuration - More flexible and secure
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://bluescar.app',
  'https://www.bluescar.app',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (allowedOrigins.some(allowedOrigin => 
        origin === allowedOrigin || 
        origin.endsWith('.vercel.app') || 
        origin.endsWith('.netlify.app')
    )) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin',
    'Cache-Control',
    'X-File-Name'
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
  maxAge: 86400 // Cache preflight for 24 hours
};

app.use(cors(corsOptions));

// Socket.IO Configuration - MOVED UP for better performance
const io = new Server(server, {
  cors: corsOptions,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// OPTIMIZED Security Middleware - Better configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", ...allowedOrigins],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// OPTIMIZED Body parsing & compression - Better limits and configuration
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024
}));

app.use(express.json({ 
  limit: '10mb',
  strict: true,
  type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb',
  parameterLimit: 1000
}));
app.use(cookieParser());

// Security sanitization - OPTIMIZED order
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn(`Sanitized key: ${key} from IP: ${req.ip}`);
  }
}));
app.use(xss());
app.use(hpp({
  whitelist: ['sort', 'fields', 'page', 'limit', 'filter']
}));

// OPTIMIZED Rate limiting - Better configuration
const createRateLimiter = (windowMs, max, message, skipSuccessfulRequests = false) => rateLimit({
  windowMs,
  max,
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, route: ${req.originalUrl}`);
    res.status(429).json({
      success: false,
      message: message || 'Too many requests, please try again later.',
      retryAfter: Math.round(windowMs / 1000)
    });
  }
});

// Apply rate limiting - OPTIMIZED limits
const authLimiter = createRateLimiter(15 * 60 * 1000, 8, 'Too many authentication attempts, please try again in 15 minutes.', true);
const generalLimiter = createRateLimiter(15 * 60 * 1000, 2000, 'Too many requests from this IP, please try again later.');
const chatLimiter = createRateLimiter(1 * 60 * 1000, 100, 'Too many chat messages, please slow down.');

// Apply middleware in OPTIMIZED order
app.use('/api/auth', authLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/', generalLimiter);

// OPTIMIZED Logging - Better performance
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', { 
    stream: { 
      write: msg => logger.info(msg.trim()) 
    },
    skip: (req, res) => {
      // Skip logging for health checks and successful requests under 400ms
      return req.path === '/health' || (res.statusCode < 400 && res.responseTime < 400);
    }
  }));
} else {
  app.use(morgan('dev', {
    skip: (req) => req.path === '/health'
  }));
}

// OPTIMIZED Health check endpoint - Better performance monitoring
app.get('/health', async (req, res) => {
  try {
    const healthData = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      version: '1.0.0',
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024)
      },
      cpu: {
        usage: process.cpuUsage()
      }
    };
    
    // Set cache headers for health check
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.status(200).json(healthData);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      message: 'Service temporarily unavailable'
    });
  }
});

// OPTIMIZED Swagger Documentation - Better configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BlueScar API',
      version: '1.0.0',
      description: 'BlueScar Dashboard API Documentation - Secure, Scalable, Real-time',
      contact: {
        name: 'BlueScar Team',
        email: 'api@bluescar.app'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}/api`,
        description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }
      }
    },
    security: [{
      bearerAuth: []
    }]
  },
  apis: [path.join(__dirname, 'routes/*.js')],
};

const specs = swaggerJsdoc(swaggerOptions);

// Only enable Swagger in development and staging
if (process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(specs, {
    customCss: `
      .swagger-ui .topbar { display: none }
      .swagger-ui .info { margin: 50px 0 }
      .swagger-ui .scheme-container { background: #fafafa; padding: 30px 0 }
    `,
    customSiteTitle: 'BlueScar API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true
    }
  }));
}

// API Routes - OPTIMIZED order (most used first)
app.use('/api/chat', chatRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/email', emailRoutes);

// OPTIMIZED Socket.IO for real-time features
const activeUsers = new Map();

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('join_room', (userId) => {
    if (!userId) {
      socket.emit('error', 'User ID is required');
      return;
    }
    
    socket.join(`user_${userId}`);
    activeUsers.set(socket.id, userId);
    
    logger.info(`User ${userId} joined their room`);
    
    socket.emit('connection_confirmed', {
      message: 'Connected to BlueScar',
      timestamp: new Date(),
      userId,
      socketId: socket.id
    });
  });
  
  socket.on('send_message', async (data) => {
    try {
      const { message, userId } = data;
      
      if (!message || !userId || typeof message !== 'string') {
        socket.emit('error', 'Invalid message data');
        return;
      }
      
      const trimmedMessage = message.trim();
      if (trimmedMessage.length === 0 || trimmedMessage.length > 1000) {
        socket.emit('error', 'Message must be between 1 and 1000 characters');
        return;
      }
      
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Broadcast to user's room
      io.to(`user_${userId}`).emit('new_message', {
        message: trimmedMessage,
        timestamp: new Date(),
        sender: 'user',
        id: messageId
      });
      
      // OPTIMIZED AI response with typing indicator
      io.to(`user_${userId}`).emit('typing_indicator', { isTyping: true });
      
      setTimeout(() => {
        const aiResponses = [
          "I'm BlueScar, your AI assistant. How can I help you today?",
          "Hello! I'm here to assist you with your tasks and questions.",
          "Hi there! What would you like to accomplish today?",
          "Welcome to BlueScar! I'm ready to help you manage your tasks."
        ];
        
        const randomResponse = aiResponses[Math.floor(Math.random() * aiResponses.length)];
        const aiMessageId = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        io.to(`user_${userId}`).emit('typing_indicator', { isTyping: false });
        io.to(`user_${userId}`).emit('new_message', {
          message: randomResponse,
          timestamp: new Date(),
          sender: 'ai',
          id: aiMessageId
        });
      }, Math.random() * 2000 + 1000); // Random delay between 1-3 seconds
      
    } catch (error) {
      logger.error('Socket message error:', error);
      socket.emit('error', 'Message processing failed');
    }
  });
  
  socket.on('disconnect', (reason) => {
    const userId = activeUsers.get(socket.id);
    if (userId) {
      activeUsers.delete(socket.id);
      logger.info(`User ${userId} disconnected: ${socket.id}, reason: ${reason}`);
    } else {
      logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
    }
  });
  
  socket.on('error', (error) => {
    logger.error('Socket error:', error);
  });
});

// 404 handler - OPTIMIZED
app.use('*', (req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.originalUrl} from IP: ${req.ip}`);
  res.status(404).json({
    success: false,
    message: 'API endpoint not found',
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use(errorHandler);

// OPTIMIZED Database connection and server startup
(async () => {
  try {
    // Connect to Database FIRST
    await connectDB();
    logger.info('✅ Database connected successfully');
    
    // Start server
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 BlueScar Server running on port ${PORT}`);
      logger.info(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      logger.info(`🔍 Health Check: http://localhost:${PORT}/health`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`💾 Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    });
    
  } catch (error) {
    logger.error('❌ Server startup failed:', error);
    process.exit(1);
  }
})();

// OPTIMIZED Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      logger.error('Error during server shutdown:', err);
      return process.exit(1);
    }
    
    logger.info('HTTP server closed');
    
    // Close database connection
    const mongoose = require('mongoose');
    mongoose.connection.close((err) => {
      if (err) {
        logger.error('Error closing MongoDB:', err);
      } else {
        logger.info('MongoDB connection closed');
      }
      
      // Close Redis connection
      if (cache && typeof cache.quit === 'function') {
        cache.quit((err) => {
          if (err) {
            logger.error('Error closing Redis:', err);
          } else {
            logger.info('Redis connection closed');
          }
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// Process event handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Export for testing
module.exports = { app, server, io };
