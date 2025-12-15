const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

require('dotenv').config();

function initFirebase() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be valid JSON');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/devices/register', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const {
      user_id,
      role,
      fcm_token,
      is_available,
      latitude,
      longitude,
    } = req.body || {};

    if (!user_id || !role || !fcm_token) {
      return res.status(400).json({ error: 'user_id, role, fcm_token are required' });
    }

    const docId = `${role}_${user_id}`;
    const now = Date.now();

    await db.collection('devices').doc(docId).set(
      {
        userId: Number(user_id),
        role: String(role),
        fcmToken: String(fcm_token),
        isAvailable: Boolean(is_available),
        latitude: typeof latitude === 'number' ? latitude : null,
        longitude: typeof longitude === 'number' ? longitude : null,
        lastSeenAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/volunteers/availability', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const { volunteer_id, is_available, latitude, longitude, fcm_token } = req.body || {};
    if (!volunteer_id) {
      return res.status(400).json({ error: 'volunteer_id is required' });
    }

    const docId = `volunteer_${volunteer_id}`;
    const now = Date.now();

    const patch = {
      userId: Number(volunteer_id),
      role: 'volunteer',
      isAvailable: Boolean(is_available),
      lastSeenAt: now,
      updatedAt: now,
    };

    if (typeof latitude === 'number') patch.latitude = latitude;
    if (typeof longitude === 'number') patch.longitude = longitude;
    if (typeof fcm_token === 'string' && fcm_token.trim()) patch.fcmToken = fcm_token.trim();

    await db.collection('devices').doc(docId).set(patch, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/emergencies', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const { elderly_id, latitude, longitude, timestamp, status } = req.body || {};
    if (!elderly_id || typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'elderly_id, latitude, longitude are required' });
    }

    const emergencyId = Number(timestamp) && Number(timestamp) > 0 ? Number(timestamp) : Date.now();
    const now = Date.now();

    const emergencyDoc = {
      id: emergencyId,
      elderlyId: Number(elderly_id),
      latitude,
      longitude,
      status: String(status || 'active'),
      volunteerId: null,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('emergencies').doc(String(emergencyId)).set(emergencyDoc, { merge: false });

    await db.collection('audit_logs').add({
      emergencyId,
      action: 'created',
      actorRole: 'elderly',
      actorUserId: Number(elderly_id),
      createdAt: now,
    });

    const devicesSnap = await db
      .collection('devices')
      .where('role', '==', 'volunteer')
      .where('isAvailable', '==', true)
      .limit(200)
      .get();

    const volunteers = [];
    devicesSnap.forEach((doc) => {
      const d = doc.data();
      const lastSeenAt = typeof d.lastSeenAt === 'number' ? d.lastSeenAt : 0;
      const maxAgeMs = 10 * 60 * 1000;
      if (!d.fcmToken) return;
      if (now - lastSeenAt > maxAgeMs) return;

      let distanceKm = null;
      if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
        distanceKm = haversineKm(latitude, longitude, d.latitude, d.longitude);
      }

      volunteers.push({
        userId: d.userId,
        fcmToken: d.fcmToken,
        distanceKm,
      });
    });

    volunteers.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    const top = volunteers.slice(0, 10);
    const tokens = top.map((v) => v.fcmToken).filter(Boolean);

    if (tokens.length) {
      await admin.messaging().sendEachForMulticast({
        tokens,
        data: {
          type: 'emergency_new',
          emergency_id: String(emergencyId),
          elderly_id: String(elderly_id),
          latitude: String(latitude),
          longitude: String(longitude),
        },
      });

      await db.collection('audit_logs').add({
        emergencyId,
        action: 'pushed_to_volunteers',
        actorRole: 'system',
        actorUserId: null,
        notifiedVolunteerUserIds: top.map((v) => v.userId).filter((x) => typeof x === 'number'),
        createdAt: Date.now(),
      });
    }

    res.status(201).json({ id: emergencyId });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.get('/api/emergencies/active', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const volunteerId = req.query.volunteer_id ? Number(req.query.volunteer_id) : null;

    const activeSnap = await db.collection('emergencies').where('status', '==', 'active').limit(200).get();
    const emergencies = [];
    activeSnap.forEach((doc) => emergencies.push(doc.data()));

    if (volunteerId) {
      const acceptedSnap = await db
        .collection('emergencies')
        .where('status', '==', 'accepted')
        .where('volunteerId', '==', volunteerId)
        .limit(200)
        .get();
      acceptedSnap.forEach((doc) => emergencies.push(doc.data()));
    }

    const out = emergencies.map((e) => ({
      id: Number(e.id),
      elderly_id: Number(e.elderlyId),
      latitude: Number(e.latitude),
      longitude: Number(e.longitude),
      timestamp: Number(e.createdAt || e.id),
      status: String(e.status),
      volunteer_id: e.volunteerId == null ? null : Number(e.volunteerId),
    }));

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.put('/api/emergencies/:id', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const emergencyId = Number(req.params.id);
    if (!emergencyId) {
      return res.status(400).json({ error: 'Invalid emergency id' });
    }

    const { status, volunteer_id } = req.body || {};
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const ref = db.collection('emergencies').doc(String(emergencyId));

    if (String(status) === 'accepted') {
      if (!volunteer_id) {
        return res.status(400).json({ error: 'volunteer_id is required for accepted' });
      }

      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) {
            throw new Error('NOT_FOUND');
          }
          const current = snap.data();
          if (current.status !== 'active') {
            const err = new Error('ALREADY_TAKEN');
            err.code = 'ALREADY_TAKEN';
            throw err;
          }

          tx.update(ref, {
            status: 'accepted',
            volunteerId: Number(volunteer_id),
            acceptedAt: Date.now(),
            updatedAt: Date.now(),
          });
        });
      } catch (err) {
        if (err.message === 'NOT_FOUND') {
          return res.status(404).json({ error: 'Emergency not found' });
        }
        if (err.code === 'ALREADY_TAKEN' || err.message === 'ALREADY_TAKEN') {
          return res.status(409).json({ error: 'Emergency already accepted' });
        }
        throw err;
      }

      await db.collection('audit_logs').add({
        emergencyId,
        action: 'accepted',
        actorRole: 'volunteer',
        actorUserId: Number(volunteer_id),
        createdAt: Date.now(),
      });

      const emergency = (await ref.get()).data();
      if (emergency && emergency.elderlyId != null) {
        const elderlyDevice = await db.collection('devices').doc(`elderly_${emergency.elderlyId}`).get();
        const elderlyToken = elderlyDevice.exists ? elderlyDevice.data().fcmToken : null;
        if (elderlyToken) {
          await admin.messaging().send({
            token: elderlyToken,
            data: {
              type: 'emergency_accepted',
              emergency_id: String(emergencyId),
              volunteer_id: String(volunteer_id),
            },
          });
        }
      }

      return res.json({ ok: true });
    }

    const patch = {
      status: String(status),
      updatedAt: Date.now(),
    };

    if (typeof volunteer_id !== 'undefined') {
      patch.volunteerId = volunteer_id == null ? null : Number(volunteer_id);
    }

    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Emergency not found' });
    }

    await ref.update(patch);

    await db.collection('audit_logs').add({
      emergencyId,
      action: `status_${String(status)}`,
      actorRole: 'system',
      actorUserId: null,
      createdAt: Date.now(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.post('/api/admin/cleanup', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();

    const token = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const days = req.query.days ? Number(req.query.days) : (process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 30);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const snap = await db.collection('emergencies').where('createdAt', '<', cutoff).limit(200).get();
    const batch = db.batch();
    let count = 0;
    snap.forEach((doc) => {
      batch.delete(doc.ref);
      count += 1;
    });

    if (count) {
      await batch.commit();
    }

    res.json({ ok: true, deleted: count, days });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port);
}

module.exports = app;
