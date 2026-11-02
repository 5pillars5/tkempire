'use strict';

module.exports = function privatePortfolio(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'method_not_allowed' });
  }
  return res.status(403).json({
    status: 'PRIVATE_PORTFOLIO',
    message: 'Private portfolio information is not a public endpoint.',
  });
};
