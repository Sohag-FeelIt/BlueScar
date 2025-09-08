const express = require('express');
const Joi = require('joi');
const auth = require('../middleware/auth');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// Validation schemas
const sendMessageSchema = Joi.object({
  message: Joi.string().min(1).max(1000).required(),
  type: Joi.string().valid('text', 'command').default('text')
});

/**
 * @swagger
 * components:
 *   schemas:
 *     ChatMessage:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         message:
 *           type: string
 *         sender:
 *           type: string
 *           enum: [user, ai]
 *         timestamp:
 *           type: string
 *           format: date-time
 *         type:
 *           type: string
 *           enum: [text, command, response]
 */

/**
 * @swagger
 * /chat/message:
 *   post:
 *     summary: Send a chat message (HTTP fallback for WebSocket)
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 maxLength: 1000
 *               type:
 *                 type: string
 *                 enum: [text, command]
 *                 default: text
 *     responses:
 *       200:
 *         description: Message processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     userMessage:
 *                       $ref: '#/components/schemas/ChatMessage'
 *                     aiResponse:
 *                       $ref: '#/components/schemas/ChatMessage'
 */
router.post('/message', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = sendMessageSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    const { message, type } = value;
    const userId = req.user._id;

    // Rate limiting check
    const messageCount = await cache.get(`chat_rate_limit:${userId}`);
    if (messageCount && messageCount > 30) {
      return res.status(429).json({
        success: false,
        message: 'Too many messages. Please slow down.'
      });
    }

    // Increment rate limit counter
    await cache.set(`chat_rate_limit:${userId}`, (messageCount || 0) + 1, 60);

    // Create user message object
    const userMessage = {
      id: `msg_${Date.now()}_user`,
      message: message.trim(),
      sender: 'user',
      timestamp: new Date(),
      type: type || 'text'
    };

    // Store message in user's chat history (keep last 100 messages)
    const chatHistory = await cache.get(`chat_history:${userId}`) || [];
    chatHistory.push(userMessage);
    
    // Keep only last 100 messages
    if (chatHistory.length > 100) {
      chatHistory.splice(0, chatHistory.length - 100);
    }

    // Generate AI response
    const aiResponse = await generateIntelligentAIResponse(message, userId, chatHistory);

    const aiMessage = {
      id: `msg_${Date.now()}_ai`,
      message: aiResponse,
      sender: 'ai',
      timestamp: new Date(),
      type: 'response'
    };

    // Add AI response to chat history
    chatHistory.push(aiMessage);
    
    // Update chat history cache (keep for 24 hours)
    await cache.set(`chat_history:${userId}`, chatHistory, 24 * 60 * 60);

    logger.info(`Chat message processed for user: ${userId}`);

    res.json({
      success: true,
      message: 'Chat message processed successfully',
      data: {
        userMessage,
        aiResponse: aiMessage
      }
    });

  } catch (error) {
    logger.error('Chat message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error processing chat message'
    });
  }
});

/**
 * @swagger
 * /chat/history:
 *   get:
 *     summary: Get chat history
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *     responses:
 *       200:
 *         description: Chat history retrieved successfully
 */
router.get('/history', auth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const userId = req.user._id;

    // Get chat history from cache
    const chatHistory = await cache.get(`chat_history:${userId}`) || [];
    
    // Return last N messages
    const limitedHistory = chatHistory.slice(-parseInt(limit));

    res.json({
      success: true,
      data: {
        messages: limitedHistory,
        count: limitedHistory.length
      }
    });

  } catch (error) {
    logger.error('Get chat history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving chat history'
    });
  }
});

/**
 * @swagger
 * /chat/clear:
 *   delete:
 *     summary: Clear chat history
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Chat history cleared successfully
 */
