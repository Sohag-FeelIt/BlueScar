const express = require('express');
const Joi = require('joi');
const auth = require('../middleware/auth');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const router = express.Router();

// Validation schemas
const placeOrderSchema = Joi.object({
  restaurant: Joi.string().min(1).max(200).required(),
  items: Joi.array().items(Joi.object({
    name: Joi.string().required(),
    quantity: Joi.number().integer().min(1).required(),
    price: Joi.number().min(0).required(),
    specialInstructions: Joi.string().max(200).optional()
  })).min(1).required(),
  deliveryAddress: Joi.object({
    street: Joi.string().required(),
    city: Joi.string().required(),
    postalCode: Joi.string().required(),
    instructions: Joi.string().max(200).optional()
  }).required(),
  paymentMethod: Joi.string().valid('credit_card', 'debit_card', 'cash', 'digital_wallet').default('credit_card'),
  specialRequests: Joi.string().max(500).optional(),
  tip: Joi.number().min(0).max(100).optional()
});

/**
 * @swagger
 * components:
 *   schemas:
 *     Order:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         restaurant:
 *           type: string
 *         items:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               quantity:
 *                 type: number
 *               price:
 *                 type: number
 *         status:
 *           type: string
 *           enum: [placed, confirmed, preparing, out_for_delivery, delivered, cancelled]
 *         totalAmount:
 *           type: number
 *         estimatedDelivery:
 *           type: string
 *         orderTime:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /orders/restaurants:
 *   get:
 *     summary: Get available restaurants
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cuisine
 *         schema:
 *           type: string
 *       - in: query
 *         name: location
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Restaurants retrieved successfully
 */
router.get('/restaurants', auth, async (req, res) => {
  try {
    const { cuisine, location } = req.query;
    const userId = req.user._id;

    // Check cache first
    const cacheKey = `restaurants:${cuisine || 'all'}:${location || 'default'}`;
    let cachedRestaurants = await cache.get(cacheKey);

    if (cachedRestaurants) {
      return res.json({
        success: true,
        data: cachedRestaurants
      });
    }

    // Mock restaurant data - In production, integrate with real food delivery APIs
    const restaurants = [
      {
        id: 'rest_001',
        name: 'Pizza Palace',
        cuisine: 'Italian',
        rating: 4.5,
        deliveryTime: '25-35 mins',
        deliveryFee: 2.99,
        minimumOrder: 15.00,
        image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591',
        popular: true,
        categories: ['Pizza', 'Pasta', 'Salads']
      },
      {
        id: 'rest_002',
        name: 'Burger Hub',
        cuisine: 'American',
        rating: 4.3,
        deliveryTime: '20-30 mins',
        deliveryFee: 1.99,
        minimumOrder: 12.00,
        image: 'https://images.unsplash.com/photo-1571091718767-18b5b1457add',
        popular: true,
        categories: ['Burgers', 'Fries', 'Shakes']
      },
      {
        id: 'rest_003',
        name: 'Sushi Master',
        cuisine: 'Japanese',
        rating: 4.7,
        deliveryTime: '30-40 mins',
        deliveryFee: 3.99,
        minimumOrder: 20.00,
        image: 'https://images.unsplash.com/photo-1579584425555-c3ce17fd4351',
        popular: false,
        categories: ['Sushi', 'Sashimi', 'Miso Soup']
      },
      {
        id: 'rest_004',
        name: 'Healthy Greens',
        cuisine: 'Healthy',
        rating: 4.4,
        deliveryTime: '15-25 mins',
        deliveryFee: 2.49,
        minimumOrder: 10.00,
        image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd',
        popular: false,
        categories: ['Salads', 'Bowls', 'Smoothies']
      },
      {
        id: 'rest_005',
        name: 'Spice Route',
        cuisine: 'Indian',
        rating: 4.6,
        deliveryTime: '35-45 mins',
        deliveryFee: 2.99,
        minimumOrder: 18.00,
        image: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641',
        popular: true,
        categories: ['Curry', 'Biryani', 'Naan']
      }
    ];

    // Filter by cuisine if specified
    let filteredRestaurants = restaurants;
    if (cuisine) {
      filteredRestaurants = restaurants.filter(r => 
        r.cuisine.toLowerCase().includes(cuisine.toLowerCase())
      );
    }

    // Sort by popularity and rating
    filteredRestaurants.sort((a, b) => {
      if (a.popular && !b.popular) return -1;
      if (!a.popular && b.popular) return 1;
      return b.rating - a.rating;
    });

    const responseData = {
      restaurants: filteredRestaurants,
      totalCount: filteredRestaurants.length,
      cuisineTypes: [...new Set(restaurants.map(r => r.cuisine))]
    };

    // Cache for 30 minutes
    await cache.set(cacheKey, responseData, 30 * 60);

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    logger.error('Get restaurants error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving restaurants'
    });
  }
});

