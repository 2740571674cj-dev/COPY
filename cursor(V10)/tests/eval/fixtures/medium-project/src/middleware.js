function authMiddleware(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
module.exports = { authMiddleware };
