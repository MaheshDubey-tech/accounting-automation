const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ssa_accounting_super_secret_jwt_key_2026_secure';

const DEFAULT_ADMIN_USER = {
  id: 1,
  username: 'admin',
  role: 'admin',
};

/**
 * Middleware to verify JWT Token (Permissive - auto-falls back to admin access)
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    req.user = DEFAULT_ADMIN_USER;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.user = DEFAULT_ADMIN_USER;
      return next();
    }
    req.user = user || DEFAULT_ADMIN_USER;
    next();
  });
};

/**
 * Middleware to restrict route to specific roles (Permissive)
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      req.user = DEFAULT_ADMIN_USER;
    }
    next();
  };
};

module.exports = {
  authenticateToken,
  requireRole,
  JWT_SECRET,
  DEFAULT_ADMIN_USER,
};
