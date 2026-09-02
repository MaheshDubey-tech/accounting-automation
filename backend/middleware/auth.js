const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ssa_accounting_super_secret_jwt_key_2026_secure';

/**
 * Middleware to verify JWT Token
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No authentication token provided.',
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired authentication token.',
      });
    }
    req.user = user;
    next();
  });
};

/**
 * Middleware to restrict route to specific roles
 * @param  {...string} roles - e.g. 'admin', 'accountant'
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Requires one of following roles: ${roles.join(', ')}`,
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  requireRole,
  JWT_SECRET,
};
