'use strict';

const functions = require('firebase-functions/v2');
const admin     = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

/* ───────────────────────── CONFIG ───────────────────────── */
functions.setGlobalOptions({
  region:          'us-central1',
  memory:          '4GiB',
  timeoutSeconds:  540
});

const PAGE_SIZE          = 5_000;
const WHERE_IN_LIMIT     = 30;
const TASK_PARALLELISM   = 40;
const QUERY_PARALLELISM  = 10;
const HARD_TIMEOUT_MS    = 8 * 60 * 1e3;

/* ───────────────────────── HELPERS ──────────────────────── */
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function sumDeposits(ids) {
  if (!ids.length) return 0;

  let total = 0;
  for (const batch of chunk(ids, WHERE_IN_LIMIT)) {
    const snap = await db.collection('accounts')
      .where('user_id', 'in', batch)
      .select('investment.total_deposit')
      .get();

    snap.forEach(doc => {
      const inv = doc.get('investment') || {};
      total += Number(inv.total_deposit || 0);
    });
  }
  return total;
}

async function walkReferrals(rootUid) {
  const MAX_NODES = 10_000;
  const direct    = [];
  const indirect  = [];
  const seen      = new Set([rootUid]);
  let   current   = [rootUid];

  for (let lvl = 1; lvl <= 6 && current.length; lvl++) {
    const batches = chunk(current, WHERE_IN_LIMIT);
    const next    = [];

    for (let i = 0; i < batches.length; i += QUERY_PARALLELISM) {
      const group = batches.slice(i, i + QUERY_PARALLELISM);

      const snaps = await Promise.all(
        group.map(b =>
          db.collection('users')
            .where('referralCode', 'in', b)
            .select('id')
            .get()
        )
      );

      snaps.forEach(snap => {
        snap.forEach(doc => {
          const id = doc.get('id');
          if (id && !seen.has(id)) {
            seen.add(id);
            next.push(id);
            (lvl === 1 ? direct : indirect).push(id);
          }
        });
      });
    }

    if ((direct.length + indirect.length) > MAX_NODES) break;
    current = next;
  }

  return { directIds: direct, indirectIds: indirect };
}

/* ───────────────────── processUser ─────────────────────── */
async function processUser(userSnap) {
  const uid = userSnap.get('id');
  if (!uid) {
    functions.logger.warn('User doc missing id', { doc: userSnap.id });
    return;
  }

  try {
    const { directIds, indirectIds } = await walkReferrals(uid);

    const total    = await sumDeposits([...directIds, ...indirectIds]);
    const direct   = await sumDeposits(directIds);
    const indirect = total - direct;

    /* ALWAYS write a metrics doc (even if both zero) */
    await db.doc(`business_metrics/${uid}`).set(
      { direct, indirect, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

  } catch (err) {
    functions.logger.error(`processUser ${uid} failed`, err);
  }
}

/* ────────────────── MAIN AGGREGATION JOB ───────────────── */
async function runAggregationJob() {
  const start = Date.now();
  let lastDoc = null, page = 0, totalUsers = 0;

  const tasks = [];
  const flush = async () => {
    if (!tasks.length) return;
    const now = tasks.splice(0, tasks.length);
    await Promise.all(now);
  };

  try {
    while (true) {
      if (Date.now() - start > HARD_TIMEOUT_MS) {
        functions.logger.warn('Early exit – nearing timeout');
        break;
      }

      page++;
      let q = db.collection('users').orderBy('id').limit(PAGE_SIZE);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      functions.logger.info(`Page ${page}`, {
        usersInPage: snap.size,
        cumulative:  totalUsers
      });

      for (const usr of snap.docs) {
        if (tasks.length >= TASK_PARALLELISM) await flush();
        tasks.push(processUser(usr));
      }

      totalUsers += snap.size;
      lastDoc     = snap.docs[snap.docs.length - 1];

      if (page % 5 === 0) await flush();
      if (snap.size < PAGE_SIZE) break;
    }
  } catch (err) {
    functions.logger.error('JOB FATAL ERROR', err);
    throw err;
  } finally {
    await flush();
    functions.logger.info('Aggregation END', {
      usersProcessed: totalUsers,
      durationMs:     Date.now() - start
    });
  }
}

/* ────────────────── SCHEDULER TRIGGER ─────────────────── */
exports.aggregateBusinessEvery10Min = functions
  .scheduler.onSchedule('*/10 * * * *', runAggregationJob);