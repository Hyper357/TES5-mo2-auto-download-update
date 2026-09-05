'use strict';

const path = require('path');
const { loadJson, saveJson } = require('./fs-json');

const POLICY_VERSION = 1;

function defaultPolicyFile(rootDir) {
  return process.env.MO2_VARIANT_POLICIES || path.join(rootDir, '.runtime', 'state', 'variant-policies.json');
}

function emptyDoc() {
  return { version: POLICY_VERSION, updatedAt: null, policies: {} };
}

function loadVariantPolicies(file) {
  const doc = loadJson(file, emptyDoc());
  if (!doc || typeof doc !== 'object') return emptyDoc();
  return {
    version: Number(doc.version || POLICY_VERSION),
    updatedAt: doc.updatedAt || null,
    policies: doc.policies && typeof doc.policies === 'object' ? doc.policies : {},
  };
}

function getVariantPolicy(doc, modId) {
  const p = doc?.policies?.[String(modId)];
  if (!p || p.status === 'DISABLED') return null;
  return p;
}

function resolveVariantPolicy(review, policy) {
  if (!policy) return { status: 'NONE', option: null, code: null };
  const branch = String(policy.branchKey || '').trim();
  if (!branch || branch === 'GENERIC') {
    return { status: 'UNUSABLE', option: null, code: 'VARIANT_POLICY_UNSTABLE' };
  }
  const matches = (review?.options || []).filter(o => String(o.branchKey || '') === branch);
  if (matches.length === 1) return { status: 'MATCHED', option: matches[0], code: null };
  if (matches.length === 0) return { status: 'CHANGED', option: null, code: 'VARIANT_POLICY_CHANGED' };
  return { status: 'AMBIGUOUS', option: null, code: 'VARIANT_POLICY_AMBIGUOUS' };
}

function rememberVariantPolicy(file, selection, extra = {}) {
  const modId = String(selection?.modId || '').trim();
  const branchKey = String(selection?.branchKey || '').trim();
  if (!modId || !branchKey || branchKey === 'GENERIC') {
    return { saved: false, reason: 'UNSTABLE_BRANCH_KEY' };
  }

  const doc = loadVariantPolicies(file);
  const now = new Date().toISOString();
  const previous = doc.policies[modId] || null;
  doc.policies[modId] = {
    modId,
    status: 'ACTIVE',
    branchKey,
    tags: Array.isArray(selection.tags) ? selection.tags : [],
    lastConfirmedFileId: String(selection.fileId || ''),
    lastConfirmedVersion: selection.version || '',
    lastConfirmedName: selection.name || '',
    source: extra.source || 'USER_REVIEW',
    confirmedAt: now,
    previousBranchKey: previous?.branchKey && previous.branchKey !== branchKey ? previous.branchKey : undefined,
  };
  doc.version = POLICY_VERSION;
  doc.updatedAt = now;
  saveJson(file, doc);
  return { saved: true, policy: doc.policies[modId] };
}

module.exports = {
  POLICY_VERSION,
  defaultPolicyFile,
  loadVariantPolicies,
  getVariantPolicy,
  resolveVariantPolicy,
  rememberVariantPolicy,
};
