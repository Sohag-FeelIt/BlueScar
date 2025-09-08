const express = require('express');
const Joi = require('joi');
const CalendarEvent = require('../models/CalendarEvent');
const auth = require('../middleware/auth');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// Validation schemas
const createEventSchema = Joi.object({
  title: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(1000).optional(),
  startDate: Joi.date().required(),
  endDate: Joi.date().greater(Joi.ref('startDate')).required(),
  location: Joi.string().max(200).optional(),
  isAllDay: Joi.boolean().default(false),
  category: Joi.string().valid('work', 'personal', 'meeting', 'appointment', 'other').default('other'),
  priority: Joi.string().valid('low', 'medium', 'high').default('medium'),
  attendees: Joi.array().items(Joi.object({
    email: Joi.string().email().required(),
    name: Joi.string().max(100).optional()
  })).max(20).optional()
});

const updateEventSchema = Joi.object({
  title: Joi.string().min(1).max(200).optional(),
  description: Joi.string().max(1000).optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  location: Joi.string().max(200).optional(),
  isAllDay: Joi.boolean().optional(),
  category: Joi.string().valid('work', 'personal', 'meeting', 'appointment', 'other').optional(),
  priority: Joi.string().valid('low', 'medium', 'high').optional(),
  status: Joi.string().valid('scheduled', 'completed', 'cancelled').optional(),
  attendees: Joi.array().items(Joi.object({
    email: Joi.string().email().required(),
    name: Joi.string().max(100).optional(),
    status: Joi.string().valid('pending', 'accepted', 'declined').default('pending')
  })).max(20).optional()
}).custom((obj, helpers) => {
  if (obj.startDate && obj.endDate && obj.endDate <= obj.startDate) {
    return helpers.error('any.invalid', { message: 'End date must be after start date' });
  }
  return obj;
});

/**
 * @swagger
 * components:
 *   schemas:
 *     CalendarEvent:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         title:
 *           type: string
 *         description:
 *           type: string
 *         startDate:
 *           type: string
 *           format: date-time
 *         endDate:
 *           type: string
 *           format: date-time
 *         location:
 *           type: string
 *         isAllDay:
 *           type: boolean
 *         category:
 *           type: string
 *           enum: [work, personal, meeting, appointment, other]
 *         priority:
 *           type: string
 *           enum: [low, medium, high]
 *         status:
 *           type: string
 *           enum: [scheduled, completed, cancelled]
 */

/**
 * @swagger
 * /calendar/events:
 *   get:
 *     summary: Get user calendar events
 *     tags: [Calendar]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter events from this date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter events until this date
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [work, personal, meeting, appointment, other]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [scheduled, completed, cancelled]
 *     responses:
 *       200:
 *         description: Calendar events retrieved successfully
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
 *                     events:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/CalendarEvent'
 */
router.get('/events', auth, async (req, res) => {
  try {
    const { startDate, endDate, category, status, page = 1, limit = 50 } = req.query;
    const userId = req.user._id;

    // Build filter
    const filter = { userId };
    
    if (startDate || endDate) {
      filter.startDate = {};
      if (startDate) filter.startDate.$gte = new Date(startDate);
      if (endDate) filter.startDate.$lte = new Date(endDate);
    }
    
    if (category) filter.category = category;
    if (status) filter.status = status;

    // Check cache
    const cacheKey = `calendar_events:${userId}:${JSON.stringify(filter)}:${page}:${limit}`;
    let cachedData = await cache.get(cacheKey);

    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData
      });
    }

    // Query database
    const events = await CalendarEvent.find(filter)
      .sort({ startDate: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await CalendarEvent.countDocuments(filter);

    // Get upcoming events (next 7 days)
    const upcomingFilter = {
      userId,
      startDate: {
        $gte: new Date(),
        $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      status: 'scheduled'
    };
    const upcomingEvents = await CalendarEvent.find(upcomingFilter)
      .sort({ startDate: 1 })
      .limit(5)
      .lean();

    const responseData = {
      events,
      upcomingEvents,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      },
      stats: {
        total,
        scheduled: await CalendarEvent.countDocuments({ userId, status: 'scheduled' }),
        completed: await CalendarEvent.countDocuments({ userId, status: 'completed' }),
        cancelled: await CalendarEvent.countDocuments({ userId, status: 'cancelled' })
      }
    };

    // Cache for 10 minutes
    await cache.set(cacheKey, responseData, 600);

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    logger.error('Get calendar events error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving calendar events'
    });
  }
});

