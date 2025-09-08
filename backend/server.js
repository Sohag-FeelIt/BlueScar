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

// Load environment variables
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
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  }
});

// Connect to Database
connectDB();

// Trust proxy for accurate client IP (important for rate limiting)
app.set('trust proxy', 1);

// Enhanced Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Body parsing & compression (moved before other middleware)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(cookieParser());

// Security sanitization
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// Enhanced Rate limiting with different tiers
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, route: ${req.originalUrl}`);
    res.status(429).json({
      success: false,
      message: message || 'Too many requests, please try again later.',
      retryAfter: Math.round(windowMs / 1000)
    });
  }
});

const authLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many authentication attempts, please try again in 15 minutes.');
const generalLimiter = createRateLimiter(15 * 60 * 1000, 1000, 'Too many requests from this IP, please try again later.');
const chatLimiter = createRateLimiter(1 * 60 * 1000, 50, 'Too many chat messages, please slow down.');

// Apply rate limiting
app.use('/api/auth', authLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/', generalLimiter);

// Enhanced CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'https://bluescar.app',
  'https://www.bluescar.app',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Enhanced Logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', { 
    stream: { 
      write: msg => logger.info(msg.trim()) 
    },
    skip: (req, res) => res.statusCode < 400 // Only log errors in production
  }));
} else {
  app.use(morgan('dev'));
}

// Swagger Documentation
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
      }
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:5000/api',
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
app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(specs, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'BlueScar API Documentation'
}));

// Health check endpoint with detailed system info
app.get('/health', async (req, res) => {
  try {
    const { checkDatabaseHealth } = require('./config/database');
    const { cache } = require('./config/redis');
    
    // Check database health
    const dbHealth = await checkDatabaseHealth();
    
    // Check Redis health
    let cacheHealth = { status: 'unavailable' };
    try {
      await cache.set('health_check', 'ok', 10);
      const result = await cache.get('health_check');
      cacheHealth = {
        status: result === 'ok' ? 'healthy' : 'unhealthy',
        connected: true
      };
    } catch (error) {
      cacheHealth = { status: 'unhealthy', connected: false };
    }
    
    const healthData = {
      status: dbHealth.status === 'healthy' ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
      services: {
        database: dbHealth,
        cache: cacheHealth
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    };

    res.status(dbHealth.status === 'healthy' ? 200 : 503).json(healthData);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      message: 'Service temporarily unavailable'
    });
  }
});

// API Routes with enhanced error handling
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/email', emailRoutes);

// Enhanced Socket.IO for real-time features
const activeUsers = new Map();

io.use((socket, next) => {
  // Add authentication middleware for sockets
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  // Verify token here
  next();
});

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('join_room', (userId) => {
    try {
      socket.join(`user_${userId}`);
      activeUsers.set(socket.id, userId);
      logger.info(`User ${userId} joined their room`);
      
      // Send connection confirmation
      socket.emit('connection_confirmed', {
        message: 'Connected to BlueScar',
        timestamp: new Date(),
        userId
      });
    } catch (error) {
      logger.error('Error joining room:', error);
      socket.emit('error', 'Failed to join room');
    }
  });
  
  socket.on('send_message', async (data) => {
    try {
      const { message, userId } = data;
      
      // Input validation
      if (!message || typeof message !== 'string' || message.length > 1000) {
        socket.emit('error', 'Invalid message format');
        return;
      }
      
      if (!userId) {
        socket.emit('error', 'User ID required');
        return;
      }
      
      // Rate limiting for messages (additional layer)
      const messageCount = await cache.get(`message_count_${userId}`);
      if (messageCount && messageCount > 20) {
        socket.emit('error', 'Message rate limit exceeded');
        return;
      }
      
      await cache.set(`message_count_${userId}`, (messageCount || 0) + 1, 60);
      
      // Sanitize message
      const sanitizedMessage = message.trim().substring(0, 1000);
      
      // Broadcast to user's room
      io.to(`user_${userId}`).emit('new_message', {
        message: sanitizedMessage,
        timestamp: new Date(),
        sender: 'user',
        id: `msg_${Date.now()}`
      });
      
      // Enhanced AI response with context awareness
      setTimeout(async () => {
        const aiResponse = await generateEnhancedAIResponse(sanitizedMessage, userId);
        io.to(`user_${userId}`).emit('new_message', {
          message: aiResponse,
          timestamp: new Date(),
          sender: 'ai',
          id: `ai_${Date.now()}`
        });
      }, Math.random() * 1000 + 500); // Random delay for more natural feel
      
    } catch (error) {
      logger.error('Socket message error:', error);
      socket.emit('error', 'Message processing failed');
    }
  });
  
  socket.on('typing_start', (data) => {
    socket.to(`user_${data.userId}`).emit('user_typing', { userId: data.userId });
  });
  
  socket.on('typing_stop', (data) => {
    socket.to(`user_${data.userId}`).emit('user_stopped_typing', { userId: data.userId });
  });
  
  socket.on('disconnect', (reason) => {
    const userId = activeUsers.get(socket.id);
    activeUsers.delete(socket.id);
    logger.info(`Client disconnected: ${socket.id}, reason: ${reason}, userId: ${userId}`);
  });
});

// Enhanced AI response generator with context
async function generateEnhancedAIResponse(message, userId) {
  try {
    const lowerMessage = message.toLowerCase();
    
    // Get user context from cache
    const userContext = await cache.get(`user_context_${userId}`) || {};
    
    // Enhanced responses based on context and keywords
    const responses = {
      greeting: [
        "Hello! I'm BlueScar, your productivity assistant. How can I help you today?",
        "Hi there! Ready to make your day more productive? What can I do for you?",
        "Welcome to BlueScar! I'm here to help with tasks, scheduling, and more."
      ],
      schedule: [
        "I'd be happy to help you schedule that. Please provide the date, time, and event details.",
        "Let's get that scheduled! What's the event and when would you like it?",
        "Sure thing! Tell me when and what you'd like to schedule."
      ],
      order: [
        "I can help you order food! What type of cuisine are you in the mood for?",
        "Food delivery coming up! Which restaurant or cuisine would you prefer?",
        "Let's get you fed! What would you like to order?"
      ],
      email: [
        "I can help compose that email. Who's the recipient and what's the subject?",
        "Email assistance ready! Tell me who you're writing to and the main topic.",
        "Let's draft that email together. What are the key details?"
      ],
      task: [
        "I can help manage your tasks. Would you like to add, view, or update a task?",
        "Task management at your service! What would you like to do?",
        "Let's organize your tasks. What needs attention?"
      ],
      reminder: [
        "I'd be happy to set a reminder for you. What and when should I remind you?",
        "Reminder coming right up! What should I remind you about and when?",
        "Sure! Give me the reminder details and timing."
      ]
    };
    
    // Determine response category
    let category = 'default';
    if (/(hi|hello|hey|good morning|good afternoon)/i.test(lowerMessage)) {
      category = 'greeting';
    } else if (/(schedule|meeting|appointment|calendar)/i.test(lowerMessage)) {
      category = 'schedule';
    } else if (/(order|food|restaurant|delivery|eat)/i.test(lowerMessage)) {
      category = 'order';
    } else if (/(email|mail|send|compose)/i.test(lowerMessage)) {
      category = 'email';
    } else if (/(task|todo|do|work)/i.test(lowerMessage)) {
      category = 'task';
    } else if (/(remind|reminder|alert)/i.test(lowerMessage)) {
      category = 'reminder';
    }
    
    // Select random response from category
    const categoryResponses = responses[category] || [
      "I can help with tasks, calendar events, food orders, emails, and reminders. What would you like to do?",
      "I'm here to assist with your productivity needs. How can I help?",
      "What can I help you accomplish today?"
    ];
    
    const response = categoryResponses[Math.floor(Math.random() * categoryResponses.length)];
    
    // Update user context
    userContext.lastInteraction = new Date();
    userContext.messageCount = (userContext.messageCount || 0) + 1;
    await cache.set(`user_context_${userId}`, userContext, 24 * 60 * 60); // 24 hours
    
    return response;
    
  } catch (error) {
    logger.error('AI response generation error:', error);
    return "I'm here to help! Could you please rephrase your request?";
  }
}

// Health check helper functions
async function checkDatabaseHealth() {
  try {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1 ? 'healthy' : 'unhealthy';
  } catch (error) {
    return 'unhealthy';
  }
}

async function checkCacheHealth() {
  try {
    await cache.set('health_check', 'ok', 10);
    const result = await cache.get('health_check');
    return result === 'ok' ? 'healthy' : 'unhealthy';
  } catch (error) {
    return 'unhealthy';
  }
}

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Enhanced Global error handler
app.use(errorHandler);

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    // Close database connections
    const mongoose = require('mongoose');
    mongoose.connection.close(() => {
      logger.info('MongoDB connection closed');
      
      // Close Redis connection
      if (cache.quit) {
        cache.quit(() => {
          logger.info('Redis connection closed');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  logger.info(`🚀 BlueScar Server running on port ${PORT}`);
  logger.info(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
  logger.info(`🔍 Health Check: http://localhost:${PORT}/health`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server, io };
