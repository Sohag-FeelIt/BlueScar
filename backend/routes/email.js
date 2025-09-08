const express = require('express');
const Joi = require('joi');
const auth = require('../middleware/auth');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// Validation schemas
const sendEmailSchema = Joi.object({
  to: Joi.string().email().required(),
  cc: Joi.array().items(Joi.string().email()).max(10).optional(),
  bcc: Joi.array().items(Joi.string().email()).max(10).optional(),
  subject: Joi.string().min(1).max(200).required(),
  body: Joi.string().min(1).max(10000).required(),
  priority: Joi.string().valid('low', 'normal', 'high').default('normal'),
  scheduleFor: Joi.date().greater('now').optional(),
  template: Joi.string().optional(),
  attachments: Joi.array().items(Joi.object({
    filename: Joi.string().required(),
    content: Joi.string().required(),
    contentType: Joi.string().required()
  })).max(5).optional()
});

const draftEmailSchema = Joi.object({
  to: Joi.string().email().optional(),
  cc: Joi.array().items(Joi.string().email()).optional(),
  bcc: Joi.array().items(Joi.string().email()).optional(),
  subject: Joi.string().max(200).optional(),
  body: Joi.string().max(10000).optional(),
  priority: Joi.string().valid('low', 'normal', 'high').optional(),
  scheduleFor: Joi.date().greater('now').optional()
});

/**
 * @swagger
 * components:
 *   schemas:
 *     Email:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         to:
 *           type: string
 *         cc:
 *           type: array
 *           items:
 *             type: string
 *         subject:
 *           type: string
 *         body:
 *           type: string
 *         status:
 *           type: string
 *           enum: [draft, scheduled, sent, failed]
 *         priority:
 *           type: string
 *           enum: [low, normal, high]
 *         createdAt:
 *           type: string
 *           format: date-time
 *         sentAt:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /email/send:
 *   post:
 *     summary: Send an email
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - subject
 *               - body
 *             properties:
 *               to:
 *                 type: string
 *                 format: email
 *               cc:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: email
 *               subject:
 *                 type: string
 *               body:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [low, normal, high]
 *               scheduleFor:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Email sent successfully
 *       201:
 *         description: Email scheduled successfully
 */
router.post('/send', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = sendEmailSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    const { to, cc, bcc, subject, body, priority, scheduleFor, template, attachments } = value;
    const userId = req.user._id;

    // Rate limiting for emails
    const emailCount = await cache.get(`email_rate_limit:${userId}`);
    const hourlyLimit = 50; // 50 emails per hour
    
    if (emailCount && emailCount >= hourlyLimit) {
      return res.status(429).json({
        success: false,
        message: 'Email rate limit exceeded. Please try again in an hour.'
      });
    }

    // Create email object
    const email = {
      id: `email_${Date.now()}_${userId.toString().slice(-4)}`,
      userId,
      to,
      cc: cc || [],
      bcc: bcc || [],
      subject,
      body,
      priority: priority || 'normal',
      template,
      attachments: attachments || [],
      status: scheduleFor ? 'scheduled' : 'sending',
      scheduleFor,
      createdAt: new Date(),
      sentAt: null,
      deliveryStatus: {
        delivered: false,
        opened: false,
        clicked: false
      },
      metadata: {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip
      }
    };

    // If scheduled for future, store and return
    if (scheduleFor) {
      await cache.set(`scheduled_email:${email.id}`, email, 7 * 24 * 60 * 60); // 7 days
      
      // Add to user's scheduled emails
      const scheduledEmails = await cache.get(`user_scheduled_emails:${userId}`) || [];
      scheduledEmails.push(email.id);
      await cache.set(`user_scheduled_emails:${userId}`, scheduledEmails, 7 * 24 * 60 * 60);

      return res.status(201).json({
        success: true,
        message: 'Email scheduled successfully',
        data: { email }
      });
    }

    // Simulate email sending process
    try {
      // In production, integrate with email service (SendGrid, AWS SES, etc.)
      const emailResult = await simulateEmailSending(email);
      
      if (emailResult.success) {
        email.status = 'sent';
        email.sentAt = new Date();
        email.messageId = emailResult.messageId;
      } else {
        email.status = 'failed';
        email.error = emailResult.error;
      }

    } catch (sendError) {
      email.status = 'failed';
      email.error = sendError.message;
      logger.error('Email sending error:', sendError);
    }

    // Store email in history
    await cache.set(`email:${email.id}`, email, 30 * 24 * 60 * 60); // 30 days
    
    // Add to user's email history
    const userEmails = await cache.get(`user_emails:${userId}`) || [];
    userEmails.unshift(email.id);
    
    // Keep only last 100 emails
    if (userEmails.length > 100) {
      userEmails.splice(100);
    }
    
    await cache.set(`user_emails:${userId}`, userEmails, 30 * 24 * 60 * 60);

    // Update rate limit counter
    await cache.set(`email_rate_limit:${userId}`, (emailCount || 0) + 1, 60 * 60);

    logger.info(`Email ${email.status}: ${email.id} by user: ${userId}`);

    const statusCode = email.status === 'sent' ? 200 : 500;
    const message = email.status === 'sent' ? 'Email sent successfully' : 'Email sending failed';

    res.status(statusCode).json({
      success: email.status === 'sent',
      message,
      data: { email }
    });

  } catch (error) {
    logger.error('Send email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error sending email'
    });
  }
});

/**
 * @swagger
 * /email/drafts:
 *   post:
 *     summary: Save email as draft
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Draft saved successfully
 */
