const express = require('express');
const Joi = require('joi');
const Reminder = require('../models/Reminder');
const auth = require('../middleware/auth');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// Validation schemas
const createReminderSchema = Joi.object({
  title: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(500).optional(),
  reminderDate: Joi.date().greater('now').required(),
  isRecurring: Joi.boolean().default(false),
  recurringType: Joi.string().valid('daily', 'weekly', 'monthly', 'yearly').when('isRecurring', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.forbidden()
  })
});

const updateReminderSchema = Joi.object({
  title: Joi.string().min(1).max(200).optional(),
  description: Joi.string().max(500).optional(),
  reminderDate: Joi.date().greater('now').optional(),
  isRecurring: Joi.boolean().optional(),
  recurringType: Joi.string().valid('daily', 'weekly', 'monthly', 'yearly').optional(),
  isCompleted: Joi.boolean().optional()
});

/**
 * @swagger
 * /reminders:
 *   get:
 *     summary: Get user reminders
 *     tags: [Reminders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: completed
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: Reminders retrieved successfully
 */
router.get('/', auth, async (req, res) => {
  try {
    const { completed, page = 1, limit = 20 } = req.query;
    const userId = req.user._id;

    // Build filter
    const filter = { userId };
    if (completed !== undefined) {
      filter.isCompleted = completed === 'true';
    }

    // Check cache
    const cacheKey = `reminders:${userId}:${JSON.stringify(filter)}:${page}:${limit}`;
    let cachedData = await cache.get(cacheKey);

    if (cachedData) {
      return res.json({
        success: true,
        data: cachedData
      });
    }

    // Query database
    const reminders = await Reminder.find(filter)
      .sort({ reminderDate: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Reminder.countDocuments(filter);

    const responseData = {
      reminders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    };

    // Cache results for 5 minutes
    await cache.set(cacheKey, responseData, 300);

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    logger.error('Get reminders error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving reminders'
    });
  }
});

/**
 * @swagger
 * /reminders:
 *   post:
 *     summary: Create a new reminder
 *     tags: [Reminders]
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
 *               - reminderDate
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               reminderDate:
 *                 type: string
 *                 format: date-time
 *               isRecurring:
 *                 type: boolean
 *               recurringType:
 *                 type: string
 *                 enum: [daily, weekly, monthly, yearly]
 *     responses:
 *       201:
 *         description: Reminder created successfully
 */
router.post('/', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = createReminderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    // Create reminder
    const reminder = new Reminder({
      ...value,
      userId: req.user._id
    });

    await reminder.save();

    // Invalidate cache
    await cache.del(`reminders:${req.user._id}:*`);

    logger.info(`Reminder created: ${reminder._id} by user: ${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Reminder created successfully',
      data: { reminder }
    });

  } catch (error) {
    logger.error('Create reminder error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating reminder'
    });
  }
});

/**
 * @swagger
 * /reminders/{id}:
 *   put:
 *     summary: Update a reminder
 *     tags: [Reminders]
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
 *         description: Reminder updated successfully
 */
router.put('/:id', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = updateReminderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    // Find and update reminder
    const reminder = await Reminder.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      value,
      { new: true, runValidators: true }
    );

    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found'
      });
    }

    // Invalidate cache
    await cache.del(`reminders:${req.user._id}:*`);

    logger.info(`Reminder updated: ${reminder._id} by user: ${req.user._id}`);

    res.json({
      success: true,
      message: 'Reminder updated successfully',
      data: { reminder }
    });

  } catch (error) {
    logger.error('Update reminder error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating reminder'
    });
  }
});

/**
 * @swagger
 * /reminders/{id}:
 *   delete:
 *     summary: Delete a reminder
 *     tags: [Reminders]
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
 *         description: Reminder deleted successfully
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const reminder = await Reminder.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!reminder) {
      return res.status(404).json({
        success: false,
        message: 'Reminder not found'
      });
    }

    // Invalidate cache
    await cache.del(`reminders:${req.user._id}:*`);

    logger.info(`Reminder deleted: ${req.params.id} by user: ${req.user._id}`);

    res.json({
      success: true,
      message: 'Reminder deleted successfully'
    });

  } catch (error) {
    logger.error('Delete reminder error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting reminder'
    });
  }
});

module.exports = router;