/**
 * @swagger
 * /orders/restaurants/{id}/menu:
 *   get:
 *     summary: Get restaurant menu
 *     tags: [Orders]
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
 *         description: Menu retrieved successfully
 */
router.get('/restaurants/:id/menu', auth, async (req, res) => {
  try {
    const restaurantId = req.params.id;

    // Check cache
    const cacheKey = `menu:${restaurantId}`;
    let cachedMenu = await cache.get(cacheKey);

    if (cachedMenu) {
      return res.json({
        success: true,
        data: cachedMenu
      });
    }

    // Mock menu data - In production, fetch from restaurant API
    const menus = {
      'rest_001': {
        restaurant: 'Pizza Palace',
        categories: [
          {
            name: 'Pizzas',
            items: [
              { id: 'pizza_001', name: 'Margherita Pizza', price: 14.99, description: 'Fresh tomato, mozzarella, basil' },
              { id: 'pizza_002', name: 'Pepperoni Pizza', price: 16.99, description: 'Pepperoni, mozzarella, tomato sauce' },
              { id: 'pizza_003', name: 'Supreme Pizza', price: 19.99, description: 'Pepperoni, mushrooms, peppers, olives' }
            ]
          },
          {
            name: 'Sides',
            items: [
              { id: 'side_001', name: 'Garlic Bread', price: 5.99, description: 'Fresh baked with garlic butter' },
              { id: 'side_002', name: 'Caesar Salad', price: 8.99, description: 'Romaine, croutons, parmesan' }
            ]
          }
        ]
      },
      'rest_002': {
        restaurant: 'Burger Hub',
        categories: [
          {
            name: 'Burgers',
            items: [
              { id: 'burger_001', name: 'Classic Burger', price: 12.99, description: 'Beef patty, lettuce, tomato, pickle' },
              { id: 'burger_002', name: 'Cheese Burger', price: 14.99, description: 'Classic burger with cheese' },
              { id: 'burger_003', name: 'Deluxe Burger', price: 17.99, description: 'Double patty, bacon, all toppings' }
            ]
          },
          {
            name: 'Sides',
            items: [
              { id: 'fries_001', name: 'Regular Fries', price: 4.99, description: 'Crispy golden fries' },
              { id: 'shake_001', name: 'Chocolate Shake', price: 6.99, description: 'Rich chocolate milkshake' }
            ]
          }
        ]
      }
    };

    const menu = menus[restaurantId] || { restaurant: 'Unknown', categories: [] };

    // Cache for 1 hour
    await cache.set(cacheKey, menu, 60 * 60);

    res.json({
      success: true,
      data: menu
    });

  } catch (error) {
    logger.error('Get menu error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving menu'
    });
  }
});

/**
 * @swagger
 * /orders/place:
 *   post:
 *     summary: Place a food order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - restaurant
 *               - items
 *               - deliveryAddress
 *             properties:
 *               restaurant:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     price:
 *                       type: number
 *               deliveryAddress:
 *                 type: object
 *                 properties:
 *                   street:
 *                     type: string
 *                   city:
 *                     type: string
 *                   postalCode:
 *                     type: string
 *     responses:
 *       201:
 *         description: Order placed successfully
 */
