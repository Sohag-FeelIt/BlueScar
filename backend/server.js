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

// CRITICAL: Connect to Database BEFORE starting server
(async () => {
  try {
    await connectDB();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 BlueScar Server running on port ${PORT}`);
      logger.info(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      logger.info(`🔍 Health Check: http://localhost:${PORT}/health`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
})();

// Trust proxy for accurate client IP
app.set('trust proxy', 1);

// Security Middleware
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

// Body parsing & compression
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(cookieParser());

// Security sanitization
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

// Rate limiting
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

// CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'https://bluescar.app',
  'https://www.bluescar.app',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
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

// Logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', { 
    stream: { 
      write: msg => logger.info(msg.trim()) 
    },
    skip: (req, res) => res.statusCode < 400
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

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const healthData = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      version: '1.0.0',
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    };
    
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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/email', emailRoutes);

// Socket.IO for real-time features
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('join_room', (userId) => {
    socket.join(`user_${userId}`);
    logger.info(`User ${userId} joined their room`);
    
    socket.emit('connection_confirmed', {
      message: 'Connected to BlueScar',
      timestamp: new Date(),
      userId
    });
  });

  socket.on('send_message', async (data) => {
    try {
      const { message, userId } = data;
      
      if (!message || !userId) {
        socket.emit('error', 'Invalid message data');
        return;
      }

      // Broadcast to user's room
      io.to(`user_${userId}`).emit('new_message', {
        message: message.trim(),
        timestamp: new Date(),
        sender: 'user',
        id: `msg_${Date.now()}`
      });

      // Simple AI response
      setTimeout(() => {
        const aiResponse = "I'm BlueScar, your AI assistant. How can I help you today?";
        io.to(`user_${userId}`).emit('new_message', {
          message: aiResponse,
          timestamp: new Date(),
          sender: 'ai',
          id: `ai_${Date.now()}`
        });
      }, 1000);
      
    } catch (error) {
      logger.error('Socket message error:', error);
      socket.emit('error', 'Message processing failed');
    }
  });

  socket.on('disconnect', (reason) => {
    logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use(errorHandler);

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    
    const mongoose = require('mongoose');
    mongoose.connection.close(() => {
      logger.info('MongoDB connection closed');
      
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

  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

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

module.exports = { app, server, io };
