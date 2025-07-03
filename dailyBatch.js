/**
 *  dailyBatchJob  – ROI + Team Rewards + Transaction Logs  (PKT version)
 *  ─────────────────────────────────────────────────────────────────────
 *  • Phase-1  : Collect ROI / refund  +  Auto-Reinvest renewal
 *  • Phase-1b : Credit ROI / refund   → roiTransactions
 *  • Phase-1c : Write “Plan Bought”   → plansTransactions  (+ FCM)
 *  • Phase-2  : Credit team-level rewards → teamTransactions
 *
 *  Runs every day at 06:55  Asia/Karachi
 */

import { onSchedule }       from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import admin                from 'firebase-admin';

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ memory: '4GiB', timeoutSeconds: 540 });

/* ─────────────── Debug / Trace flags ─────────────── */
const WATCH_UID = null;  // e.g. 'U8318' or null to disable tracing
const LOG_PLAN  = true;
const LOG_ACC   = true;

/* ─────────────── Constants ─────────────── */
const PLAN_WRITE_LIMIT = 450;
const PLAN_PAGE_SIZE   = 5000;
const USER_PAGE_SIZE   = 5000;
const IN_QUERY_BATCH   = 30;
const REQUIRED_ACTIVE  = [0, 2, 4, 6, 8, 10, 12, 14];  // unlock thresholds for L2-L8

const F = {              // Firestore field names (match Kotlin TxnConstants)
  ID          : 'transactionId',
  USER_ID     : 'userId',
  AMOUNT      : 'amount',
  TYPE        : 'type',
  STATUS      : 'status',
  ADDRESS     : 'address',
  BAL_UPDATED : 'balanceUpdated',
  TIMESTAMP   : 'timestamp',
  PLAN_NAME   : 'planName'
};

/* ─────────────── Helper functions ─────────────── */
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth()    === b.getMonth()    &&
  a.getDate()     === b.getDate();

const toDateOnly = dt =>
  new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());

