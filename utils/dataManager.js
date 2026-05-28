/**
 * Data Management - Users, Reports, Promotions
 */

// In-memory storage for active users (can be migrated to DB)
const activeUsers = new Map(); // Map<chatId, {name, username, lastSeen, platform}>

// In-memory storage for reports with image analysis
const reports = new Map(); // Map<reportId, {chatId, timestamp, type, imageBase64, analysis, status}>

// In-memory promotions
const promotions = [];

/**
 * Register an active user
 */
function registerUser(chatId, userData = {}) {
  const id = String(chatId);
  const user = activeUsers.get(id) || {};
  
  activeUsers.set(id, {
    chatId: id,
    name: userData.name || user.name || 'Usuario',
    username: userData.username || user.username || '',
    platform: userData.platform || user.platform || 'telegram',
    lastSeen: new Date(),
    firstSeen: user.firstSeen || new Date()
  });
  
  return activeUsers.get(id);
}

/**
 * Get all active users
 */
function getAllUsers() {
  return Array.from(activeUsers.values());
}

/**
 * Get user count
 */
function getUserCount() {
  return activeUsers.size;
}

/**
 * Create a report from an image analysis
 */
function createReport(chatId, analysisResult, imageBase64) {
  const reportId = `RPT-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  const report = {
    reportId,
    chatId: String(chatId),
    timestamp: new Date(),
    type: 'payment_receipt',
    imageBase64: imageBase64 ? imageBase64.substring(0, 50000) : null, // Limit size
    analysis: analysisResult,
    status: 'pending', // pending, processed, contacted
    notified: false
  };
  
  reports.set(reportId, report);
  return report;
}

/**
 * Get all pending reports
 */
function getPendingReports() {
  return Array.from(reports.values())
    .filter(r => r.status === 'pending')
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Mark report as contacted
 */
function markReportAsContacted(reportId) {
  const report = reports.get(reportId);
  if (report) {
    report.status = 'contacted';
    report.notified = true;
  }
  return report;
}

/**
 * Add a promotion
 */
function addPromotion(promotionData) {
  const promotion = {
    id: `PROMO-${Date.now()}`,
    ...promotionData,
    createdAt: new Date()
  };
  promotions.push(promotion);
  return promotion;
}

/**
 * Get latest promotion
 */
function getLatestPromotion() {
  return promotions.length > 0 ? promotions[promotions.length - 1] : null;
}

/**
 * Get all promotions
 */
function getAllPromotions() {
  return promotions;
}

module.exports = {
  registerUser,
  getAllUsers,
  getUserCount,
  createReport,
  getPendingReports,
  markReportAsContacted,
  addPromotion,
  getLatestPromotion,
  getAllPromotions,
  activeUsers,
  reports,
  promotions
};
