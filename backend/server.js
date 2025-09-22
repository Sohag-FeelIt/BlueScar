const express = require('express');
// Manual CORS - No external package needed
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

// Trust proxy for accurate client IP (Railway requirement)
app.set('trust proxy', 1);

// PRODUCTION-OPTIMIZED CORS CONFIGURATION
const allowedOrigins = [
  // Development URLs
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  
  // Your specific live URLs
  'https://blue-scar-front.vercel.app',
  'https://bluescar-production.up.railway.app',
  
  // Custom domains (future-proof)
  'https://bluescar.app',
  'https://www.bluescar.app',
  
  // Environment variables
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
].filter(Boolean);

// BULLETPROOF MANUAL CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  
  // Check if origin is explicitly allowed
  const isAllowedOrigin = !origin || 
    allowedOrigins.includes(origin) || 
    origin.endsWith('.vercel.app') || 
    origin.endsWith('.netlify.app') ||
    origin.endsWith('.railway.app') ||
    origin.endsWith('.herokuapp.com');
  
  // Additional check for referer (backup security)
  const isAllowedReferer = !referer ||
    allowedOrigins.some(allowed => referer.startsWith(allowed)) ||
    referer.includes('vercel.app') ||
    referer.includes('netlify.app');
  
  // Set CORS headers for allowed origins
  if (isAllowedOrigin || isAllowedReferer) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else {
    // Log blocked requests for monitoring
    logger.warn(`CORS blocked request from origin: ${origin}, referer: ${referer}, IP: ${req.ip}`);
  }
  
  // Essential CORS headers for full functionality
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
  res.header('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control',
    'X-File-Name',
    'X-Api-Key',
    'X-Client-Version'
  ].join(', '));
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'X-Total-Count, X-Page-Count, X-Rate-Limit-Remaining');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours preflight cache
  
  // Handle preflight OPTIONS requests efficiently
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  next();
});

// Socket.IO Configuration with bulletproof CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const isAllowed = !origin || 
        allowedOrigins.includes(origin) || 
        origin.endsWith('.vercel.app') || 
        origin.endsWith('.netlify.app') ||
        origin.endsWith('.railway.app') ||
        origin === 'https://blue-scar-front.vercel.app'; // Your specific frontend
      
      if (isAllowed) {
        callback(null, true);
      } else {
        logger.warn(`Socket.IO CORS blocked: ${origin}`);
        callback(new Error('CORS policy violation'), false);
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'] // Ensure compatibility
});

// PRODUCTION-GRADE Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com", "'unsafe-eval'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", ...allowedOrigins],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "same-origin" }
}));

// OPTIMIZED Body parsing & compression
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024,
  chunkSize: 16 * 1024 // 16KB chunks for better performance
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

app.use(cookieParser(process.env.COOKIE_SECRET));

// Security sanitization with production settings
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn(`Sanitized key: ${key} from IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);
  }
}));

app.use(xss());

app.use(hpp({
  whitelist: ['sort', 'fields', 'page', 'limit', 'filter', 'tags']
}));

// PRODUCTION-OPTIMIZED Rate limiting
const createRateLimiter = (windowMs, max, message, skipSuccessfulRequests = false) => rateLimit({
  windowMs,
  max,
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  skip: (req) => {
    // Skip rate limiting for health checks and monitoring
    return req.path === '/health' || req.path === '/metrics';
  },
  keyGenerator: (req) => {
    // Use X-Forwarded-For for Railway deployment
    return req.ip || req.connection.remoteAddress;
  },
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, route: ${req.originalUrl}, User-Agent: ${req.get('User-Agent')}`);
    res.status(429).json({
      success: false,
      message: message || 'Too many requests, please try again later.',
      retryAfter: Math.round(windowMs / 1000)
    });
  }
});

// Apply rate limiting with production-ready limits
const authLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many authentication attempts, please try again in 15 minutes.', true);
const generalLimiter = createRateLimiter(15 * 60 * 1000, 3000, 'Too many requests from this IP, please try again later.');
const chatLimiter = createRateLimiter(1 * 60 * 1000, 150, 'Too many chat messages, please slow down.');

app.use('/api/auth', authLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/', generalLimiter);

// PRODUCTION Logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', { 
    stream: { 
      write: msg => logger.info(msg.trim()) 
    },
    skip: (req, res) => {
      return req.path === '/health' || 
             req.path === '/metrics' || 
             (res.statusCode < 400 && res.responseTime < 500);
    }
  }));
} else {
  app.use(morgan('dev', {
    skip: (req) => req.path === '/health' || req.path === '/metrics'
  }));
}

// ENHANCED Health check endpoint
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
        external: Math.round(process.memoryUsage().external / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      cpu: {
        usage: process.cpuUsage()
      },
      activeConnections: activeUsers.size,
      cors: {
        allowedOrigins: allowedOrigins.length,
        status: 'configured'
      }
    };
    
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

