const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');

/**
 * Check if initial setup is needed (when no users exist)
 */
const checkSetupStatus = async (req, res, next) => {
  try {
    const userCountRes = await query('SELECT COUNT(*) as count FROM users');
    const count = parseInt(userCountRes.rows[0].count, 10);
    return res.json({
      success: true,
      needsSetup: count === 0,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Setup Initial Admin account (Only allowed if users table is empty)
 */
const setupAdmin = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const userCountRes = await query('SELECT COUNT(*) as count FROM users');
    const count = parseInt(userCountRes.rows[0].count, 10);
    if (count > 0) {
      return res.status(400).json({ success: false, message: 'Admin setup already completed. Please log in.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const insertRes = await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id, username, role, created_at`,
      [username.trim().toLowerCase(), passwordHash]
    );

    const user = insertRes.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '7d',
    });

    return res.status(201).json({
      success: true,
      message: 'Admin account created successfully.',
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User Login
 */
const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const userRes = await query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '7d',
    });

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create new user (Admin only)
 */
const registerUser = async (req, res, next) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const userRole = role === 'admin' ? 'admin' : 'accountant';
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const insertRes = await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at`,
      [username.trim().toLowerCase(), passwordHash, userRole]
    );

    return res.status(201).json({
      success: true,
      message: 'User created successfully.',
      user: insertRes.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current authenticated user
 */
const getMe = async (req, res, next) => {
  try {
    const userRes = await query('SELECT id, username, role, created_at FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    return res.json({ success: true, user: userRes.rows[0] });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  checkSetupStatus,
  setupAdmin,
  login,
  registerUser,
  getMe,
};