/** Today at local PKT midnight (using server clock) */
const todayLocal = () => {
  const now = admin.firestore.Timestamp.now().toDate();  // server UTC→local
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

/* ╔══════════════════════════════════════════════╗
   ║           MAIN  SCHEDULED FUNCTION           ║
   ╚══════════════════════════════════════════════╝ */
export const dailyBatchJob = onSchedule(
  { schedule: '55 6 * * *', timeZone: 'Asia/Karachi' },
  async () => {

  const jobStart = Date.now();
  const today    = todayLocal();
  console.log(`🗓️  dailyBatchJob – ${today.toISOString().slice(0, 10)} (PKT)`);

  /* =====================================================
     PHASE-1 — scan active plans, collect ROI / refund,
                **and auto-renew plans with autoInvest**
     ===================================================== */
  const userAgg   = new Map();          // uid → { roi, refund, wrote }
  const renewLog  = [];                 // for auto-reinvest txn / push
  let   cursor    = null,
        pages     = 0,
        planBatch = db.batch(),
        writes    = 0;

  const commitPlans = async () => {
    if (writes) { await planBatch.commit(); planBatch = db.batch(); writes = 0; }
  };

  while (true) {
    let q = db.collection('userPlans')
              .where('PlanStatus', '==', 'active')
              .orderBy(admin.firestore.FieldPath.documentId())
              .limit(PLAN_PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;
    pages++;

    for (const doc of snap.docs) {
      const d   = doc.data();
      const uid = d.user_id;

      if (!userAgg.has(uid)) userAgg.set(uid, { roi: 0, refund: 0, wrote: false });
      const agg = userAgg.get(uid);

      const expiryTs  = d.expiry_date?.toDate?.() ?? new Date(0);
      const expiryDay = toDateOnly(expiryTs);
      const dur       = Number(d.durationDays      || 0);
      const roi       = Number(d.daily_profit      || 0);
      const investAmt = Number(d.invested_amount   || 0);
      const last      = d.lastCollectedDate?.toDate?.();
      const autoInv   = d.autoInvest === true;

      if (WATCH_UID === uid && LOG_PLAN) {
        console.log(`· plan ${doc.id} exp=${expiryDay.toISOString().slice(0,10)} roi=${roi} auto=${autoInv}`);
      }

      /* ────── (A) expiry reached TODAY ────── */
      if (expiryDay <= today) {

        if (autoInv) {
          /* ── AUTO-REINVEST ──
             1) give today’s ROI
             2) roll start_date / expiry_date forward
             3) mark lastCollectedDate today
          */
          agg.roi += roi;

          const newStart  = admin.firestore.Timestamp.fromDate(today);
          const newExpiry = admin.firestore.Timestamp.fromMillis(
                              today.getTime() + dur * 24*60*60*1000);

          planBatch.update(doc.ref, {
            start_date        : newStart,
            expiry_date       : newExpiry,
            lastCollectedDate : newStart         // already credited today
          });

          renewLog.push({
            uid,
            planRef  : doc.ref,
            planName : d.plan_name || d.planName || 'Plan',
            amount   : investAmt
          });

        } else {  /* ── NORMAL EXPIRY ── */
          if (dur === 1) {                  // one-day plan : ROI + refund
            agg.roi    += roi;
            agg.refund += investAmt;
            planBatch.update(doc.ref, {
              PlanStatus        : 'expired',
              lastCollectedDate : admin.firestore.Timestamp.fromDate(today)
            });
          } else {                          // long-term : refund only
            agg.refund += investAmt;
            planBatch.update(doc.ref, { PlanStatus: 'expired' });
          }
        }
        agg.wrote = true;

      /* ────── (B) plan still active, daily ROI ────── */
      } else if (!last || !sameDay(last, today)) {
        agg.roi += roi;
        planBatch.update(doc.ref, {
          lastCollectedDate: admin.firestore.Timestamp.fromDate(today)
        });
        agg.wrote = true;
      }

      if (++writes >= PLAN_WRITE_LIMIT) await commitPlans();
    } // end-for docs
    cursor = snap.docs[snap.docs.length - 1];
  }
  await commitPlans();
  console.log(`✔ Plan scan complete (pages=${pages}, renew=${renewLog.length})`);

  /* =====================================================
     PHASE-1b — credit ROI / refund to user accounts
     (unchanged except for surrounding context)
     ===================================================== */
  let roiUsers = 0;
  for (const [uid, { roi, refund, wrote }] of userAgg) {
    if (roi === 0 && refund === 0 && !wrote) continue;

    await db.runTransaction(async tx => {
      const accSnap = await tx.get(
        db.collection('accounts').where('user_id', '==', uid).limit(1));
      if (accSnap.empty) { console.warn(`· no account ${uid}`); return; }

      const accRef = accSnap.docs[0].ref;
      const acc    = accSnap.docs[0].data();
      const last   = acc.lastProfitCollectedDate?.toDate?.();
      if (last && sameDay(last, today)) return;

      const prevTeam = Number(acc?.earnings?.buying_profit_team || 0);
      tx.update(accRef, { 'earnings.buying_profit_team': 0 });

      if (roi !== 0) tx.update(accRef, {
        'earnings.buying_profit_team' : roi,
        'earnings.buying_profit'      : roi,
        'earnings.daily_profit'       : roi,
        'earnings.current_balance'    : admin.firestore.FieldValue.increment(roi),
        'investment.remaining_balance': admin.firestore.FieldValue.increment(roi)
      });

      const credit = roi + prevTeam;
      if (credit !== 0) tx.update(accRef, {
        'earnings.total_earned'       : admin.firestore.FieldValue.increment(credit),
        'earnings.lifetime_roi_income': admin.firestore.FieldValue.increment(credit)
      });

      if (refund !== 0) tx.update(accRef, {
        'earnings.current_balance'    : admin.firestore.FieldValue.increment(refund),
        'investment.remaining_balance': admin.firestore.FieldValue.increment(refund)
      });

      tx.update(accRef, {
        lastProfitCollectedDate: admin.firestore.Timestamp.fromDate(today)
      });

      /* --- roi / refund transaction rows --- */
      if (roi !== 0) {
        const row = db.collection('roiTransactions').doc();
        tx.set(row, {
          [F.ID]         : row.id,
          [F.USER_ID]    : uid,
          [F.AMOUNT]     : roi,
          [F.TYPE]       : 'roiReward',
          [F.STATUS]     : 'collected',
          [F.ADDRESS]    : 'ROI',
          [F.BAL_UPDATED]: true,
          [F.TIMESTAMP]  : admin.firestore.Timestamp.now()
        });
      }
      if (refund !== 0) {
        const row = db.collection('roiTransactions').doc();
        tx.set(row, {
          [F.ID]         : row.id,
          [F.USER_ID]    : uid,
          [F.AMOUNT]     : refund,
          [F.TYPE]       : 'roiRefund',
          [F.STATUS]     : 'collected',
          [F.ADDRESS]    : 'Capital Return',
          [F.BAL_UPDATED]: true,
          [F.TIMESTAMP]  : admin.firestore.Timestamp.now()
        });
      }
    }).catch(e => console.error(`❌ ROI txn ${uid}`, e));

    roiUsers++; if (roiUsers % 500 === 0) console.log(`   · ROI users ${roiUsers}`);
  }
  console.log(`✔ ROI phase done (${roiUsers} users)`);

  /* =====================================================
     PHASE-1c — write “Plan Bought” rows for auto-reinvest
                 and push FCM notifications
     ===================================================== */
  for (const r of renewLog) {
    try {
      await db.runTransaction(async tx => {
        const txnRef = db.collection('plansTransactions').doc();
        tx.set(txnRef, {
          [F.ID]         : txnRef.id,
          [F.USER_ID]    : r.uid,
          [F.AMOUNT]     : r.amount,
          [F.TYPE]       : 'Plan Bought',
          [F.ADDRESS]    : r.planRef.id,
          [F.STATUS]     : 'bought',
          [F.BAL_UPDATED]: true,
          [F.TIMESTAMP]  : admin.firestore.Timestamp.now(),
          [F.PLAN_NAME]  : r.planName
        });
      });

      /* push-notification */
      const userSnap = await db.collection('users')
                               .where('id', '==', r.uid)
                               .limit(1).get();
      if (!userSnap.empty) {
        const token = userSnap.docs[0].data().deviceToken;
        if (token) {
          await admin.messaging().send({
            token,
            data: {
              title: 'Plan Auto-Reinvested',
              body : `Your ${r.planName} has been renewed automatically.`
            }
          });
        }
      }
    } catch (e) {
      console.error(`❌ auto-renew txn ${r.uid}`, e);
    }
  }
  console.log(`✔ Auto-reinvest phase done (${renewLog.length} plans)`);

  /* =====================================================
     PHASE-2 — Team Rewards (original code, unchanged)
     ===================================================== */

  /* ---------- helper: fetchRefs (same code) ---------- */
  const fetchRefs = async (ids, seen) => {
    if (!ids.length) return [];
    const out = [], batches = [];
    for (let i = 0; i < ids.length; i += IN_QUERY_BATCH)
      batches.push(ids.slice(i, i + IN_QUERY_BATCH));
    const snaps = await Promise.all(
      batches.map(b => db.collection('users').where('referralCode', 'in', b).get()));
    snaps.forEach(s => s.forEach(d => {
      const id = d.data().id || d.id;
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }));
    return out;
  };

  /* ---------- helper: statsFor (same code) ---------- */
  const statsFor = async (uids) => {
    let active = 0, bp = 0;
    if (!uids.length) return { active, bp };
    const ub = [];
    for (let i = 0; i < uids.length; i += IN_QUERY_BATCH)
      ub.push(uids.slice(i, i + IN_QUERY_BATCH));
    const userSnaps = await Promise.all(
      ub.map(b => db.collection('users').where('id', 'in', b).get()));
    const entries = [];
    userSnaps.forEach(s => s.forEach(d => {
      const data = d.data(), uid = data.id || d.id;
      const isAct = (data.status || 'active') === 'active';
      if (isAct) active++; entries.push({ uid, isAct });
    }));

    const ab = [];
    for (let i = 0; i < entries.length; i += IN_QUERY_BATCH)
      ab.push(entries.slice(i, i + IN_QUERY_BATCH).map(e => e.uid));
    const accSnaps = await Promise.all(
      ab.map(b => db.collection('accounts').where('user_id', 'in', b).get()));
    accSnaps.forEach(s => s.forEach(d => {
      const data = d.data(), earn = data.earnings || {};
      if (entries.find(e => e.uid === data.user_id)?.isAct)
        bp += Number(earn.buying_profit_team || 0);
    }));
    return { activeUsers: active, totalBP: bp };
  };

  /* ---------- helper: creditTeam (same code) ---------- */
  const creditTeam = async (uid, level, levelBP) => {
    const pct = [0, 10, 7, 6, 5, 4, 2, 2, 1][level] || 0;
    if (!pct || levelBP <= 0) return;
    const share = (levelBP * pct) / 100;

    const accSnap = await db.collection('accounts')
                            .where('user_id', '==', uid).limit(1).get();
    if (accSnap.empty) return;
    const accRef  = accSnap.docs[0].ref;
    const dateStr = new Date().toISOString().split('T')[0];
    const markRef = db.collection('team_rewards')
                      .doc(uid).collection(dateStr)
                      .doc(`level_${level}`);

    await db.runTransaction(async tx => {
      if ((await tx.get(markRef)).exists) return;  // already rewarded

      tx.update(accRef, {
        'earnings.team_profit'      : admin.firestore.FieldValue.increment(share),
        'earnings.total_earned'     : admin.firestore.FieldValue.increment(share),
        'earnings.current_balance'  : admin.firestore.FieldValue.increment(share),
        'investment.remaining_balance':
          admin.firestore.FieldValue.increment(share),
        'earnings.lifetime_team_income':
          admin.firestore.FieldValue.increment(share),
      });

      const row = db.collection('teamTransactions').doc();
      tx.set(row, {
        transactionId : row.id,
        userId        : uid,
        amount        : share,
        type          : 'teamReward',
        status        : 'received',
        address       : `Team Profit (Level ${level})`,
        balanceUpdated: true,
        timestamp     : admin.firestore.Timestamp.now()
      });
      tx.set(markRef, { rewarded: true, ts: admin.firestore.FieldValue.serverTimestamp() });
    })
    .then(async () => {
      if (uid === WATCH_UID && LOG_ACC)
        console.log(`✅ Team L${level} = ${share}`);

      const userSnap = await db.collection('users')
                               .where('id', '==', uid).limit(1).get();
      if (!userSnap.empty) {
        const token = userSnap.docs[0].data().deviceToken;
        if (token) {
          await admin.messaging().send({
            token,
            data: {
              title: 'Team Reward Credited',
              body : `You received $${share} team reward (Level ${level})!`
            }
          });
        }
      }
    })
    .catch(e => console.error(`❌ team txn ${uid}`, e));
  };

  /* ---------- iterate all users ---------- */
  let userCursor = null, teamUsers = 0;
  while (true) {
    let uq = db.collection('users')
               .orderBy(admin.firestore.FieldPath.documentId())
               .limit(USER_PAGE_SIZE);
    if (userCursor) uq = uq.startAfter(userCursor);

    const snap = await uq.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const uid = doc.data().id || doc.id;
      try {
        const unlock  = new Set([uid]),
              visited = new Set([uid]);
        const first   = await fetchRefs([uid], unlock);
        const firstSt = await statsFor(first);

        let cur = first;
        for (let lvl = 1; lvl <= 6; lvl++) {
          const st = await statsFor(cur);
          const unlocked = lvl === 1 ||
                           (firstSt.activeUsers || 0) >= REQUIRED_ACTIVE[lvl - 1];
          if (unlocked && st.totalBP > 0)
            await creditTeam(uid, lvl, st.totalBP);
          cur = await fetchRefs(cur, visited);
        }
      } catch (e) { console.error(`⚠️ team calc ${uid}`, e); }
      teamUsers++; if (teamUsers % 500 === 0)
        console.log(`   · team users ${teamUsers}`);
    }
    userCursor = snap.docs[snap.docs.length - 1];
  }
  console.log(`✔ Team reward phase finished (${teamUsers} users)`);
  console.log(`🏁 dailyBatchJob finished in ${(Date.now() - jobStart) / 1000}s`);
});