/**
 * @swagger
 * /calendar/events:
 *   post:
 *     summary: Create a new calendar event
 *     tags: [Calendar]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - startDate
 *               - endDate
 *             properties:
 *               title:
 *                 type: string
 *                 maxLength: 200
 *               description:
 *                 type: string
 *                 maxLength: 1000
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *               location:
 *                 type: string
 *               isAllDay:
 *                 type: boolean
 *               category:
 *                 type: string
 *                 enum: [work, personal, meeting, appointment, other]
 *               priority:
 *                 type: string
 *                 enum: [low, medium, high]
 *     responses:
 *       201:
 *         description: Calendar event created successfully
 */
router.post('/events', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = createEventSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    // Check for conflicting events
    const conflictingEvent = await CalendarEvent.findOne({
      userId: req.user._id,
      status: 'scheduled',
      $or: [
        {
          startDate: { $lte: value.startDate },
          endDate: { $gt: value.startDate }
        },
        {
          startDate: { $lt: value.endDate },
          endDate: { $gte: value.endDate }
        },
        {
          startDate: { $gte: value.startDate },
          endDate: { $lte: value.endDate }
        }
      ]
    });

    if (conflictingEvent) {
      return res.status(409).json({
        success: false,
        message: 'Time conflict with existing event',
        conflictingEvent: {
          title: conflictingEvent.title,
          startDate: conflictingEvent.startDate,
          endDate: conflictingEvent.endDate
        }
      });
    }

    // Create event
    const event = new CalendarEvent({
      ...value,
      userId: req.user._id
    });

    await event.save();

    // Invalidate cache
    await cache.del(`calendar_events:${req.user._id}:*`);

    logger.info(`Calendar event created: ${event._id} by user: ${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Calendar event created successfully',
      data: { event }
    });

  } catch (error) {
    logger.error('Create calendar event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating calendar event'
    });
  }
});

/**
 * @swagger
 * /calendar/events/{id}:
 *   get:
 *     summary: Get a specific calendar event
 *     tags: [Calendar]
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
 *         description: Calendar event retrieved successfully
 *       404:
 *         description: Event not found
 */
router.get('/events/:id', auth, async (req, res) => {
  try {
    const event = await CalendarEvent.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Calendar event not found'
      });
    }

    res.json({
      success: true,
      data: { event }
    });

  } catch (error) {
    logger.error('Get calendar event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving calendar event'
    });
  }
});

/**
 * @swagger
 * /calendar/events/{id}:
 *   put:
 *     summary: Update a calendar event
 *     tags: [Calendar]
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
 *         description: Calendar event updated successfully
 *       404:
 *         description: Event not found
 */
router.put('/events/:id', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = updateEventSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    // Find and update event
    const event = await CalendarEvent.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      value,
      { new: true, runValidators: true }
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Calendar event not found'
      });
    }

    // Invalidate cache
    await cache.del(`calendar_events:${req.user._id}:*`);

    logger.info(`Calendar event updated: ${event._id} by user: ${req.user._id}`);

    res.json({
      success: true,
      message: 'Calendar event updated successfully',
      data: { event }
    });

  } catch (error) {
    logger.error('Update calendar event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating calendar event'
    });
  }
});

/**
 * @swagger
 * /calendar/events/{id}:
 *   delete:
 *     summary: Delete a calendar event
 *     tags: [Calendar]
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
 *         description: Calendar event deleted successfully
 *       404:
 *         description: Event not found
 */
router.delete('/events/:id', auth, async (req, res) => {
  try {
    const event = await CalendarEvent.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Calendar event not found'
      });
    }

    // Invalidate cache
    await cache.del(`calendar_events:${req.user._id}:*`);

    logger.info(`Calendar event deleted: ${req.params.id} by user: ${req.user._id}`);

    res.json({
      success: true,
      message: 'Calendar event deleted successfully'
    });

  } catch (error) {
    logger.error('Delete calendar event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting calendar event'
    });
  }
});

module.exports = router;
