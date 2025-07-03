/**
 * Team-Levels helper (dual-mode) – Functions v2
 * ─────────────────────────────────────────────
 *  • Call with { userId }            → summary of six levels (with totalDeposit, totalBuyingProfit, investedAmount)
 *  • Call with { userId, level: 3 }  → array of users in Level-3
 *  • Pure read-only (no writes)
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions }   = require('firebase-functions/v2/options');
const admin                  = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ memory: '512MB', timeoutSeconds: 120 });

const REQUIRED_ACTIVE = /** @type {const} */ ([0, 2, 4, 6, 8, 10, 12, 14]);
const BATCH_SIZE      = 30;

exports.getTeamLevels = onCall(async (req) => {
  try {
    const userId         = req.data?.userId;
    const levelRequested = Number(req.data?.level || 0);   // 0 ⇒ summary-mode

    if (!userId) throw new HttpsError('invalid-argument', 'userId required');
    if (levelRequested && (levelRequested < 1 || levelRequested > 6)) {
      throw new HttpsError('invalid-argument', 'level must be 1-6');
    }

    // ─── Gather first generation ───────────────────────────────
    const unlockProcessed = new Set([userId]);
    const treeProcessed   = new Set([userId]);
    let currGenUsers      = await fetchReferrals([userId], unlockProcessed);
    const firstGenStats   = await getLevelStats(currGenUsers);

    // ─── If specific level requested ────────────────────────────
    if (levelRequested) {
      for (let l = 2; l <= levelRequested; l++) {
        currGenUsers = await fetchReferrals(currGenUsers, treeProcessed);
      }
      const userInfo = await fetchUserDocs(currGenUsers);
      return { level: levelRequested, users: userInfo };
    }

    // ─── Build six-level summary ───────────────────────────────
    const teamLevels = {};
    for (let level = 1; level <= 6; level++) {
      const stats = await getLevelStats(currGenUsers);

      // ►► Compute investedAmount for this level
      let investedAmount = 0;
      for (let i = 0; i < currGenUsers.length; i += BATCH_SIZE) {
        const batch = currGenUsers.slice(i, i + BATCH_SIZE);
        const snapPlans = await db.collection('userPlans')
          .where('user_id', 'in', batch)
          .where('PlanStatus', '==', 'active')
          .get();
        snapPlans.forEach(doc => {
          const amt = Number(doc.data().invested_amount || 0);
          investedAmount += amt;
        });
      }

      const unlocked =
        level === 1 ||
        (firstGenStats.activeUsers || 0) >= REQUIRED_ACTIVE[level - 1];

      teamLevels[level] = {
        totalUsers:        stats.totalUsers,
        activeUsers:       stats.activeUsers,
        inactiveUsers:     stats.inactiveUsers,
        totalDeposit:      stats.totalDeposit,
        totalBuyingProfit: stats.totalBuyingProfit,
        investedAmount,                    // ← NEW
        levelUnlocked:     unlocked,
      };

      // advance to next generation
      currGenUsers = await fetchReferrals(currGenUsers, treeProcessed);
    }

    return teamLevels;

  } catch (e) {
    console.error('🔥 getTeamLevels failed:', e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message || 'Unknown error');
  }
});

/* ───────────────────────── Helpers ─────────────────────────── */

/**
 * Fetch direct referrals of the given userIds, excluding already processed ones.
 */
async function fetchReferrals(userIds, processed) {
  if (!userIds.length) return [];
  const refs = [];
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batchIds = userIds.slice(i, i + BATCH_SIZE);
    const snap = await db.collection('users')
      .where('referralCode', 'in', batchIds)
      .get();
    snap.forEach(doc => {
      const uid = doc.data().id || doc.id;
      if (!processed.has(uid)) {
        processed.add(uid);
        refs.push(uid);
      }
    });
  }
  return refs;
}

/**
 * Fetch full user docs for display (batched).
 */
async function fetchUserDocs(userIds) {
  if (!userIds.length) return [];
  const results = [];
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const snap = await db.collection('users')
      .where('id', 'in', userIds.slice(i, i + BATCH_SIZE))
      .get();
    snap.forEach(doc => {
      const d = doc.data();
      results.push({
        userId: d.id     || doc.id,
        name:   d.name   || '',
        status: d.status || 'inactive'
      });
    });
  }
  return results;
}

/**
 * Compute basic stats for a generation: totalUsers, activeUsers, inactiveUsers,
 * totalDeposit, totalBuyingProfit.
 */
async function getLevelStats(userIds) {
  let active       = 0;
  let inactive     = 0;
  let totalDeposit = 0;
  let totalBP      = 0;

  if (!userIds.length) {
    return {
      totalUsers: 0,
      activeUsers: 0,
      inactiveUsers: 0,
      totalDeposit: 0,
      totalBuyingProfit: 0
    };
  }

  // 1) Count active vs inactive
  const entries = [];
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const snap = await db.collection('users')
      .where('id', 'in', userIds.slice(i, i + BATCH_SIZE))
      .get();
    snap.forEach(doc => {
      const d    = doc.data();
      const uid  = d.id || doc.id;
      const isActive = (d.status || 'active') === 'active';
      isActive ? active++ : inactive++;
      entries.push({ uid, isActive });
    });
  }

  // 2) Sum deposits and team buying profit
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batchUids = entries.slice(i, i + BATCH_SIZE).map(e => e.uid);
    const snapAcc   = await db.collection('accounts')
      .where('user_id', 'in', batchUids)
      .get();
    snapAcc.forEach(doc => {
      const d   = doc.data();
      const uid = d.user_id;
      const entry = entries.find(e => e.uid === uid);
      if (!entry) return;
      const dep = Number((d.investment || {}).total_deposit      || 0);
      const bp  = Number((d.earnings    || {}).buying_profit_team || 0);
      totalDeposit += dep;
      if (entry.isActive) totalBP += bp;
    });
  }

  return {
    totalUsers:        active + inactive,
    activeUsers:       active,
    inactiveUsers:     inactive,
    totalDeposit,
    totalBuyingProfit: totalBP
  };
}
