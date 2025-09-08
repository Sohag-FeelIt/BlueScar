const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Reminder title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  reminderDate: {
    type: Date,
    required: [true, 'Reminder date is required'],
    validate: {
      validator: function(date) {
        return date > new Date();
      },
      message: 'Reminder date must be in the future'
    }
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  isRecurring: {
    type: Boolean,
    default: false
  },
  recurringType: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
    required: function() {
      return this.isRecurring;
    }
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  },
  notificationSent: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for performance
reminderSchema.index({ userId: 1, reminderDate: 1 });
reminderSchema.index({ userId: 1, isCompleted: 1 });
reminderSchema.index({ reminderDate: 1, notificationSent: 1 }); // For notification service

// Auto-set completedAt when completed
reminderSchema.pre('save', function(next) {
  if (this.isModified('isCompleted') && this.isCompleted && !this.completedAt) {
    this.completedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Reminder', reminderSchema);
