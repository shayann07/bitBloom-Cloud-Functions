# bitBloom Cloud Functions

Firebase Cloud Functions source for BitBloom's referral metrics, daily plan processing, wallet credits, and team reporting.

## Overview

This repository contains three JavaScript function modules that operate on BitBloom data in Cloud Firestore. Two functions run on schedules to aggregate referral business and process daily plan earnings. A callable function returns six-level referral-team summaries or the members of a requested level.

The repository is a source snapshot, not a complete standalone Firebase Functions project. It does not include a package manifest, Firebase project configuration, a shared entry point, tests, or deployment automation.

## Functions

### `aggregateBusinessEvery10Min`

- Runs every 10 minutes in `us-central1`.
- Pages through users and follows each referral tree up to six levels.
- Separates direct and indirect referrals.
- Sums `investment.total_deposit` values from matching account records.
- Merges direct, indirect, and update timestamp fields into `business_metrics/{userId}`.

### `dailyBatchJob`

- Runs daily at 06:55 in the `Asia/Karachi` time zone.
- Scans active user plans and calculates due daily profit or principal refunds.
- Advances auto-invest plans and records renewed plan transactions.
- Updates account earning and investment balances.
- Creates ROI, plan, and team transaction records.
- Calculates referral rewards across eligible team levels.
- Sends Firebase Cloud Messaging notifications for plan renewals and team rewards when a token is available.

### `getTeamLevels`

- Exposes a callable Functions v2 endpoint.
- Accepts a `userId` and optionally a level from 1 through 6.
- Returns a six-level summary with user counts, activity counts, deposits, buying profit, invested amount, and unlock state.
- Returns member details for one requested level.
- Reads from the `users`, `accounts`, and `userPlans` collections without writing data.

## Tech Stack

- JavaScript
- Node.js module APIs
- Firebase Cloud Functions v2
- Firebase Admin SDK
- Cloud Firestore
- Firebase Cloud Messaging
- Cloud Scheduler-backed scheduled functions

## Data Flow

The scheduled modules query Firestore in pages and batches to stay within query and write limits. Referral relationships are resolved through each user's referral code, account documents supply deposit and balance data, and plan documents drive the daily ROI and renewal workflow. Results are written back to metrics, account, reward, and transaction collections.

## Repository Structure

```text
.
|-- aggregatebusinessevery10min.js  # Referral-business aggregation job
|-- dailyBatch.js                   # Daily plan, wallet, and team-reward processing
|-- getTeamLevels.js                # Callable referral-team query
`-- README.md
```

## Setup and Deployment

These files cannot be installed or deployed directly from this repository in its current form. A Firebase Functions project would need to provide:

- a compatible Node.js runtime and package manifest
- `firebase-functions` and `firebase-admin` dependencies
- a Firebase project configuration and function entry point
- the required Firestore collections, fields, indexes, and security controls
- Cloud Scheduler and Firebase Cloud Messaging prerequisites

After those pieces are supplied, the modules can be integrated into that project and validated with the Firebase Emulator Suite before deployment.

## Current Status and Limitations

- Deployment status cannot be verified from this repository.
- No automated tests or emulator configuration are included.
- The callable function validates input shape but does not check caller authentication or authorization.
- Each module initializes the Admin SDK independently, so integration into one entry point may require shared initialization.
- The code depends on a specific, undocumented Firestore schema and composite indexes.
- `dailyBatch.js` uses ECMAScript modules while the other files use CommonJS; the host project's module configuration must account for both styles.
- Failure recovery, idempotency guarantees, monitoring, and operational runbooks are not documented.
