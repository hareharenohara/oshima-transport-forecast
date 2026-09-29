import test from "node:test";
import assert from "node:assert/strict";
import { notificationEventKeys, parsePreferences, parseSubscription } from "../src/notifications/push.js";

test("validates web push subscriptions without exposing or changing their keys", () => {
  const subscription = parseSubscription({ endpoint: "https://push.example.test/id", keys: { p256dh: "public", auth: "secret" } });
  assert.equal(subscription.endpoint, "https://push.example.test/id");
  assert.equal(subscription.keys.auth, "secret");
  assert.throws(() => parseSubscription({ endpoint: "http://push.example.test/id", keys: { p256dh: "x", auth: "y" } }), /HTTPS/);
});

test("normalizes notification preferences to supported values", () => {
  assert.deepEqual(parsePreferences({ routeGroup: "tokyo", probabilityThreshold: 50, changeThreshold: 20, notifyPortChange: false }), {
    routeGroup: "tokyo", probabilityThreshold: 50, changeThreshold: 20,
    notifyRiskTransition: true, notifyPortChange: false, notifyOfficialUpdate: true
  });
  assert.equal(parsePreferences({ probabilityThreshold: 40 }).probabilityThreshold, null);
});

test("detects configured changes without inventing notification conditions", () => {
  const keys = notificationEventKeys(28, 65, "岡田", "元町", { probabilityThreshold: 50, changeThreshold: 20, notifyRiskTransition: true, notifyPortChange: true });
  assert.deepEqual(keys, ["below-50", "change-20", "risk-transition", "port-岡田"]);
  assert.deepEqual(notificationEventKeys(70, 72, "岡田", "岡田", { probabilityThreshold: 50, changeThreshold: 20, notifyRiskTransition: true, notifyPortChange: true }), []);
});