router.post('/drafts', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = draftEmailSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    const userId = req.user._id;

    // Create draft
    const draft = {
      id: `draft_${Date.now()}_${userId.toString().slice(-4)}`,
      userId,
      ...value,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Store draft
    await cache.set(`draft:${draft.id}`, draft, 30 * 24 * 60 * 60); // 30 days
    
    // Add to user's drafts
    const userDrafts = await cache.get(`user_drafts:${userId}`) || [];
    userDrafts.unshift(draft.id);
    
    // Keep only last 50 drafts
    if (userDrafts.length > 50) {
      userDrafts.splice(50);
    }
    
    await cache.set(`user_drafts:${userId}`, userDrafts, 30 * 24 * 60 * 60);

    logger.info(`Email draft saved: ${draft.id} by user: ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Draft saved successfully',
      data: { draft }
    });

  } catch (error) {
    logger.error('Save draft error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error saving draft'
    });
  }
});

/**
 * @swagger
 * /email:
 *   get:
 *     summary: Get user's email history
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [draft, scheduled, sent, failed]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: Email history retrieved successfully
 */
router.get('/', auth, async (req, res) => {
  try {
    const { status, limit = 20 } = req.query;
    const userId = req.user._id;

    let emailIds = [];
    
    if (status === 'draft') {
      emailIds = await cache.get(`user_drafts:${userId}`) || [];
    } else if (status === 'scheduled') {
      emailIds = await cache.get(`user_scheduled_emails:${userId}`) || [];
    } else {
      emailIds = await cache.get(`user_emails:${userId}`) || [];
    }

    if (emailIds.length === 0) {
      return res.json({
        success: true,
        data: {
          emails: [],
          count: 0
        }
      });
    }

    // Get email details
    const emails = [];
    const limitedEmailIds = emailIds.slice(0, parseInt(limit));

    for (const emailId of limitedEmailIds) {
      const prefix = status === 'draft' ? 'draft:' : 
                   status === 'scheduled' ? 'scheduled_email:' : 'email:';
      const email = await cache.get(`${prefix}${emailId}`);
      
      if (email && (!status || email.status === status)) {
        emails.push(email);
      }
    }

    res.json({
      success: true,
      data: {
        emails,
        count: emails.length,
        totalEmails: emailIds.length
      }
    });

  } catch (error) {
    logger.error('Get emails error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving emails'
    });
  }
});

/**
 * @swagger
 * /email/templates:
 *   get:
 *     summary: Get email templates
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Email templates retrieved successfully
 */
router.get('/templates', auth, async (req, res) => {
  try {
    // Mock templates - In production, store in database
    const templates = [
      {
        id: 'template_001',
        name: 'Meeting Request',
        category: 'Business',
        subject: 'Meeting Request - {{date}}',
        body: `Hi {{recipient_name}},

I hope this email finds you well. I would like to schedule a meeting to discuss {{topic}}.

Proposed time: {{date}} at {{time}}
Duration: {{duration}}
Location: {{location}}

Please let me know if this time works for you, or suggest an alternative.

Best regards,
{{sender_name}}`,
        variables: ['recipient_name', 'topic', 'date', 'time', 'duration', 'location', 'sender_name']
      },
      {
        id: 'template_002',
        name: 'Follow-up Email',
        category: 'Business',
        subject: 'Following up on {{topic}}',
        body: `Hi {{recipient_name}},

I wanted to follow up on our conversation about {{topic}}.

{{follow_up_details}}

Please let me know your thoughts or if you need any additional information.

Thank you for your time.

Best regards,
{{sender_name}}`,
        variables: ['recipient_name', 'topic', 'follow_up_details', 'sender_name']
      },
      {
        id: 'template_003',
        name: 'Thank You Note',
        category: 'Personal',
        subject: 'Thank you for {{occasion}}',
        body: `Dear {{recipient_name}},

I wanted to take a moment to thank you for {{occasion}}. {{personal_message}}

Your {{quality}} means a lot to me, and I'm grateful to have you in my life.

With appreciation,
{{sender_name}}`,
        variables: ['recipient_name', 'occasion', 'personal_message', 'quality', 'sender_name']
      }
    ];

    res.json({
      success: true,
      data: { templates }
    });

  } catch (error) {
    logger.error('Get templates error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving templates'
    });
  }
});

/**
 * @swagger
 * /email/{id}:
 *   get:
 *     summary: Get specific email details
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email details retrieved successfully
 *       404:
 *         description: Email not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const emailId = req.params.id;
    const userId = req.user._id;

    // Try different prefixes
    const prefixes = ['email:', 'draft:', 'scheduled_email:'];
    let email = null;

    for (const prefix of prefixes) {
      email = await cache.get(`${prefix}${emailId}`);
      if (email) break;
    }

    if (!email) {
      return res.status(404).json({
        success: false,
        message: 'Email not found'
      });
    }

    // Verify email belongs to user
    if (email.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: { email }
    });

  } catch (error) {
    logger.error('Get email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving email'
    });
  }
});

// Helper function to simulate email sending
async function simulateEmailSending(email) {
  return new Promise((resolve) => {
    // Simulate processing time
    setTimeout(() => {
      // 95% success rate simulation
      const success = Math.random() > 0.05;
      
      if (success) {
        resolve({
          success: true,
          messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        });
      } else {
        resolve({
          success: false,
          error: 'Simulated delivery failure'
        });
      }
    }, 500 + Math.random() * 1000); // Random delay 0.5-1.5 seconds
  });
}

module.exports = router;