router.delete('/clear', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Clear chat history
    await cache.del(`chat_history:${userId}`);

    logger.info(`Chat history cleared for user: ${userId}`);

    res.json({
      success: true,
      message: 'Chat history cleared successfully'
    });

  } catch (error) {
    logger.error('Clear chat history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error clearing chat history'
    });
  }
});

// Enhanced AI response generator with context awareness and command recognition
async function generateIntelligentAIResponse(message, userId, chatHistory) {
  try {
    const lowerMessage = message.toLowerCase();
    
    // Get user context
    const userContext = await cache.get(`user_context:${userId}`) || {};
    
    // Command recognition
    if (lowerMessage.startsWith('/') || lowerMessage.includes('help')) {
      return generateHelpResponse();
    }
    
    // Intent detection with improved responses
    const intents = {
      greeting: {
        keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'],
        responses: [
          "Hello! I'm BlueScar, your intelligent productivity assistant. I can help you manage tasks, schedule events, order food, send emails, and much more. What would you like to accomplish today?",
          "Hi there! Welcome to BlueScar. I'm here to streamline your day and boost your productivity. How can I assist you?",
          "Good to see you! I'm BlueScar, and I'm ready to help you stay organized and productive. What's on your agenda?"
        ]
      },
      
      task_management: {
        keywords: ['task', 'todo', 'work', 'deadline', 'project', 'assignment'],
        responses: [
          "I can help you manage your tasks efficiently! I can create new tasks, update existing ones, set priorities, and track deadlines. Would you like to add a task, view your current tasks, or organize your workload?",
          "Task management is one of my specialties. I can help you prioritize, organize, and track your work. What specific task would you like to work on?",
          "Let's get your tasks organized! I can create tasks with due dates, set priorities, and help you stay on track. What do you need to accomplish?"
        ]
      },
      
      calendar: {
        keywords: ['schedule', 'meeting', 'appointment', 'calendar', 'event', 'time', 'date'],
        responses: [
          "I'd be happy to help with your calendar! I can schedule meetings, set appointments, check for conflicts, and send reminders. What would you like to schedule?",
          "Calendar management is easy with me! I can create events, check your availability, and make sure you never miss an important meeting. What's the event details?",
          "Let's get that scheduled! I can handle all types of events - meetings, appointments, reminders, and more. Please provide the event details and timing."
        ]
      },
      
      food_order: {
        keywords: ['order', 'food', 'hungry', 'eat', 'restaurant', 'delivery', 'meal', 'lunch', 'dinner'],
        responses: [
          "I can help you order food from your favorite restaurants! I can suggest options based on your preferences, check delivery times, and place orders. What type of cuisine are you craving?",
          "Food delivery coming right up! I can browse restaurants, check menus, and handle the ordering process. What sounds good today?",
          "Let's get you fed! I have access to various restaurants and can help you find the perfect meal. Any specific preferences or dietary restrictions?"
        ]
      },
      
      email: {
        keywords: ['email', 'mail', 'send', 'message', 'compose', 'reply', 'draft'],
        responses: [
          "I can assist with email management! I can compose emails, schedule sending, organize your inbox, and help with replies. Who would you like to email and what's the message about?",
          "Email assistance ready! I can draft professional emails, schedule them for optimal timing, and help manage your communications. What's the email regarding?",
          "Let's handle that email efficiently! I can help compose, format, and send emails. Just provide the recipient and main points you'd like to cover."
        ]
      },
      
      reminder: {
        keywords: ['remind', 'reminder', 'don\'t forget', 'remember', 'alert', 'notify'],
        responses: [
          "I'll make sure you don't forget! I can set up reminders for any time and date, with recurring options if needed. What should I remind you about and when?",
          "Reminder set up coming right up! I can create one-time or recurring reminders with custom notifications. What's the reminder and timing?",
          "I'm great with reminders! I can set alerts for appointments, deadlines, tasks, or anything else. When and what should I remind you about?"
        ]
      },
      
      productivity: {
        keywords: ['productive', 'efficient', 'organize', 'focus', 'workflow', 'optimize'],
        responses: [
          "I'm designed to supercharge your productivity! I can help you organize tasks, optimize your schedule, eliminate distractions, and create efficient workflows. Where would you like to start?",
          "Productivity is my forte! I can analyze your workload, suggest optimizations, and help you focus on what matters most. What area of your productivity would you like to improve?",
          "Let's make your day more efficient! I can help prioritize tasks, streamline processes, and create systems that work for you. What's your biggest productivity challenge?"
        ]
      },
      
      status_question: {
        keywords: ['how are you', 'what can you do', 'your capabilities', 'features', 'help me'],
        responses: [
          "I'm functioning perfectly and ready to help! I'm BlueScar, your AI productivity assistant. I can manage tasks, schedule events, order food, send emails, set reminders, and much more. I'm designed to make your life easier and more organized.",
          "I'm doing great and excited to assist you! My capabilities include task management, calendar scheduling, food ordering, email composition, reminder setting, and general productivity support. How can I help streamline your day?",
          "I'm operating at full capacity and here to serve! I specialize in productivity, organization, and making your daily tasks effortless. Whether it's work, personal tasks, or planning, I've got you covered!"
        ]
      }
    };
    
    // Find matching intent
    let selectedIntent = null;
    let confidence = 0;
    
    for (const [intent, data] of Object.entries(intents)) {
      const matches = data.keywords.filter(keyword => lowerMessage.includes(keyword)).length;
      const currentConfidence = matches / data.keywords.length;
      
      if (currentConfidence > confidence && matches > 0) {
        confidence = currentConfidence;
        selectedIntent = intent;
      }
    }
    
    // Generate response
    if (selectedIntent && confidence > 0.1) {
      const responses = intents[selectedIntent].responses;
      const response = responses[Math.floor(Math.random() * responses.length)];
      
      // Update user context
      userContext.lastIntent = selectedIntent;
      userContext.lastInteraction = new Date();
      userContext.messageCount = (userContext.messageCount || 0) + 1;
      
      await cache.set(`user_context:${userId}`, userContext, 24 * 60 * 60);
      
      return response;
    }
    
    // Default responses for unrecognized input
    const defaultResponses = [
      "I understand you're looking for assistance. I can help with task management, calendar scheduling, food ordering, email composition, reminders, and general productivity support. Could you be more specific about what you need help with?",
      "I'm here to help with various productivity tasks. I can manage your to-dos, schedule events, order meals, draft emails, set reminders, and more. What specific task would you like help with?",
      "I'm BlueScar, your AI productivity assistant. I specialize in organizing your day, managing tasks, scheduling, communication, and more. How can I make your day more productive?",
      "I'm ready to assist with whatever you need! Whether it's work tasks, scheduling, ordering food, managing emails, or staying organized, just let me know how I can help."
    ];
    
    return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
    
  } catch (error) {
    logger.error('AI response generation error:', error);
    return "I apologize, but I'm having trouble processing your request right now. Please try rephrasing your message, and I'll do my best to help!";
  }
}

function generateHelpResponse() {
  return `🤖 **BlueScar AI Assistant Help**

I can help you with:

📋 **Task Management**
- Create, update, and organize tasks
- Set priorities and deadlines
- Track progress and completions

📅 **Calendar & Scheduling**
- Schedule meetings and events
- Check availability and conflicts
- Set up recurring appointments

🍕 **Food Ordering**
- Browse restaurants and menus
- Place delivery orders
- Track order status

✉️ **Email Management**
- Compose and send emails
- Draft professional messages
- Schedule email sending

⏰ **Reminders & Alerts**
- Set one-time or recurring reminders
- Get notified about important tasks
- Never miss deadlines

💡 **Productivity Tips**
- Optimize your workflow
- Organize your day efficiently
- Focus on what matters most

Just tell me what you need help with, and I'll guide you through it!`;
}

module.exports = router;
