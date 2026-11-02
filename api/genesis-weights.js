'use strict';

module.exports = function privateWeights(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'method_not_allowed' });
  }
  return res.status(403).json({
    status: 'PRIVATE_RESEARCH',
    message: 'Raw Genesis indicator weights are not public.',
  });
};