router.post('/place', auth, async (req, res) => {
  try {
    // Validate input
    const { error, value } = placeOrderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        details: error.details[0].message
      });
    }

    const { restaurant, items, deliveryAddress, paymentMethod, specialRequests, tip } = value;
    const userId = req.user._id;

    // Calculate order totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const deliveryFee = subtotal > 25 ? 0 : 2.99; // Free delivery over $25
    const tax = subtotal * 0.08; // 8% tax
    const tipAmount = tip || 0;
    const totalAmount = subtotal + deliveryFee + tax + tipAmount;

    // Generate order
    const order = {
      id: `order_${Date.now()}_${userId.toString().slice(-4)}`,
      userId,
      restaurant,
      items: items.map(item => ({
        ...item,
        total: item.price * item.quantity
      })),
      deliveryAddress,
      paymentMethod,
      specialRequests,
      subtotal: parseFloat(subtotal.toFixed(2)),
      deliveryFee: parseFloat(deliveryFee.toFixed(2)),
      tax: parseFloat(tax.toFixed(2)),
      tip: parseFloat(tipAmount.toFixed(2)),
      totalAmount: parseFloat(totalAmount.toFixed(2)),
      status: 'placed',
      orderTime: new Date(),
      estimatedDelivery: new Date(Date.now() + 35 * 60 * 1000), // 35 minutes from now
      trackingUpdates: [
        {
          status: 'placed',
          timestamp: new Date(),
          message: 'Order placed successfully'
        }
      ]
    };

    // Store order in cache (in production, save to database)
    await cache.set(`order:${order.id}`, order, 24 * 60 * 60); // 24 hours

    // Add to user's order history
    const userOrders = await cache.get(`user_orders:${userId}`) || [];
    userOrders.unshift(order.id); // Add to beginning
    
    // Keep only last 50 orders
    if (userOrders.length > 50) {
      userOrders.splice(50);
    }
    
    await cache.set(`user_orders:${userId}`, userOrders, 30 * 24 * 60 * 60); // 30 days

    // Simulate order progression (in production, integrate with restaurant systems)
    setTimeout(async () => {
      order.status = 'confirmed';
      order.trackingUpdates.push({
        status: 'confirmed',
        timestamp: new Date(),
        message: 'Restaurant confirmed your order'
      });
      await cache.set(`order:${order.id}`, order, 24 * 60 * 60);
    }, 2 * 60 * 1000); // 2 minutes

    setTimeout(async () => {
      order.status = 'preparing';
      order.trackingUpdates.push({
        status: 'preparing',
        timestamp: new Date(),
        message: 'Your order is being prepared'
      });
      await cache.set(`order:${order.id}`, order, 24 * 60 * 60);
    }, 8 * 60 * 1000); // 8 minutes

    logger.info(`Food order placed: ${order.id} by user: ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: { order }
    });

  } catch (error) {
    logger.error('Place order error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error placing order'
    });
  }
});

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: Get user's order history
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [placed, confirmed, preparing, out_for_delivery, delivered, cancelled]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: Order history retrieved successfully
 */
router.get('/', auth, async (req, res) => {
  try {
    const { status, limit = 10 } = req.query;
    const userId = req.user._id;

    // Get user's order IDs
    const userOrderIds = await cache.get(`user_orders:${userId}`) || [];
    
    if (userOrderIds.length === 0) {
      return res.json({
        success: true,
        data: {
          orders: [],
          count: 0
        }
      });
    }

    // Get order details
    const orders = [];
    const limitedOrderIds = userOrderIds.slice(0, parseInt(limit));

    for (const orderId of limitedOrderIds) {
      const order = await cache.get(`order:${orderId}`);
      if (order && (!status || order.status === status)) {
        orders.push(order);
      }
    }

    res.json({
      success: true,
      data: {
        orders,
        count: orders.length,
        totalOrders: userOrderIds.length
      }
    });

  } catch (error) {
    logger.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving orders'
    });
  }
});

/**
 * @swagger
 * /orders/{id}:
 *   get:
 *     summary: Get specific order details and tracking
 *     tags: [Orders]
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
 *         description: Order details retrieved successfully
 *       404:
 *         description: Order not found
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user._id;

    const order = await cache.get(`order:${orderId}`);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Verify order belongs to user
    if (order.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: { order }
    });

  } catch (error) {
    logger.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving order'
    });
  }
});

/**
 * @swagger
 * /orders/{id}/cancel:
 *   post:
 *     summary: Cancel an order
 *     tags: [Orders]
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
 *         description: Order cancelled successfully
 *       400:
 *         description: Order cannot be cancelled
 *       404:
 *         description: Order not found
 */
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const userId = req.user._id;

    const order = await cache.get(`order:${orderId}`);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Verify order belongs to user
    if (order.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if order can be cancelled
    if (['out_for_delivery', 'delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: 'Order cannot be cancelled at this stage'
      });
    }

    // Update order status
    order.status = 'cancelled';
    order.trackingUpdates.push({
      status: 'cancelled',
      timestamp: new Date(),
      message: 'Order cancelled by customer'
    });

    // Save updated order
    await cache.set(`order:${orderId}`, order, 24 * 60 * 60);

    logger.info(`Order cancelled: ${orderId} by user: ${userId}`);

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: { order }
    });

  } catch (error) {
    logger.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error cancelling order'
    });
  }
});

module.exports = router;