// Swagger Documentation (development only)
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
        url: process.env.API_BASE_URL || 'https://bluescar-production.up.railway.app/api',
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

// Only enable Swagger in development
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

// API Routes - OPTIMIZED order (most frequently used first)
app.use('/api/chat', chatRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/email', emailRoutes);

// PRODUCTION-OPTIMIZED Socket.IO for real-time features
const activeUsers = new Map();
const userSessions = new Map();

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id} from ${socket.handshake.address}`);
  
  // Connection timeout for inactive sockets
  const connectionTimeout = setTimeout(() => {
    socket.disconnect(true);
    logger.warn(`Socket ${socket.id} disconnected due to inactivity`);
  }, 10 * 60 * 1000); // 10 minutes
  
  socket.on('join_room', (userId) => {
    clearTimeout(connectionTimeout);
    
    if (!userId || typeof userId !== 'string') {
      socket.emit('error', 'Valid User ID is required');
      return;
    }
    
    // Leave previous room if any
    const previousUserId = activeUsers.get(socket.id);
    if (previousUserId) {
      socket.leave(`user_${previousUserId}`);
    }
    
    socket.join(`user_${userId}`);
    activeUsers.set(socket.id, userId);
    userSessions.set(userId, {
      socketId: socket.id,
      joinedAt: new Date(),
      lastActivity: new Date()
    });
    
    logger.info(`User ${userId} joined their room via socket ${socket.id}`);
    
    socket.emit('connection_confirmed', {
      message: 'Connected to BlueScar',
      timestamp: new Date(),
      userId,
      socketId: socket.id,
      activeUsers: activeUsers.size
    });
  });
  
  socket.on('send_message', async (data) => {
    try {
      const { message, userId } = data;
      
      // Enhanced validation
      if (!message || !userId || typeof message !== 'string' || typeof userId !== 'string') {
        socket.emit('error', 'Invalid message data format');
        return;
      }
      
      const trimmedMessage = message.trim();
      if (trimmedMessage.length === 0) {
        socket.emit('error', 'Message cannot be empty');
        return;
      }
      
      if (trimmedMessage.length > 1000) {
        socket.emit('error', 'Message too long (max 1000 characters)');
        return;
      }
      
      // Update user activity
      const userSession = userSessions.get(userId);
      if (userSession) {
        userSession.lastActivity = new Date();
      }
      
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Broadcast to user's room
      io.to(`user_${userId}`).emit('new_message', {
        message: trimmedMessage,
        timestamp: new Date(),
        sender: 'user',
        id: messageId
      });
      
      // AI response with typing indicator
      io.to(`user_${userId}`).emit('typing_indicator', { isTyping: true });
      
      setTimeout(() => {
        const aiResponses = [
          "I'm BlueScar, your AI assistant. How can I help you today?",
          "Hello! I'm here to assist you with your tasks and questions.",
          "Hi there! What would you like to accomplish today?",
          "Welcome to BlueScar! I'm ready to help you manage your tasks.",
          "Great to see you! What can I help you with?",
          "I'm here to make your day more productive. What's on your mind?"
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
    clearTimeout(connectionTimeout);
    
    const userId = activeUsers.get(socket.id);
    if (userId) {
      activeUsers.delete(socket.id);
      userSessions.delete(userId);
      logger.info(`User ${userId} disconnected: ${socket.id}, reason: ${reason}`);
    } else {
      logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
    }
  });
  
  socket.on('error', (error) => {
    logger.error('Socket error:', error);
    socket.emit('error', 'Connection error occurred');
  });
  
  // Handle ping/pong for connection health
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date() });
  });
});

// 404 handler with enhanced logging
app.use('*', (req, res) => {
  logger.warn(`404 - Route not found: ${req.method} ${req.originalUrl} from IP: ${req.ip}, User-Agent: ${req.get('User-Agent')}`);
  res.status(404).json({
    success: false,
    message: 'API endpoint not found',
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
    suggestion: 'Check the API documentation at /api-docs'
  });
});

// Global error handler
app.use(errorHandler);

// PRODUCTION Database connection and server startup
(async () => {
  try {
    // Connect to Database FIRST
    await connectDB();
    logger.info('✅ Database connected successfully');
    
    // Start server
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 BlueScar Server running on port ${PORT}`);
      logger.info(`🌐 Backend URL: https://bluescar-production.up.railway.app`);
      logger.info(`🎨 Frontend URL: https://blue-scar-front.vercel.app`);
      logger.info(`📚 API Documentation: ${process.env.NODE_ENV !== 'production' ? `http://localhost:${PORT}/api-docs` : 'N/A (production)'}`);
      logger.info(`🔍 Health Check: https://bluescar-production.up.railway.app/health`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`💾 Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      logger.info(`🔒 CORS configured for ${allowedOrigins.length} origins`);
    });
    
  } catch (error) {
    logger.error('❌ Server startup failed:', error);
    process.exit(1);
  }
})();

// PRODUCTION Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  // Close server
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
